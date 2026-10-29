import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectStorageLike, WorkspaceOptions } from '@cloudflare/computer';
import {
  type ContainerLaunchSpec,
  type ContainerRuntimeInfo,
  type ILegacyWorkspaceContainerAPI,
  LegacyContainerBackend,
  LegacyWorkspaceContainerAPI,
  type WorkspaceRef,
} from '@cloudflare/computer/backends/container-legacy';
import { Files, SandboxFileError } from '@cloudflare/sandbox';
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
 * environment as the runtime's own; `RPC_CLIENT_SECRET`, which Computer adds at launch and computerd
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

type WorkspaceRuntimeExports = {
  WorkspaceProxy(options: { props: WorkspaceRef }): Fetcher;
  GitProxy(options: { props: { workspaceId: string } }): Fetcher;
};

/** The runtime binding every workspace container reads; the container never receives a credential. */
type ComputerSandboxEnv = { CLOUDFLARE_ACCOUNT_ID: string };

type ContainerFileListing = {
  success: true;
  files: { type: 'file' | 'directory' | 'symlink' | 'other'; absolutePath: string; size: number }[];
};

/**
 * The narrow adapter between the Durable Object Container API, Computer's container backend, and
 * Sandbox's file operations.
 *
 * The container application is platform-scheduled (`scheduling_policy: "default"`): the platform
 * picks the image and instance size from the application, and this object starts and stops the
 * container through `ctx.container`. Computer's `LegacyContainerBackend` starts it with computerd as
 * the image's entrypoint, authenticates computerd with a per-workspace `RPC_CLIENT_SECRET` it keeps
 * in this object's storage, and syncs the VFS with it. The runtime's own commands run beside
 * computerd through `ctx.container.exec`, and file transfers go through Sandbox's `Files`, which the
 * image's `sandbox-shim` serves. Moving to Computer's `ContainerBackend` needs the `durable_object`
 * scheduling policy, which cannot be undone; ARCHITECTURE.md describes that separate step.
 */
export abstract class ComputerSandboxBase<
  Env extends ComputerSandboxEnv = ComputerSandboxEnv,
> extends DurableObject<Env> {
  readonly containerBackend: LegacyContainerBackend;
  protected readonly containerProcesses: ContainerProcesses;
  protected readonly scheduledCallbacks: ScheduledCallbacks<string>;
  #host: RecordingWorkspaceContainerHost | null = null;
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
    this.containerBackend = new LegacyContainerBackend({
      container: () => this,
      workspace: { binding: 'PROJECT_WORKSPACE', id: ctx.id.toString() },
      // The model's commands install packages and fetch from the public internet.
      egress: { mode: 'direct' },
      containerPort: 8080,
      containerEnv: COMPUTERD_ENV,
      connectTimeoutMs: CONTAINER_CONNECT_TIMEOUT_MS,
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

  getWorkspaceContainer(): ILegacyWorkspaceContainerAPI {
    this.#host ??= new RecordingWorkspaceContainerHost(
      new LegacyWorkspaceContainerAPI(this.ctx),
      (info) => this.recordContainerLaunch(info),
      (host, ref) => this.interceptWorkspaceOutbound(host, ref),
      (port) => this.ctx.container!.getTcpPort(port),
    );
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
   * Computer asks for its own host once each time the container starts; git's host is intercepted with it,
   * so git in the container reaches the project's repository only through the GitProxy. That one failing
   * leaves git without its remote, never the workspace without its container.
   */
  async interceptWorkspaceOutbound(host: string, ref: WorkspaceRef): Promise<void> {
    const exports = workspaceRuntimeExports(this.ctx.exports);
    await this.ctx.container!.interceptOutboundHttp(host, exports.WorkspaceProxy({ props: ref }));
    try {
      await this.ctx.container!.interceptOutboundHttp(
        GIT_PROXY_HOST,
        exports.GitProxy({ props: { workspaceId: this.ctx.id.toString() } }),
      );
    } catch (error) {
      console.error('Unable to intercept the workspace git remote', error);
    }
  }

  /** Keep the container through operations no request reaches it during. */
  async setKeepAlive(keepAlive: boolean): Promise<void> {
    this.#keepAlive = keepAlive;
    await this.applyInactivityTimeout();
  }

  /** Stop the container. Its own disk goes with it; the durable VFS is untouched. */
  async destroy(): Promise<void> {
    if (this.ctx.container?.running) {
      await this.ctx.container.destroy();
    }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await (await this.files()).mkdir(path, { recursive: options.recursive ?? false });
  }

  /** Write a container file; `base64` content is decoded first, any other encoding is text. */
  async writeFile(
    path: string,
    content: string,
    options: { encoding?: 'utf8' | 'utf-8' | 'base64' } = {},
  ): Promise<{ success: true }> {
    const bytes = options.encoding === 'base64' ? decodeBase64(content) : new TextEncoder().encode(content);
    await (await this.files()).writeFile(path, bytes);
    return { success: true };
  }

  /** Stream a container file, with the size it had when it was opened. */
  async readFile(
    path: string,
    _options: { encoding: 'none' },
  ): Promise<{ success: true; content: ReadableStream<Uint8Array>; size: number }> {
    const files = await this.files();
    const stat = await files.stat(path);
    if (stat.type !== 'file') {
      throw new Error(`Container path is not a file: ${path}`);
    }
    const response = await files.readFile(path);
    if (!response.body) {
      throw new Error(`Container file returned no body: ${path}`);
    }
    return { success: true, content: response.body, size: Number(stat.size) };
  }

  async exists(path: string): Promise<{ exists: boolean }> {
    try {
      await (await this.files()).stat(path);
      return { exists: true };
    } catch (error) {
      if (SandboxFileError.is(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return { exists: false };
      }
      throw error;
    }
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

  private async files(): Promise<Files> {
    return new Files(await this.runningContainer());
  }

  /**
   * Each launch or adoption: the runtime is recorded, the toolchain bootstrap (git wrapper and hooks,
   * the credential-free `cf` launcher) is run in it, and the idle window is set. The bootstrap runs on
   * the platform's exec, beside computerd, before Computer connects.
   */
  private async recordContainerLaunch(info: ContainerRuntimeInfo): Promise<void> {
    if (info.runtimeId !== this.#runtimeId) {
      this.ctx.storage.sql.exec(
        `INSERT INTO cloudchef_container_runtime (singleton, runtime_id, launched_at) VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET runtime_id = excluded.runtime_id, launched_at = excluded.launched_at`,
        info.runtimeId,
        Date.now(),
      );
      this.#runtimeId = info.runtimeId;
    }
    await this.applyInactivityTimeout();
    const container = this.ctx.container!;
    await runIdempotentBootstrapStage({
      stage: 'toolchain (git, cf)',
      budgetMs: CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS,
      attempt: async (remainingMs) => {
        await runTrackedSandboxCommand({
          // The connected account `cf --dry-run` output names. The container never receives a credential.
          command: sandboxShellCommand(containerToolchainBootstrapCommand(this.env.CLOUDFLARE_ACCOUNT_ID)),
          timeout: remainingMs,
          exec: (argv, options) =>
            new ContainerProcesses(
              async () => container,
              () => this.#runtimeId,
            ).exec(argv, { ...options, env: CONTAINER_COMMAND_ENV }),
        });
      },
    });
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
  if (!('WorkspaceProxy' in exports) || !('GitProxy' in exports)) {
    throw new Error('The workspace runtime is missing its WorkspaceProxy or GitProxy export.');
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
  };
}

/**
 * Computer's container host, recording each runtime it launches or adopts. The client secret in
 * the launch result is handed to the backend and nowhere else: never stored here, never logged.
 */
class RecordingWorkspaceContainerHost implements ILegacyWorkspaceContainerAPI {
  constructor(
    private readonly inner: LegacyWorkspaceContainerAPI,
    private readonly onLaunch: (info: ContainerRuntimeInfo) => Promise<void>,
    private readonly intercept: (host: string, workspace: WorkspaceRef) => Promise<void>,
    private readonly tcpPort: (port: number) => Fetcher,
  ) {}

  async start(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const info = await this.inner.start(spec);
    await this.onLaunch(info);
    return info;
  }

  async restart(spec: ContainerLaunchSpec): Promise<ContainerRuntimeInfo> {
    const info = await this.inner.restart(spec);
    await this.onLaunch(info);
    return info;
  }

  setInactivityTimeout(durationMs: number): Promise<void> {
    return this.inner.setInactivityTimeout(durationMs);
  }

  status() {
    return this.inner.status();
  }

  exitInfo() {
    return this.inner.exitInfo();
  }

  interceptAllOutboundHttp(_workspace: WorkspaceRef, _token: string): Promise<void> {
    // Only reached under `egress: http-gateway`, which this workspace does not configure. Fail
    // closed rather than silently leaving the container's outbound traffic un-proxied.
    return Promise.reject(new Error('Full outbound HTTP interception is not configured for this workspace runtime.'));
  }

  interceptOutboundHttp(host: string, workspace: WorkspaceRef): Promise<void> {
    return this.intercept(host, workspace);
  }

  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.inner.fetchPort(port, input, init);
  }

  port(port: number): Fetcher {
    return this.tcpPort(port);
  }
}

export function sandboxShellCommand(command: string): SandboxCommand {
  return ['/bin/bash', '-lc', command];
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
