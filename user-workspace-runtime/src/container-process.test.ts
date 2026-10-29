import { describe, expect, it, vi } from 'vitest';
import { ContainerProcesses, containerProcessId, deadlineCommand } from './container-process';
import { runTrackedSandboxCommand, terminateTrackedSandboxProcess } from './tracked-command';

type ExecCall = { argv: string[]; options: ContainerExecOptions | undefined };

/** One platform process: output to stream, and an exit the test decides. */
function fakeProcess(pid: number, output: { stdout?: string; stderr?: string } = {}) {
  let exit!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    exit = resolve;
  });
  const stream = (text: string | undefined) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text) {
          controller.enqueue(new TextEncoder().encode(text));
        }
        controller.close();
      },
    });
  const process = {
    stdin: null,
    stdout: stream(output.stdout),
    stderr: stream(output.stderr),
    pid,
    isPty: false,
    exitCode,
    output: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
  } satisfies ExecProcess;
  return { process, exit };
}

/** A container whose first exec is the command under test and whose later execs are signals. */
function fakeContainer(command: ReturnType<typeof fakeProcess>, signalExit = 0) {
  const calls: ExecCall[] = [];
  const container = {
    exec: vi.fn(async (argv: string[], options?: ContainerExecOptions) => {
      calls.push({ argv, options });
      if (calls.length === 1) {
        return command.process;
      }
      const signal = fakeProcess(900 + calls.length);
      signal.exit(signalExit);
      return signal.process;
    }),
  };
  return { container, calls };
}

describe('container processes on the Container API', () => {
  it('runs a command under its in-container deadline, as a process group leader', async () => {
    const command = fakeProcess(41, { stdout: 'ok\n' });
    const { container, calls } = fakeContainer(command);
    const processes = new ContainerProcesses(
      async () => container,
      () => 'runtime-1',
    );

    const process = await processes.exec(['sh', '-lc', 'pnpm run build'], {
      timeout: 90_500,
      env: { CI: 'true' },
    });
    command.exit(0);

    expect(process.id).toBe(containerProcessId(41, 'runtime-1'));
    expect(calls[0]?.argv).toEqual([
      'timeout',
      '--signal=TERM',
      '--kill-after=10s',
      '91s',
      'sh',
      '-lc',
      'pnpm run build',
    ]);
    expect(calls[0]?.options).toMatchObject({ env: { CI: 'true' }, stdout: 'pipe', stderr: 'pipe' });
    await expect(process.output({ encoding: 'utf8', maxBytes: 100, timeout: 1_000 })).resolves.toEqual({
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
    await expect(process.status()).resolves.toMatchObject({ state: 'exited', exit: { code: 0, timedOut: false } });
  });

  it('reports a fired deadline as a timeout, which tracked commands surface as one', async () => {
    const command = fakeProcess(42, { stderr: 'still building' });
    const { container } = fakeContainer(command);
    const processes = new ContainerProcesses(
      async () => container,
      () => 'runtime-1',
    );

    const run = runTrackedSandboxCommand({
      command: ['sh', '-lc', 'sleep 999'],
      timeout: 1_000,
      exec: (argv, options) => processes.exec(argv, options),
    });
    command.exit(124);

    await expect(run).rejects.toThrow(/timed out after 1000ms[\s\S]*still building/);
  });

  it('keeps one combined head budget of the output, stdout first', async () => {
    const command = fakeProcess(43, { stdout: 'a'.repeat(30), stderr: 'b'.repeat(30) });
    const { container } = fakeContainer(command);
    const process = await new ContainerProcesses(
      async () => container,
      () => 'r',
    ).exec(['true'], { timeout: 1_000 });
    command.exit(1);

    await expect(process.output({ encoding: 'utf8', maxBytes: 40, timeout: 1_000 })).resolves.toEqual({
      stdout: 'a'.repeat(30),
      stderr: 'b'.repeat(10),
      exitCode: 1,
      timedOut: false,
      truncated: true,
    });
  });

  it('stops the whole process group, asking first, so traps can reap their jobs', async () => {
    const command = fakeProcess(44);
    const { container, calls } = fakeContainer(command);
    const process = await new ContainerProcesses(
      async () => container,
      () => 'r',
    ).exec(['sleep', '60'], {
      timeout: 60_000,
    });

    const termination = terminateTrackedSandboxProcess(process);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    command.exit(143);
    await termination;

    expect(calls[1]?.argv).toEqual(['sh', '-c', 'kill -s "$1" -- "-$2" 2>/dev/null', 'sh', '15', '44']);
    // A requested kill is not a timeout, even when the group ends on SIGKILL's status.
    await expect(process.status()).resolves.toMatchObject({ state: 'exited', exit: { timedOut: false } });
  });

  it('finds a leftover process again after a restart only in the container that ran it', async () => {
    const running = fakeContainer(fakeProcess(0), 0);
    // The first exec of `fakeContainer` is the command under test; here every exec is a probe.
    running.container.exec.mockImplementation(async (argv: string[], options?: ContainerExecOptions) => {
      running.calls.push({ argv, options });
      const probe = fakeProcess(950);
      probe.exit(0);
      return probe.process;
    });
    const processes = new ContainerProcesses(
      async () => running.container,
      () => 'runtime-1',
    );

    await expect(processes.getProcess(containerProcessId(77, 'runtime-2'))).resolves.toBeNull();
    expect(running.calls).toHaveLength(0);

    const found = await processes.getProcess(containerProcessId(77, 'runtime-1'));
    expect(found).not.toBeNull();
    expect(running.calls[0]?.argv).toEqual(['sh', '-c', 'kill -s "$1" -- "-$2" 2>/dev/null', 'sh', '0', '77']);
    await expect(found!.output({ encoding: 'utf8', maxBytes: 10, timeout: 10 })).rejects.toThrow(
      /no observable output/,
    );
  });

  it('builds the deadline argv from whole seconds, never zero', () => {
    expect(deadlineCommand(['true'], 1)).toContain('1s');
    expect(deadlineCommand(['true'], 1_001)).toContain('2s');
  });
});
