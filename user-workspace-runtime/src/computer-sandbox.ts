import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { DurableObjectStorageLike, WorkspaceOptions } from '@cloudflare/computer';
import {
  ContainerBackend,
  type ContainerLaunchSpec,
  type ContainerRuntimeInfo,
  type IWorkspaceContainerAPI,
  type WorkspaceRef,
} from '@cloudflare/computer/backends/container';
import { BaseSnapshotStore, COMPUTERD_ENTRYPOINT, START_COMPUTERD_COMMAND, startBaseContainer } from './base-container';
import { ContainerProcesses } from './container-process';
import {
  CONTAINER_CONNECT_TIMEOUT_MS,
  CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS,
  containerToolchainBootstrapCommand,
  runIdempotentBootstrapStage,
} from './container-toolchain';
import { type ScheduledCallbackPayload, ScheduledCallbacks } from './scheduled-callbacks';
import { first } from './sql-rows';
import { runTrackedSandboxCommand, type SandboxCommand } from './tracked-command';
import { GIT_PROXY_HOST } from '../../app/lib/.server/cloudflare/git-proxy';
import { CLOUDFLARE_API_PROXY_HOST } from '../../app/lib/.server/cloudflare/cloudflare-api-proxy';
import { REEL_PROXY_HOST } from '../../app/lib/reel';
import { PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE } from '../../app/lib/.server/cloudflare/project-workspace-container-policy';
import { base64ToBytes, sha256Hex } from '../../app/lib/hex-digest';

/**
 * How long a container may sit with no request reaching its Durable Object before the platform stops
 * it: the 10 minutes the terminal's tip tells people about.
 */
const WORKSPACE_CONTAINER_IDLE_TIMEOUT_MS = 10 * 60_000;
/**
 * The window while an operation has asked to keep the container: a deployment session holds its
 * validated artifact while the control plane uploads it, with no request to this object meanwhile.
 */
const WORKSPACE_CONTAINER_KEEP_ALIVE_TIMEOUT_MS = 60 * 60_000;

/**
 * Environment every workspace process shares, both computerd's model commands and the runtime's own
 * validation commands. Generated projects depend on the cf CLI, which reports usage unless told not to.
 */
export const CONTAINER_TOOL_ENV = { CF_SEND_TELEMETRY: 'false' } as const;

/**
 * Environment of every command the runtime runs itself (validation, installs, digests). Processes the
 * Container API starts inherit nothing but `PATH`, so this is the whole environment besides it. pnpm
 * must never run its implicit pre-run install through FUSE into durable storage (#137).
 */
export const CONTAINER_COMMAND_ENV = {
  HOME: '/root',
  npm_config_verify_deps_before_run: 'false',
  ...CONTAINER_TOOL_ENV,
} as const;

/** computerd forwards `COMPUTER_VAR_<NAME>` to every command it runs, as `<NAME>`, besides a short allowlist. */
const COMPUTER_COMMAND_VARIABLE_PREFIX = 'COMPUTER_VAR_';

/**
 * computerd's launch environment. computerd passes its commands only `PATH`, `HOME`, `TMPDIR`, `TZ`,
 * `LANG`, `TERM`, `LC_*`, and the prefixed variables, so the model's commands see the same command
 * environment as the runtime's own; `RPC_CLIENT_SECRET`, which the host adds at launch and computerd
 * drops from its own environment once read, never reaches them.
 */
const COMPUTERD_ENV = {
  MOUNT_POINT: '/home',
  FUSE_MOUNT: 'auto',
  // computerd runs commands with /bin/sh unless told otherwise, and Debian's is dash.
  EXEC_SHELL: '/bin/bash',
  ...Object.fromEntries(
    Object.entries(CONTAINER_COMMAND_ENV).map(([name, value]) => [`${COMPUTER_COMMAND_VARIABLE_PREFIX}${name}`, value]),
  ),
};

/** Where this object keeps computerd's per-workspace bearer secret (the key Computer's own hosts use). */
const CLIENT_SECRET_KEY = 'computer:container-client-secret';
/**
 * What the running container was launched with, written only once computerd was told to start, so a container a
 * launch left partway is never adopted.
 */
const LAUNCH_DIGEST_KEY = 'cloudchef:container-launch-digest';

type WorkspaceRuntimeExports = {
  WorkspaceProxy(options: { props: WorkspaceRef }): Fetcher;
  GitProxy(options: { props: { workspaceId: string } }): Fetcher;
  CloudflareApiProxy(options: { props: { workspaceId: string } }): Fetcher;
  ReelProxy(options: { props: { workspaceId: string } }): Fetcher;
};

/**
 * The runtime bindings every workspace container reads: the account `cf` acts on, and the runtime's D1, which keeps
 * the base snapshot. The container never receives a credential.
 */
type ComputerSandboxEnv = { CLOUDFLARE_ACCOUNT_ID: string; DB: D1Database };

type ContainerFileListing = {
  success: true;
  files: { type: 'file' | 'directory' | 'symlink' | 'other'; absolutePath: string; size: number }[];
};

/**
 * The narrow adapter between the Durable Object Container API and Computer's container backend.
 *
 * The container application uses the `durable_object` scheduling policy: this object starts its container itself,
 * from Cloudflare's managed image or the runtime's base snapshot of it (base-container.ts), at the workspace's
 * instance size and with internet access. Computer's `ContainerBackend` dials computerd through the host below,
 * which authenticates it with a per-workspace `RPC_CLIENT_SECRET` kept in this object's storage, and syncs the VFS
 * with it. The runtime's own commands, and its file transfers, run beside computerd through `ctx.container.exec`.
 */
export abstract class ComputerSandboxBase<
  Env extends ComputerSandboxEnv = ComputerSandboxEnv,
> extends DurableObject<Env> {
  readonly containerBackend: ContainerBackend;
  protected readonly containerProcesses: ContainerProcesses;
  protected readonly scheduledCallbacks: ScheduledCallbacks<string>;
  #host: ManagedWorkspaceContainerHost | null = null;
  #runtimeId: string | null;
  #keepAlive = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS cloudchef_container_runtime (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         runtime_id TEXT NOT NULL,
         launched_at INTEGER NOT NULL
       )`,
    );
    this.scheduledCallbacks = new ScheduledCallbacks(ctx.storage, 'cloudchef_scheduled_callbacks');
    this.scheduledCallbacks.initialize();
    this.#runtimeId =
      first(
        ctx.storage.sql.exec<{ runtime_id: string }>(
          'SELECT runtime_id FROM cloudchef_container_runtime WHERE singleton = 1',
        ),
      )?.runtime_id ?? null;
    this.containerBackend = new ContainerBackend({
      container: () => this,
      workspace: { binding: 'PROJECT_WORKSPACE', id: ctx.id.toString() },
      // The model's commands install packages and fetch from the public internet.
      egress: { mode: 'direct' },
      containerPort: 8080,
      containerEnv: COMPUTERD_ENV,
      connectTimeoutMs: CONTAINER_CONNECT_TIMEOUT_MS,
      instance: PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
      id: 'container-shell',
    });
    this.containerProcesses = new ContainerProcesses(
      () => this.runningContainer(),
      () => this.#runtimeId,
    );
    // The inactivity timeout does not survive a Durable Object restart, while the container can.
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => this.applyInactivityTimeout());
    }
  }

  /**
   * Start the workspace container if it is not running and wait until computerd answers. The
   * subclass owns the Computer workspace that drives `containerBackend`.
   */
  protected abstract startWorkspaceContainer(): Promise<void>;

  /** Run the named callback a `schedule` call stored, when its time comes. */
  protected abstract runScheduledCallback(callback: string, payload: ScheduledCallbackPayload): Promise<void>;

  getWorkspaceContainer(): IWorkspaceContainerAPI {
    const container = this.ctx.container;
    if (!container) {
      throw new Error('The workspace Durable Object has no container configured.');
    }
    this.#host ??= new ManagedWorkspaceContainerHost(container, this.ctx.storage, {
      launch: (spec, clientSecret) => this.launchContainer(spec, clientSecret),
      adopted: () => this.#runtimeId,
      intercept: (host, ref) => this.interceptWorkspaceOutbound(host, ref),
    });
    return this.#host;
  }

  /**
   * The container runtime Computer is talking to, as of its latest launch or adoption. A changed id
   * is how a replaced container is recognized; it is the runtime a command's changes belong to.
   */
  currentContainerRuntimeId(): string | null {
    return this.#runtimeId;
  }

  override fetch(_request: Request): Response | Promise<Response> {
    return new Response('not found', { status: 404 });
  }

  override async alarm(): Promise<void> {
    await this.scheduledCallbacks.runDue((callback, payload) => this.runScheduledCallback(callback, payload));
  }

  createComputerWorkspaceOptions(): WorkspaceOptions {
    // SAFETY: Workers' DurableObjectStorage implements Computer's narrower
    // SQL/transaction storage contract; the SDK declarations use separate names.
    const storage = this.ctx.storage as DurableObjectStorageLike;
    // `output: false`: command output is bounded by the runtime's own exec adapter. Computer's
    // default would also save every long output as a file inside the durable VFS.
    return { storage, backends: [this.containerBackend], output: false };
  }

  /**
   * Computer asks for its own host once each time the container starts; the hosts the container reaches
   * CloudChef through are intercepted with it. git reaches the project's repository only through the GitProxy,
   * and `cf` reaches Cloudflare's API only through the CloudflareApiProxy, which holds the account's
   * authorization and asks the person before any change; `cloudchef reel` hands a clip to the agent through the
   * ReelProxy. One of those failing leaves that tool without its
   * service, never the workspace without its container.
   */
  async interceptWorkspaceOutbound(host: string, ref: WorkspaceRef): Promise<void> {
    const exports = workspaceRuntimeExports(this.ctx.exports);
    await this.ctx.container!.interceptOutboundHttp(host, exports.WorkspaceProxy({ props: ref }));
    const props = { props: { workspaceId: this.ctx.id.toString() } };
    for (const [proxyHost, proxy] of [
      [GIT_PROXY_HOST, exports.GitProxy],
      [CLOUDFLARE_API_PROXY_HOST, exports.CloudflareApiProxy],
      [REEL_PROXY_HOST, exports.ReelProxy],
    ] as const) {
      try {
        await this.ctx.container!.interceptOutboundHttp(proxyHost, proxy(props));
      } catch (error) {
        console.error(`Unable to intercept ${proxyHost} for the workspace`, error);
      }
    }
  }

  /** Keep the container through operations no request reaches it during. */
  async setKeepAlive(keepAlive: boolean): Promise<void> {
    this.#keepAlive = keepAlive;
    await this.applyInactivityTimeout();
  }

  /** Stop the container. Its own disk goes with it; the durable VFS is untouched. */
  async destroy(): Promise<void> {
    if (this.#host) {
      await this.#host.destroy();
    } else if (this.ctx.container?.running) {
      await this.ctx.container.destroy();
    }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.containerCommand(options.recursive ? ['mkdir', '-p', '--', path] : ['mkdir', '--', path]);
  }

  /** Write a container file; `base64` content is decoded first, any other encoding is text. */
  async writeFile(
    path: string,
    content: string,
    options: { encoding?: 'utf8' | 'utf-8' | 'base64' } = {},
  ): Promise<{ success: true }> {
    const bytes = options.encoding === 'base64' ? base64ToBytes(content) : new TextEncoder().encode(content);
    // Written beside the file and renamed over it, so a reader never sees half of it.
    await this.containerCommand(
      ['sh', '-c', 'tmp="$1.cloudchef-$$" && cat > "$tmp" && mv -f -- "$tmp" "$1"', 'sh', path],
      new Blob([bytes]).stream(),
    );
    return { success: true };
  }

  /** Stream a container file, with the size it had when it was opened. */
  async readFile(
    path: string,
    _options: { encoding: 'none' },
  ): Promise<{ success: true; content: ReadableStream<Uint8Array>; size: number }> {
    const size = Number(
      await this.containerCommand(['sh', '-c', 'test -f "$1" || exit 3; stat -L -c %s -- "$1"', 'sh', path]),
    );
    if (!Number.isSafeInteger(size)) {
      throw new Error(`Container file size is unreadable: ${path}`);
    }
    const process = await (
      await this.runningContainer()
    ).exec(['cat', '--', path], { stdout: 'pipe', stderr: 'ignore' });
    if (!process.stdout) {
      throw new Error(`Container file returned no body: ${path}`);
    }
    return { success: true, content: process.stdout, size };
  }

  /** Whether anything is at `path`, a dangling symbolic link included. */
  async exists(path: string): Promise<{ exists: boolean }> {
    const process = await (
      await this.runningContainer()
    ).exec(['sh', '-c', 'test -e "$1" || test -L "$1"', 'sh', path], { stdout: 'ignore', stderr: 'ignore' });
    const code = await process.exitCode;
    if (code !== 0 && code !== 1) {
      throw new Error(`The container could not check ${path} (exit ${code}).`);
    }
    return { exists: code === 0 };
  }

  /** Every entry under `root`, recursively, hidden ones included, in one container command. */
  async listFiles(root: string, _options: { recursive: true; includeHidden: true }): Promise<ContainerFileListing> {
    const process = await this.containerProcesses.exec(['find', root, '-mindepth', '1', '-printf', '%y\\t%s\\t%p\\0'], {
      timeout: 60_000,
    });
    const output = await process.output({ encoding: 'utf8', maxBytes: 4 * 1024 * 1024, timeout: 90_000 });
    if (output.exitCode !== 0 || output.truncated) {
      throw new Error(`The container directory ${root} could not be listed.`);
    }
    const files = output.stdout
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const [kind, size, ...path] = line.split('\t');
        return {
          type:
            kind === 'f'
              ? ('file' as const)
              : kind === 'd'
                ? ('directory' as const)
                : kind === 'l'
                  ? ('symlink' as const)
                  : ('other' as const),
          absolutePath: path.join('\t'),
          size: Number(size),
        };
      });
    return { success: true, files };
  }

  /** Run `callback` once, `delaySeconds` from now, replacing any earlier schedule for it. */
  async schedule(delaySeconds: number, callback: string, payload: ScheduledCallbackPayload): Promise<void> {
    await this.scheduledCallbacks.schedule(delaySeconds, callback, payload);
  }

  deleteSchedules(callback: string): void {
    this.scheduledCallbacks.delete(callback);
  }

  /** The running container, started (and computerd connected) first if it is not. */
  protected async runningContainer(): Promise<Container> {
    const container = this.ctx.container;
    if (!container) {
      throw new Error('The workspace Durable Object has no container configured.');
    }
    if (!container.running) {
      await this.startWorkspaceContainer();
    }
    return container;
  }

  /** One short command of the runtime's own, which must succeed; its stdout. */
  private async containerCommand(command: string[], stdin?: ReadableStream<Uint8Array>): Promise<string> {
    const options: ContainerExecOptions = { stdout: 'pipe', stderr: 'pipe' };
    if (stdin) {
      options.stdin = stdin;
    }
    const process = await (await this.runningContainer()).exec(command, options);
    const [code, stdout, stderr] = await Promise.all([
      process.exitCode,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(`${command[0]} failed in the container (exit ${code}): ${stderr.trim().slice(0, 500)}`);
    }
    return stdout;
  }

  /**
   * Each launch: the container comes up on the runtime's base (its snapshot, or the managed image set up), the
   * runtime is recorded, the idle window is set, the toolchain bootstrap (git wrapper and hooks, the
   * credential-free `cf` launcher) runs in it, and only then is computerd told to start, before Computer connects.
   */
  private async launchContainer(spec: ContainerLaunchSpec, clientSecret: string): Promise<string> {
    const container = this.ctx.container!;
    const runtimeId = crypto.randomUUID();
    const started = await startBaseContainer({
      container,
      store: new BaseSnapshotStore(this.env.DB),
      holder: `workspace:${this.ctx.id.toString()}:${runtimeId}`,
      options: {
        entrypoint: COMPUTERD_ENTRYPOINT,
        env: { ...spec.env, RPC_CLIENT_SECRET: clientSecret },
        enableInternet: spec.enableInternet,
        instance: spec.instance ?? PROJECT_WORKSPACE_CONTAINER_INSTANCE_TYPE,
      },
    });
    console.info({
      event: 'workspace_container_launched',
      source: started.source,
      snapshotTaken: started.snapshotTaken,
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO cloudchef_container_runtime (singleton, runtime_id, launched_at) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET runtime_id = excluded.runtime_id, launched_at = excluded.launched_at`,
      runtimeId,
      Date.now(),
    );
    this.#runtimeId = runtimeId;
    await this.applyInactivityTimeout();
    const processes = new ContainerProcesses(
      async () => container,
      () => this.#runtimeId,
    );
    await runIdempotentBootstrapStage({
      stage: 'toolchain (git, cf)',
      budgetMs: CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS,
      attempt: async (remainingMs) => {
        await runTrackedSandboxCommand({
          // The connected account `cf` acts on. The container never receives a credential: its proxy adds it.
          command: sandboxShellCommand(containerToolchainBootstrapCommand(this.env.CLOUDFLARE_ACCOUNT_ID)),
          timeout: remainingMs,
          exec: (argv, options) => processes.exec(argv, { ...options, env: CONTAINER_COMMAND_ENV }),
        });
      },
    });
    const start = await container.exec([...START_COMPUTERD_COMMAND], { stdout: 'ignore', stderr: 'ignore' });
    if ((await start.exitCode) !== 0) {
      throw new Error('The workspace container could not be told to start computerd.');
    }
    return runtimeId;
  }

  private async applyInactivityTimeout(): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }
    await this.ctx.container
      .setInactivityTimeout(
        this.#keepAlive ? WORKSPACE_CONTAINER_KEEP_ALIVE_TIMEOUT_MS : WORKSPACE_CONTAINER_IDLE_TIMEOUT_MS,
      )
      .catch((error) =>
        console.warn('Unable to set the workspace container inactivity timeout', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
}

function workspaceRuntimeExports(exports: Cloudflare.Exports): WorkspaceRuntimeExports {
  if (
    !('WorkspaceProxy' in exports) ||
    !('GitProxy' in exports) ||
    !('CloudflareApiProxy' in exports) ||
    !('ReelProxy' in exports)
  ) {
    throw new Error(
      'The workspace runtime is missing its WorkspaceProxy, GitProxy, CloudflareApiProxy or ReelProxy export.',
    );
  }
  // `ctx.exports.WorkspaceProxy` is the loopback binding for the WorkspaceProxy WorkerEntrypoint,
  // which is callable as `WorkspaceProxy({ props })` to mint a Fetcher but is a native binding, not
  // an `instanceof Function`, so no such check applies to it. A genuinely non-callable export throws
  // at the call site, which the readiness probe surfaces.
  // SAFETY: the platform types loopback exports as `unknown`; this one is the WorkspaceProxy
  // entrypoint binding, whose call signature is exactly WorkspaceRuntimeExports['WorkspaceProxy'].
  return {
    WorkspaceProxy: exports.WorkspaceProxy as WorkspaceRuntimeExports['WorkspaceProxy'],
    GitProxy: exports.GitProxy as WorkspaceRuntimeExports['GitProxy'],
    CloudflareApiProxy: exports.CloudflareApiProxy as WorkspaceRuntimeExports['CloudflareApiProxy'],
    ReelProxy: exports.ReelProxy as WorkspaceRuntimeExports['ReelProxy'],
  };
}

/** The digest of what a container was launched with, besides the secret: a different one is relaunched. */
async function launchDigest(spec: ContainerLaunchSpec): Promise<string> {
  const env = Object.keys(spec.env)
    .sort()
    .map((name) => [name, spec.env[name]]);
  return sha256Hex(JSON.stringify({ env, enableInternet: spec.enableInternet, instance: spec.instance ?? null }));
}

type ContainerExitInfo = { exitedAt: number; reason: string };

/** What the host needs of the Container API. */
type HostContainer = Pick<Container, 'running' | 'destroy' | 'monitor' | 'setInactivityTimeout' | 'getTcpPort'>;
/** What the host needs of this object's storage: two strings it keeps. */
type HostStorage = {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
};

const storedStringSchema = z.string().min(1);

type ManagedHostCallbacks = {
  /** Start a container for `spec` and tell computerd to start; the new runtime's id. */
  launch(spec: ContainerLaunchSpec, clientSecret: string): Promise<string>;
  /** The runtime id of the container already running, as last recorded. */
  adopted(): string | null;
  intercept(host: string, workspace: WorkspaceRef): Promise<void>;
};

/**
 * Computer's container host, for a container this object schedules itself: it starts the container on the
 * runtime's base rather than from an image named in the Worker upload (`ctx.container.images`, which the managed
 * image is not), adopts the one already running when it was launched exactly so, and records how it exits. The
 * client secret is kept in this object's storage and handed to computerd at launch, never logged.
 */
export class ManagedWorkspaceContainerHost implements IWorkspaceContainerAPI {
  readonly #container: HostContainer;
  readonly #storage: HostStorage;
  readonly #callbacks: ManagedHostCallbacks;
  #exit: ContainerExitInfo | null = null;
  #generation = 0;
  #expectedExitGeneration: number | null = null;
  #monitoring = false;

  constructor(container: HostContainer, storage: HostStorage, callbacks: ManagedHostCallbacks) {
    this.#container = container;
    this.#storage = storage;
    this.#callbacks = callbacks;
  }

  async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const clientSecret = await this.#clientSecret();
    const digest = await launchDigest(spec);
    const runtimeId = this.#callbacks.adopted();
    if (
      this.#exit === null &&
      this.#container.running &&
      runtimeId !== null &&
      storedStringSchema.safeParse(await this.#storage.get(LAUNCH_DIGEST_KEY)).data === digest
    ) {
      if (!this.#monitoring) {
        this.#watch();
      }
      return { runtimeId, clientSecret, outcome: 'adopted' };
    }
    const outcome = this.#container.running ? 'relaunched' : 'launched';
    return this.#launch(spec, clientSecret, digest, outcome);
  }

  async restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    return this.#launch(spec, await this.#clientSecret(), await launchDigest(spec), 'launched');
  }

  async setInactivityTimeout(durationMs: number): Promise<void> {
    await this.#container.setInactivityTimeout(durationMs);
  }

  async status(): Promise<{ running: boolean; exit: ContainerExitInfo | null }> {
    return { running: this.#container.running, exit: this.#exit };
  }

  async exitInfo(): Promise<ContainerExitInfo | null> {
    return this.#exit;
  }

  interceptAllOutboundHttp(_workspace: WorkspaceRef, _token: string): Promise<void> {
    // Only reached under `egress: http-gateway`, which this workspace does not configure. Fail
    // closed rather than silently leaving the container's outbound traffic un-proxied.
    return Promise.reject(new Error('Full outbound HTTP interception is not configured for this workspace runtime.'));
  }

  interceptOutboundHttp(host: string, workspace: WorkspaceRef): Promise<void> {
    return this.#callbacks.intercept(host, workspace);
  }

  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.#exit !== null) {
      return Promise.reject(new Error(`container exited: ${this.#exit.reason}`));
    }
    return this.#container.getTcpPort(port).fetch(input, init);
  }

  port(port: number): Fetcher {
    return this.#container.getTcpPort(port);
  }

  /** Stop the container, as an exit this object asked for. */
  async destroy(): Promise<void> {
    await this.#storage.delete(LAUNCH_DIGEST_KEY);
    if (this.#container.running) {
      this.#expectedExitGeneration = this.#generation;
      await this.#container.destroy();
    }
    this.#exit = null;
  }

  async #launch(
    spec: ContainerLaunchSpec,
    clientSecret: string,
    digest: string,
    outcome: ContainerRuntimeInfo['outcome'],
  ): Promise<ContainerRuntimeInfo> {
    await this.destroy().catch(() => undefined);
    try {
      const runtimeId = await this.#callbacks.launch(spec, clientSecret);
      this.#watch();
      await this.#storage.put(LAUNCH_DIGEST_KEY, digest);
      return { runtimeId, clientSecret, outcome };
    } catch (error) {
      // A container a launch left partway never serves: computerd may not have been told to start.
      await this.destroy().catch(() => undefined);
      throw error;
    }
  }

  #watch(): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#exit = null;
    this.#monitoring = true;
    const exited = (reason: string) => {
      if (generation !== this.#generation) {
        return;
      }
      this.#monitoring = false;
      const expected = this.#expectedExitGeneration === generation;
      this.#expectedExitGeneration = null;
      if (!expected) {
        this.#exit = { exitedAt: Date.now(), reason };
        console.warn({ event: 'workspace_container_exited', reason });
      }
    };
    this.#container.monitor().then(
      () => exited('exited normally'),
      (error) => exited(error instanceof Error ? error.message : String(error)),
    );
  }

  async #clientSecret(): Promise<string> {
    const existing = storedStringSchema.safeParse(await this.#storage.get(CLIENT_SECRET_KEY));
    if (existing.success) {
      return existing.data;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    await this.#storage.put(CLIENT_SECRET_KEY, secret);
    return secret;
  }
}

export function sandboxShellCommand(command: string): SandboxCommand {
  return ['/bin/bash', '-lc', command];
}
