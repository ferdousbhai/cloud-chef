import { type DurableObjectStorageLike, type SyncRetryScheduler, type WorkspaceOptions } from '@cloudflare/computer';
import {
  CloudflareContainerBackend,
  type IWorkspaceContainerAPI,
  type WorkspaceRef,
} from '@cloudflare/computer/backends/container';
import { Sandbox, type SandboxCommand } from '@cloudflare/sandbox';
import { createExtensionProcessSandbox } from '@cloudflare/sandbox/extensions';
import {
  COMPUTERD_BINARY,
  COMPUTERD_BOOTSTRAP_TIMEOUT_MS,
  CONTAINER_CONNECT_TIMEOUT_MS,
  CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS,
  computerdBootstrapCommand,
  computerdInstallationStateCommand,
  containerToolchainBootstrapCommand,
  reusableComputerdProcess,
  runIdempotentBootstrapStage,
} from './container-toolchain';
import {
  runTrackedSandboxCommand,
  terminateTrackedSandboxProcess,
  type TrackedSandboxProcess,
} from './tracked-command';
import { first } from './sql-rows';

export const COMPUTERD_PROCESS_ROLE = 'computerd';
const WORKSPACE_CONTAINER_SLEEP_AFTER = '10m';
export const COMPUTERD_ENV = {
  PORT: '8080',
  MOUNT_POINT: '/home',
  FUSE_MOUNT: 'auto',
  // Never let pnpm project dependencies leak through FUSE into durable VFS storage.
  npm_config_verify_deps_before_run: 'false',
} as const;

type WorkspaceRuntimeExports = {
  WorkspaceProxy(options: { props: WorkspaceRef }): Fetcher;
};

/** The narrow adapter between Sandbox lifecycle APIs and Computer's container backend. */
export class ComputerSandboxBase<Env = unknown> extends Sandbox<Env> {
  override sleepAfter = WORKSPACE_CONTAINER_SLEEP_AFTER;
  protected readonly sandboxProcesses = createExtensionProcessSandbox(this);
  readonly containerBackend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: 'PROJECT_WORKSPACE', id: this.ctx.id.toString() },
    containerEnv: COMPUTERD_ENV,
    connectTimeoutMs: CONTAINER_CONNECT_TIMEOUT_MS,
    id: 'container-shell',
  });

  readonly #computerHost = new SandboxComputerHost(this);

  getWorkspaceContainer(): IWorkspaceContainerAPI {
    return this.#computerHost;
  }

  // Returns the computerd process id, which Computer's container backend uses as the runtime
  // identity: a new process id is how it detects that the runtime was replaced and re-connects.
  async startComputerd(env: Record<string, string>): Promise<string> {
    const existing = await this.processForRole(COMPUTERD_PROCESS_ROLE);
    const reusable = await reusableComputerdProcess(existing, async () => {
      const state = await this.runSandboxShellCommand(computerdInstallationStateCommand(), 30_000);
      return state.stdout.trim();
    });
    if (reusable) {
      return reusable.id;
    }
    if (existing) {
      await this.discardComputerdProcess(existing);
    }
    await Promise.all([
      this.runBootstrapStage(
        'toolchain (pnpm)',
        CONTAINER_TOOLCHAIN_BOOTSTRAP_TIMEOUT_MS,
        containerToolchainBootstrapCommand(),
      ),
      this.runBootstrapStage('computerd', COMPUTERD_BOOTSTRAP_TIMEOUT_MS, computerdBootstrapCommand()),
    ]);
    const process = await this.sandboxProcesses.exec([COMPUTERD_BINARY], {
      env: { ...env, FUSE_MOUNT: 'auto' },
    });
    this.setProcessForRole(COMPUTERD_PROCESS_ROLE, process.id);
    return process.id;
  }

  async restartComputerd(env: Record<string, string>): Promise<string> {
    const existing = await this.processForRole(COMPUTERD_PROCESS_ROLE);
    if (existing) {
      await this.discardComputerdProcess(existing);
    } else {
      this.clearProcessForRole(COMPUTERD_PROCESS_ROLE);
      await this.unmountComputerFilesystem();
    }
    return this.startComputerd(env);
  }

  private async discardComputerdProcess(process: TrackedSandboxProcess): Promise<void> {
    await terminateTrackedSandboxProcess(process);
    this.clearProcessForRole(COMPUTERD_PROCESS_ROLE);
    await this.unmountComputerFilesystem();
  }

  private async unmountComputerFilesystem(): Promise<void> {
    await this.runSandboxShellCommand('fusermount3 -uz /home >/dev/null 2>&1 || true', 30_000).catch(() => undefined);
  }

  async computerdStatus(): Promise<{ running: boolean; exit: { exitedAt: number; reason: string } | null }> {
    const process = await this.processForRole(COMPUTERD_PROCESS_ROLE);
    if (!process) {
      return { running: false, exit: null };
    }
    const status = await process.status();
    const running = status.state === 'running';
    return {
      running,
      exit: running
        ? null
        : {
            exitedAt: Date.parse(status.endedAt),
            reason:
              status.state === 'exited'
                ? `computerd exited (${status.exit.code})`
                : `computerd error (${status.error.code})`,
          },
    };
  }

  private runBootstrapStage(stage: string, budgetMs: number, command: string): Promise<void> {
    return runIdempotentBootstrapStage({
      stage,
      budgetMs,
      attempt: async (remainingMs) => {
        await this.runSandboxShellCommand(command, remainingMs);
      },
    });
  }

  private runSandboxShellCommand(command: string, timeout: number) {
    return runTrackedSandboxCommand({
      command: sandboxShellCommand(command),
      timeout,
      exec: (argv, options) => this.sandboxProcesses.exec(argv, options),
    });
  }

  protected async processForRole(role: string) {
    const row = first(
      this.ctx.storage.sql.exec<{ process_id: string }>(
        'SELECT process_id FROM ghostbuild_sandbox_processes WHERE role = ?',
        role,
      ),
    );
    if (!row) {
      return null;
    }
    const process = await this.sandboxProcesses.getProcess(row.process_id).catch(() => null);
    if (!process) {
      this.clearProcessForRole(role);
    }
    return process;
  }

  protected setProcessForRole(role: string, processId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ghostbuild_sandbox_processes (role, process_id) VALUES (?, ?)
       ON CONFLICT(role) DO UPDATE SET process_id = excluded.process_id`,
      role,
      processId,
    );
  }

  protected clearProcessForRole(role: string, processId?: string): void {
    if (processId) {
      this.ctx.storage.sql.exec(
        'DELETE FROM ghostbuild_sandbox_processes WHERE role = ? AND process_id = ?',
        role,
        processId,
      );
      return;
    }
    this.ctx.storage.sql.exec('DELETE FROM ghostbuild_sandbox_processes WHERE role = ?', role);
  }

  interceptWorkspaceOutbound(host: string, ref: WorkspaceRef): Promise<void> {
    const exports = workspaceRuntimeExports(this.ctx.exports);
    return this.ctx.container!.interceptOutboundHttp(host, exports.WorkspaceProxy({ props: ref }));
  }

  fetchComputerPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.ctx.container!.getTcpPort(port).fetch(input, init);
  }

  computerPort(port: number): Fetcher {
    return this.ctx.container!.getTcpPort(port);
  }

  createComputerWorkspaceOptions(retryScheduler: SyncRetryScheduler): WorkspaceOptions {
    // SAFETY: Workers' DurableObjectStorage implements Computer's narrower
    // SQL/transaction storage contract; the SDK declarations use separate names.
    const storage = this.ctx.storage as DurableObjectStorageLike;
    return {
      storage,
      backends: [this.containerBackend],
      retryScheduler,
      retry: { initialDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 5 },
    };
  }
}

function workspaceRuntimeExports(exports: Cloudflare.Exports): WorkspaceRuntimeExports {
  if (!('WorkspaceProxy' in exports)) {
    throw new Error('The workspace runtime is missing its WorkspaceProxy export.');
  }
  // `ctx.exports.WorkspaceProxy` is the loopback binding for the WorkspaceProxy WorkerEntrypoint,
  // which is callable as `WorkspaceProxy({ props })` to mint a Fetcher but is a native binding, not
  // an `instanceof Function`. An earlier guard rejected it on that basis and failed every container
  // exec at the egress-interception stage. Trust the binding; a genuinely non-callable export
  // throws at the call site, which the readiness probe surfaces.
  // SAFETY: the platform types loopback exports as `unknown`; this one is the WorkspaceProxy
  // entrypoint binding, whose call signature is exactly WorkspaceRuntimeExports['WorkspaceProxy'].
  return {
    WorkspaceProxy: exports.WorkspaceProxy as WorkspaceRuntimeExports['WorkspaceProxy'],
  };
}

class SandboxComputerHost implements IWorkspaceContainerAPI {
  constructor(private readonly sandbox: ComputerSandboxBase) {}

  // `enableInternet` is only ever false here: the container backend runs with `egress: none`, so it
  // never asks for direct egress and never calls `interceptAllOutboundHttp`. The sandbox container
  // has whatever egress the platform grants it; there is no per-start network toggle to honor.
  async start(_env: Record<string, string>, _enableInternet: boolean): Promise<{ runtimeId: string }> {
    return { runtimeId: await this.sandbox.startComputerd(_env) };
  }

  async restart(_env: Record<string, string>, _enableInternet: boolean): Promise<{ runtimeId: string }> {
    return { runtimeId: await this.sandbox.restartComputerd(_env) };
  }

  interceptAllOutboundHttp(_workspace: WorkspaceRef, _token: string): Promise<void> {
    // Only reached under `egress: http-gateway`, which this workspace does not configure. Fail
    // closed rather than silently leaving the container's outbound traffic un-proxied.
    throw new Error('Full outbound HTTP interception is not configured for this workspace runtime.');
  }

  interceptOutboundHttp(host: string, workspace: WorkspaceRef): Promise<void> {
    return this.sandbox.interceptWorkspaceOutbound(host, workspace);
  }

  fetchPort(port: number, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.sandbox.fetchComputerPort(port, input, init);
  }

  port(port: number): Fetcher {
    return this.sandbox.computerPort(port);
  }

  status() {
    return this.sandbox.computerdStatus();
  }

  async exitInfo() {
    return (await this.sandbox.computerdStatus()).exit;
  }
}

function sandboxShellCommand(command: string): SandboxCommand {
  return ['sh', '-lc', command];
}

