import { describe, expect, it, vi } from 'vitest';
import {
  SandboxProcessTerminationUnconfirmedError,
  runTrackedSandboxCommand,
  sandboxCommandFailureMessage,
  terminateTrackedSandboxProcess,
} from './tracked-command';

const command = ['/bin/bash', '-lc', 'pnpm run build'] as const;

function runningStatus() {
  return {
    id: 'process-1',
    pid: 123,
    command,
    startedAt: '2026-08-11T00:00:00.000Z',
    state: 'running' as const,
  };
}

function exitedStatus(code = 0) {
  return {
    id: 'process-1',
    pid: 123,
    command,
    startedAt: '2026-08-11T00:00:00.000Z',
    endedAt: '2026-08-11T00:00:01.000Z',
    state: 'exited' as const,
    exit: { code, timedOut: false },
  };
}

function output(overrides: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> = {}) {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

describe('tracked Sandbox commands', () => {
  it('uses argv exec and exposes the exact process before observing output', async () => {
    const events: string[] = [];
    const process = {
      id: 'process-1',
      output: vi.fn(async () => {
        events.push('output');
        return output();
      }),
      waitForExit: vi.fn(async () => ({ code: 0, timedOut: false })),
      kill: vi.fn(async () => undefined),
      status: vi.fn(async () => exitedStatus()),
    };
    const exec = vi.fn(async () => process);

    await runTrackedSandboxCommand({
      command,
      timeout: 30_000,
      exec,
      onProcess: (startedProcess) => {
        expect(startedProcess).toBe(process);
        events.push('attach');
      },
    });

    expect(exec).toHaveBeenCalledWith(command, { timeout: 30_000 });
    expect(events).toEqual(['attach', 'output']);
  });

  it('reports a remote process timeout with bounded output', async () => {
    const process = {
      id: 'process-1',
      output: vi.fn(async () => output({ stderr: 'build timed out', exitCode: 137, timedOut: true })),
      waitForExit: vi.fn(async () => ({ code: 137, timedOut: true })),
      kill: vi.fn(async () => undefined),
      status: vi.fn(async () => exitedStatus(137)),
    };

    await expect(runTrackedSandboxCommand({ command, timeout: 30_000, exec: async () => process })).rejects.toThrow(
      'Sandbox command timed out after 30000ms.\nbuild timed out',
    );
  });

  it('kills a process when local output observation fails', async () => {
    const events: string[] = [];
    const process = {
      id: 'process-1',
      output: vi.fn(async () => {
        events.push('output');
        throw new Error('RPC unavailable');
      }),
      kill: vi.fn(async () => {
        events.push('kill');
      }),
      waitForExit: vi.fn(async () => {
        events.push('wait');
        throw new Error('RPC unavailable');
      }),
      status: vi.fn(async () => {
        events.push('status');
        return exitedStatus(137);
      }),
    };

    await expect(runTrackedSandboxCommand({ command, timeout: 30_000, exec: async () => process })).rejects.toThrow(
      'Sandbox command could not be observed for 30000ms and was terminated.',
    );
    expect(events).toEqual(['output', 'kill', 'wait', 'kill', 'wait', 'status']);
    expect(process.kill).toHaveBeenCalledWith(15);
  });

  it('escalates to an untrappable kill when the command ignores the request to stop', async () => {
    let exits = 0;
    const process = {
      id: 'process-1',
      output: vi.fn(async () => output({})),
      kill: vi.fn(async (_signal?: number) => undefined),
      // Refuse the graceful stop once, then exit under SIGKILL.
      waitForExit: vi.fn(async () => {
        exits += 1;
        if (exits === 1) {
          throw new Error('still running');
        }
        return { code: 137, timedOut: false };
      }),
      status: vi.fn(async () => exitedStatus(137)),
    };

    await terminateTrackedSandboxProcess(process);

    expect(process.kill.mock.calls.map((call) => call[0])).toEqual([15, 9]);
    expect(process.waitForExit).toHaveBeenLastCalledWith({ timeout: 10_000 });
  });

  it('kills a process when the output observer never settles', async () => {
    vi.useFakeTimers();
    try {
      const process = {
        id: 'process-1',
        output: vi.fn(() => new Promise<ReturnType<typeof output>>(() => undefined)),
        kill: vi.fn(async (_signal?: number) => undefined),
        waitForExit: vi.fn(async () => ({ code: 137, timedOut: false })),
        status: vi.fn(async () => exitedStatus(137)),
      };

      const completion = runTrackedSandboxCommand({ command, timeout: 30_000, exec: async () => process });
      const expectation = expect(completion).rejects.toThrow(
        'Sandbox command timed out after 30000ms and was terminated.',
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await expectation;
      // The command stops when asked, so escalation never happens — which is the point: SIGKILL
      // cannot be trapped, and a command that traps SIGTERM is how background stages get reaped.
      expect(process.kill.mock.calls.map((call) => call[0])).toEqual([15]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when termination cannot be confirmed', async () => {
    const process = {
      id: 'process-1',
      output: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
      kill: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
      waitForExit: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
      status: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
    };

    await expect(
      runTrackedSandboxCommand({ command, timeout: 30_000, exec: async () => process }),
    ).rejects.toBeInstanceOf(SandboxProcessTerminationUnconfirmedError);
  });

  it('does not treat an unconfirmed running process as terminated', async () => {
    const process = {
      id: 'process-1',
      output: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
      kill: vi.fn(async () => undefined),
      waitForExit: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
      status: vi.fn(async () => runningStatus()),
    };

    await expect(
      runTrackedSandboxCommand({ command, timeout: 30_000, exec: async () => process }),
    ).rejects.toBeInstanceOf(SandboxProcessTerminationUnconfirmedError);
  });

  it('reports retained output for a fast command failure', async () => {
    const process = {
      id: 'process-1',
      output: vi.fn(async () => output({ stdout: 'build output', stderr: 'compiler failed', exitCode: 1 })),
      waitForExit: vi.fn(async () => ({ code: 1, timedOut: false })),
      kill: vi.fn(async () => undefined),
      status: vi.fn(async () => exitedStatus(1)),
    };

    await expect(runTrackedSandboxCommand({ command, timeout: 30_000, exec: async () => process })).rejects.toThrow(
      'Sandbox command failed with exit code 1.\ncompiler failed\nbuild output',
    );
  });

  it('bounds persisted command output while retaining the failure summary', () => {
    const message = sandboxCommandFailureMessage(
      { stdout: 'x'.repeat(10_000), stderr: 'failure details' },
      'Sandbox command failed with exit code 1.',
    );

    expect(message).toHaveLength(4_000);
    expect(message).toMatch(/^Sandbox command failed with exit code 1\.\n/);
    expect(message).toContain('failure details');
    expect(message.endsWith('x'.repeat(100))).toBe(true);
  });

  it('reserves diagnostic space for both full stderr and stdout streams', () => {
    const message = sandboxCommandFailureMessage(
      { stdout: 'o'.repeat(10_000), stderr: 'e'.repeat(10_000) },
      'Sandbox command failed.',
    );

    expect(message).toHaveLength(4_000);
    expect(message).toContain(`\n${'o'.repeat(100)}`);
    expect(message).toContain('e'.repeat(100));
  });
});
