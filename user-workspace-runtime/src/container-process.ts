import type {
  ExecOptions,
  ProcessExit,
  ProcessOutput,
  ProcessStatus,
  SandboxCommand,
  TrackedSandboxProcess,
} from './tracked-command';

/**
 * Container processes on the Durable Object Container API (`ctx.container.exec`).
 *
 * Sandbox 0.x supervised processes for us: a remote lifetime deadline, a process-group kill, and a
 * process id that outlived the Durable Object. Sandbox 1.0 leaves process execution to the platform,
 * whose `exec` gives a pid, two streams, and an exit code, and nothing else. This module puts back
 * exactly what the runtime's validation and cleanup paths rely on:
 *
 * - the deadline runs in the container, under GNU `timeout`, so a hung build is ended even when no
 *   Durable Object is watching it; `timeout` exits 124 when it fired, which is reported as `timedOut`;
 * - `timeout` leads its own process group, so a kill reaches everything the command started, and
 *   the parallel validation stages' `trap ... TERM` still gets to reap its background jobs;
 * - output is drained as it arrives, so a chatty build never blocks on a full pipe, and only a
 *   bounded head of it is kept in Durable Object memory;
 * - a process id names the container runtime that ran it, so after a Durable Object restart a
 *   leftover command in the same container can still be found and stopped, and one from a replaced
 *   container is known to be gone.
 *
 * Processes started this way never inherit the container's start environment (the platform passes
 * them only `PATH`), so computerd's RPC secret is never visible to them.
 */

type ContainerExec = Pick<Container, 'exec'>;

/** GNU `timeout`'s exit status when the deadline fired and the command ended on its signal. */
const DEADLINE_EXIT_CODE = 124;
/** `timeout`'s exit status when the command ignored the signal and had to be killed. */
const DEADLINE_KILLED_EXIT_CODE = 137;
/** How long a command gets to stop after its deadline's SIGTERM before SIGKILL. */
const DEADLINE_KILL_AFTER_SECONDS = 10;
/** Bytes of each stream held in memory; output() then applies its own combined budget. */
const RETAINED_STREAM_BYTES = 256 * 1024;
const DETACHED_EXIT_POLL_MS = 500;

class ContainerProcessTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} did not finish within ${timeoutMs}ms.`);
    this.name = 'ContainerProcessTimeoutError';
  }
}

/** `<pid>@<runtime>`: a pid means nothing in a container other than the one that assigned it. */
export function containerProcessId(pid: number, runtimeId: string | null): string {
  return `${pid}@${runtimeId ?? 'unknown'}`;
}

function parseContainerProcessId(id: string): { pid: number; runtimeId: string } | null {
  const match = /^(\d+)@(.+)$/.exec(id);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 1 ? { pid, runtimeId: match[2]! } : null;
}

/** The argv that runs a command under its in-container deadline, as the leader of a process group. */
export function deadlineCommand(command: SandboxCommand, timeoutMs: number): string[] {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  return ['timeout', '--signal=TERM', `--kill-after=${DEADLINE_KILL_AFTER_SECONDS}s`, `${seconds}s`, ...command];
}

/** Signal a whole process group. `kill -0` probes it without signalling. */
function groupSignalCommand(pid: number, signal: number): string[] {
  return ['sh', '-c', 'kill -s "$1" -- "-$2" 2>/dev/null', 'sh', signal === 0 ? '0' : String(signal), String(pid)];
}

async function signalGroup(container: ContainerExec, pid: number, signal: number): Promise<boolean> {
  const process = await container.exec(groupSignalCommand(pid, signal), { stdout: 'ignore', stderr: 'ignore' });
  return (await process.exitCode) === 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ContainerProcessTimeoutError(operation, timeoutMs)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class RetainedStream {
  readonly #chunks: Uint8Array[] = [];
  #retained = 0;
  #total = 0;
  readonly done: Promise<void>;

  constructor(stream: ReadableStream | null) {
    this.done = stream ? this.#drain(stream) : Promise.resolve();
  }

  get totalBytes(): number {
    return this.#total;
  }

  /** The first `maxBytes` of what was kept. */
  head(maxBytes: number): Uint8Array {
    const length = Math.min(maxBytes, this.#retained);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      if (offset >= length) {
        break;
      }
      const part = chunk.subarray(0, length - offset);
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  async #drain(stream: ReadableStream): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        if (!(value instanceof Uint8Array)) {
          continue;
        }
        this.#total += value.byteLength;
        const room = RETAINED_STREAM_BYTES - this.#retained;
        if (room > 0) {
          const kept = value.byteLength > room ? value.slice(0, room) : value;
          this.#chunks.push(kept);
          this.#retained += kept.byteLength;
        }
      }
    } catch {
      // A broken stream ends what can be observed; the exit code still decides the outcome.
    } finally {
      reader.releaseLock();
    }
  }
}

/** A process this Durable Object started and still holds the platform handle for. */
class LiveContainerProcess implements TrackedSandboxProcess {
  readonly #container: ContainerExec;
  readonly #process: ExecProcess;
  readonly #command: SandboxCommand;
  readonly #startedAt = new Date().toISOString();
  readonly #stdout: RetainedStream;
  readonly #stderr: RetainedStream;
  readonly #exit: Promise<ProcessExit>;
  #killRequested = false;
  #settled: { exit: ProcessExit; endedAt: string } | { error: string; endedAt: string } | null = null;

  constructor(
    readonly id: string,
    container: ContainerExec,
    process: ExecProcess,
    command: SandboxCommand,
  ) {
    this.#container = container;
    this.#process = process;
    this.#command = command;
    this.#stdout = new RetainedStream(process.stdout);
    this.#stderr = new RetainedStream(process.stderr);
    this.#exit = process.exitCode.then(
      (code) => {
        const exit: ProcessExit = {
          code,
          timedOut: code === DEADLINE_EXIT_CODE || (code === DEADLINE_KILLED_EXIT_CODE && !this.#killRequested),
        };
        this.#settled = { exit, endedAt: new Date().toISOString() };
        return exit;
      },
      (error) => {
        this.#settled = {
          error: error instanceof Error ? error.message : String(error),
          endedAt: new Date().toISOString(),
        };
        throw error;
      },
    );
    this.settled = this.#exit.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Resolves once the process has exited or its exit could no longer be observed. */
  readonly settled: Promise<void>;

  async output(options: { encoding: 'utf8'; maxBytes: number; timeout: number }): Promise<ProcessOutput<string>> {
    const exit = await withTimeout(
      Promise.all([this.#exit, this.#stdout.done, this.#stderr.done]).then(([value]) => value),
      options.timeout,
      'Container process output',
    );
    // One combined budget that keeps the head, stdout first: the contract validation-stages.ts
    // sizes its per-stage log tails against.
    const stdout = this.#stdout.head(options.maxBytes);
    const stderr = this.#stderr.head(Math.max(0, options.maxBytes - stdout.byteLength));
    const decoder = new TextDecoder();
    return {
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
      exitCode: exit.code,
      timedOut: exit.timedOut,
      truncated: this.#stdout.totalBytes + this.#stderr.totalBytes > stdout.byteLength + stderr.byteLength,
    };
  }

  waitForExit(options: { timeout: number }): Promise<ProcessExit> {
    return withTimeout(this.#exit, options.timeout, 'Container process exit');
  }

  async kill(signal = 15): Promise<void> {
    this.#killRequested = true;
    if (this.#settled) {
      return;
    }
    if (!(await signalGroup(this.#container, this.#process.pid, signal).catch(() => false))) {
      // The group is gone or could not be signalled; the platform handle is the last resort.
      this.#process.kill(signal);
    }
  }

  async status(): Promise<ProcessStatus> {
    const base = { id: this.id, pid: this.#process.pid, command: this.#command, startedAt: this.#startedAt };
    const settled = this.#settled;
    if (!settled) {
      return { ...base, state: 'running' };
    }
    return 'exit' in settled
      ? { ...base, state: 'exited', exit: settled.exit, endedAt: settled.endedAt }
      : { ...base, state: 'error', error: { code: 'EXEC_FAILED', message: settled.error }, endedAt: settled.endedAt };
  }
}

/**
 * A process found again after the Durable Object that started it restarted. Its handle and output
 * are gone with that instance, so it can only be probed and stopped, which is all cleanup needs.
 */
class DetachedContainerProcess implements TrackedSandboxProcess {
  readonly #startedAt = new Date(0).toISOString();

  constructor(
    readonly id: string,
    private readonly container: ContainerExec,
    private readonly pid: number,
  ) {}

  output(_options: { encoding: 'utf8'; maxBytes: number; timeout: number }): Promise<ProcessOutput<string>> {
    return Promise.reject(
      new Error('A process started by an earlier Durable Object instance has no observable output.'),
    );
  }

  async waitForExit(options: { timeout: number }): Promise<ProcessExit> {
    const deadline = Date.now() + options.timeout;
    while (Date.now() < deadline) {
      if (!(await this.running())) {
        return { code: -1, timedOut: false };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(DETACHED_EXIT_POLL_MS, deadline - Date.now())));
    }
    throw new ContainerProcessTimeoutError('Container process exit', options.timeout);
  }

  async kill(signal = 15): Promise<void> {
    await signalGroup(this.container, this.pid, signal);
  }

  async status(): Promise<ProcessStatus> {
    const base = { id: this.id, pid: this.pid, command: ['unknown'] as const, startedAt: this.#startedAt };
    return (await this.running())
      ? { ...base, state: 'running' }
      : { ...base, state: 'exited', exit: { code: -1, timedOut: false }, endedAt: new Date().toISOString() };
  }

  private running(): Promise<boolean> {
    return signalGroup(this.container, this.pid, 0);
  }
}

export class ContainerProcesses {
  readonly #live = new Map<string, LiveContainerProcess>();

  constructor(
    /** The running container, started first if it is not. */
    private readonly container: () => Promise<ContainerExec>,
    /** The identity of the container runtime the container currently is. */
    private readonly runtimeId: () => string | null,
  ) {}

  async exec(command: SandboxCommand, options: ExecOptions): Promise<TrackedSandboxProcess> {
    const container = await this.container();
    const execOptions: ContainerExecOptions = { stdout: 'pipe', stderr: 'pipe' };
    if (options.env) {
      execOptions.env = options.env;
    }
    const process = await container.exec(deadlineCommand(command, options.timeout), execOptions);
    const id = containerProcessId(process.pid, this.runtimeId());
    const live = new LiveContainerProcess(id, container, process, command);
    this.#live.set(id, live);
    void live.settled.finally(() => this.#live.delete(id));
    return live;
  }

  /** The process with this id, or null when it is gone, including with a replaced container. */
  async getProcess(id: string): Promise<TrackedSandboxProcess | null> {
    const live = this.#live.get(id);
    if (live) {
      return live;
    }
    const parsed = parseContainerProcessId(id);
    if (!parsed || parsed.runtimeId !== this.runtimeId()) {
      return null;
    }
    const container = await this.container().catch(() => null);
    if (!container) {
      return null;
    }
    const detached = new DetachedContainerProcess(id, container, parsed.pid);
    return (await detached.status()).state === 'running' ? detached : null;
  }
}

/**
 * Wait until a container just started accepts a command. `start()` returns before the container is up, and an exec
 * sent to one still starting fails rather than waits.
 */
export async function waitForContainerExec(container: ContainerExec, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const process = await container.exec(['true'], { stdout: 'ignore', stderr: 'ignore' });
      if ((await process.exitCode) === 0) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `The container did not accept a command within ${Math.round(timeoutMs / 1_000)}s` +
      (lastError ? `: ${lastError.message}` : '.'),
  );
}
