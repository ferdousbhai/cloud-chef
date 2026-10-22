import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolOperationJournal } from './tool-operation-journal';
import { requireWorkspaceSyncBarrier, WorkspaceSyncPendingError } from './workspace-sync-retry';

describe('ToolOperationJournal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays the exact completed result without executing the operation again', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();

    expect(journal.begin(invocation())).toEqual({ status: 'execute' });
    expect(journal.complete({ toolCallId: 'call-1', result: { path: '/home/project/a.ts', bytes: 12 } })).toEqual({
      path: '/home/project/a.ts',
      bytes: 12,
    });
    expect(journal.begin(invocation())).toEqual({
      status: 'completed',
      result: { path: '/home/project/a.ts', bytes: 12 },
    });
  });

  it.each(['write', 'edit', 'exec'])(
    'fails closed instead of repeating an interrupted %s operation from real journal state',
    (toolName) => {
      const journal = journalOn(new TestStorage());
      const input = { ...invocation(), toolName };
      journal.initialize();

      expect(journal.begin(input)).toEqual({ status: 'execute' });
      expect(journal.begin(input)).toEqual({
        status: 'indeterminate',
        error: 'The workspace tool operation was interrupted after it started and will not be repeated automatically.',
      });
    },
  );

  it.each(['write', 'edit', 'exec'])(
    'names the interrupted %s so a re-attachable execution can still be looked for',
    (toolName) => {
      const journal = journalOn(new TestStorage());
      const input = { ...invocation(), toolName };
      journal.initialize();
      journal.begin(input);

      expect(journal.interrupted(input.toolCallId)).toEqual({ toolName });

      journal.complete({ toolCallId: input.toolCallId, result: { ok: true } });
      expect(journal.interrupted(input.toolCallId)).toBeNull();
    },
  );

  it('does not offer a cancelled operation for re-attachment', () => {
    const journal = journalOn(new TestStorage());
    const input = { ...invocation(), toolName: 'exec' };
    journal.initialize();
    journal.begin(input);
    journal.cancel({ toolCallId: input.toolCallId, error: 'exec cancelled', active: true });

    expect(journal.isRunning(input.toolCallId)).toBe(true);
    expect(journal.interrupted(input.toolCallId)).toBeNull();
  });

  it.each(['write', 'edit', 'exec'])(
    'durably cancels a settled %s and rejects a delayed side-effect entry',
    (toolName) => {
      const journal = journalOn(new TestStorage());
      const input = { ...invocation(), toolName };
      journal.initialize();

      expect(journal.begin(input)).toEqual({ status: 'execute' });
      expect(journal.cancel({ toolCallId: input.toolCallId, error: `${toolName} cancelled`, active: false })).toEqual({
        status: 'settled',
      });
      expect(journal.begin(input)).toEqual({ status: 'failed', error: `${toolName} cancelled` });
      expect(() => journal.assertRunning(input.toolCallId)).toThrow(`${toolName} cancelled`);
    },
  );

  it('persists cancellation before operation start and rejects the delayed side effect', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();

    expect(journal.cancel({ toolCallId: 'call-1', error: 'cancelled before begin', active: false })).toEqual({
      status: 'settled',
    });
    expect(journal.begin(invocation())).toEqual({ status: 'failed', error: 'cancelled before begin' });
  });

  it('persists active cancellation and rejects delayed mutation and commit boundaries after restart', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();
    expect(journal.begin(invocation())).toEqual({ status: 'execute' });

    expect(journal.cancel({ toolCallId: 'call-1', error: 'cancelled', active: true })).toEqual({
      status: 'active',
    });

    const restarted = journalOn(storage);
    expect(() => restarted.assertRunning('call-1')).toThrow('cancelled');
    expect(() => restarted.complete({ toolCallId: 'call-1', result: { mutated: true } })).toThrow('cancelled');
    expect(restarted.begin(invocation())).toEqual({ status: 'indeterminate', error: 'cancelled' });
    restarted.registerPending({ backend: 'container-shell', toolCallId: 'call-1', result: { exitCode: 0 } });
    expect(restarted.pending()).toEqual([
      { backend: 'container-shell', toolCallId: 'call-1', result: { exitCode: 0 } },
    ]);
    expect(restarted.completePending('container-shell')).toBe(true);
    expect(restarted.begin(invocation())).toEqual({ status: 'completed', result: { exitCode: 0 } });
    expect(restarted.cancel({ toolCallId: 'call-1', error: 'replacement', active: false })).toEqual({
      status: 'settled',
    });
    expect(restarted.begin(invocation())).toEqual({ status: 'completed', result: { exitCode: 0 } });
  });

  it('keeps a completed mutation authoritative when cancellation arrives after commit', () => {
    const journal = journalOn(new TestStorage());
    journal.initialize();
    journal.begin(invocation());
    const result = { committed: true };

    journal.complete({ toolCallId: 'call-1', result });
    expect(journal.cancel({ toolCallId: 'call-1', error: 'cancelled', active: false })).toEqual({
      status: 'settled',
    });
    expect(journal.begin(invocation())).toEqual({ status: 'completed', result });
  });

  it('terminalizes an active cancellation once observation confirms no mutation completed', () => {
    const journal = journalOn(new TestStorage());
    journal.initialize();
    journal.begin(invocation());

    journal.cancel({ toolCallId: 'call-1', error: 'cancelled', active: true });
    expect(journal.begin(invocation())).toEqual({ status: 'indeterminate', error: 'cancelled' });

    expect(journal.cancel({ toolCallId: 'call-1', error: 'replacement', active: false })).toEqual({
      status: 'settled',
    });
    expect(journal.begin(invocation())).toEqual({ status: 'failed', error: 'cancelled' });
  });

  it('retains only a bounded number of cancellation tombstones', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();

    for (let index = 0; index <= 500; index += 1) {
      vi.setSystemTime(index);
      journal.cancel({ toolCallId: `cancel-${index}`, error: 'cancelled', active: false });
    }

    expect(storage.cancellations.size).toBe(500);
    expect(storage.cancellations.has('cancel-0')).toBe(false);
    expect(storage.cancellations.has('cancel-500')).toBe(true);
  });

  it('bounds ordinary completed operation rows without requiring another begin', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();

    for (let index = 0; index <= 500; index += 1) {
      const toolCallId = `completed-${index}`;
      vi.setSystemTime(index);
      journal.begin({ toolCallId, toolName: 'exec', argsSha256: `sha-${index}` });
      journal.complete({ toolCallId, result: { index } });
    }

    expect(storage.rows.size).toBe(500);
    expect(storage.rows.has('completed-0')).toBe(false);
    expect(storage.rows.has('completed-500')).toBe(true);
  });

  it('bounds failed rows created when delayed begins consume cancellation tombstones', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();

    for (let index = 0; index <= 500; index += 1) {
      const toolCallId = `cancelled-begin-${index}`;
      vi.setSystemTime(index);
      journal.cancel({ toolCallId, error: 'cancelled', active: false });
      expect(journal.begin({ toolCallId, toolName: 'write', argsSha256: `sha-${index}` })).toEqual({
        status: 'failed',
        error: 'cancelled',
      });
    }

    expect(storage.rows.size).toBe(500);
    expect(storage.rows.has('cancelled-begin-0')).toBe(false);
    expect(storage.rows.has('cancelled-begin-500')).toBe(true);
  });

  it('bounds retained indeterminate operations without making them replayable', () => {
    const journal = journalOn(new TestStorage());
    journal.initialize();

    for (let index = 0; index < 50; index++) {
      expect(
        journal.begin({
          toolCallId: `call-${index}`,
          toolName: 'exec',
          argsSha256: `sha-${index}`,
        }),
      ).toEqual({ status: 'execute' });
    }

    expect(() =>
      journal.begin({
        toolCallId: 'call-over-limit',
        toolName: 'exec',
        argsSha256: 'sha-over-limit',
      }),
    ).toThrow(/too many indeterminate tool operations/);

    expect(journal.begin({ toolCallId: 'call-0', toolName: 'exec', argsSha256: 'sha-0' })).toEqual({
      status: 'indeterminate',
      error: 'The workspace tool operation was interrupted after it started and will not be repeated automatically.',
    });
  });

  it('durably replays failures and rejects tool-call identifier reuse', () => {
    const journal = journalOn(new TestStorage());
    journal.initialize();
    journal.begin(invocation());
    journal.fail({ toolCallId: 'call-1', error: 'command failed' });

    expect(journal.begin(invocation())).toEqual({ status: 'failed', error: 'command failed' });
    expect(() => journal.begin({ ...invocation(), argsSha256: 'b'.repeat(64) })).toThrow(
      'reused with different arguments',
    );
    expect(() => journal.begin({ ...invocation(), toolName: 'exec' })).toThrow('reused with different arguments');
  });

  it('replays a bounded committed mutation when its large display acknowledgement is interrupted', () => {
    const journal = journalOn(new TestStorage());
    journal.initialize();
    journal.begin(invocation());
    const receipt = {
      kind: 'workspace-mutation-receipt' as const,
      version: 1 as const,
      committed: true as const,
      acknowledgement: 'pending' as const,
      tool: 'write' as const,
      files: [
        {
          path: '/home/project/a.ts',
          revision: 2,
          size: 2 * 1024 * 1024 - 1,
          sha256: 'c'.repeat(64),
          deleted: false,
        },
      ],
      changedRanges: [{ path: '/home/project/a.ts', startLine: 1, endLine: 1 }],
      diffSummary: null,
      truncated: { result: false, diff: false, paths: false, omittedBytes: 0 },
    };

    journal.commitMutation({ toolCallId: 'call-1', receipt });

    expect(journal.begin(invocation())).toEqual({ status: 'completed', result: receipt });
    const acknowledged = journal.acknowledgeMutation({
      toolCallId: 'call-1',
      result: { diff: 'x'.repeat(700_000), patch: 'y'.repeat(700_000) },
    });
    expect(acknowledged).toMatchObject({
      committed: true,
      acknowledgement: 'complete',
      truncated: { result: true, diff: true },
    });
    expect(journal.begin(invocation())).toEqual({ status: 'completed', result: acknowledged });
  });

  it('distinguishes a mutation that failed before its first durable write', () => {
    const journal = journalOn(new TestStorage());
    journal.initialize();
    journal.begin(invocation());

    expect(journal.mutationReceipt('call-1')).toBeNull();
    expect(journal.complete({ toolCallId: 'call-1', result: { error: 'path does not exist' } })).toEqual({
      error: 'path does not exist',
    });
    expect(journal.mutationReceipt('call-1')).toBeNull();
  });

  it('terminalizes more than fifty pending commands without consuming the indeterminate-operation budget', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();

    for (let index = 0; index < 60; index += 1) {
      const toolCallId = `pending-${index}`;
      expect(journal.begin({ toolCallId, toolName: 'exec', argsSha256: `sha-${index}` })).toEqual({
        status: 'execute',
      });
      journal.registerPending({
        backend: 'container-shell',
        toolCallId,
        result: { command: `command-${index}`, exitCode: 0 },
      });
      expect(journal.completePending('container-shell')).toBe(true);
    }

    expect(journal.pending()).toEqual([]);
    expect(journal.begin({ toolCallId: 'after-pending', toolName: 'exec', argsSha256: 'after' })).toEqual({
      status: 'execute',
    });
  });

  it('replays completed and exhausted pending commands after restart without rerunning them', () => {
    const storage = new TestStorage();
    const beforeRestart = journalOn(storage);
    beforeRestart.initialize();
    beforeRestart.begin({ toolCallId: 'pending-complete', toolName: 'exec', argsSha256: 'complete' });
    beforeRestart.registerPending({
      backend: 'container-shell',
      toolCallId: 'pending-complete',
      result: { command: 'touch file', exitCode: 0 },
    });

    const afterRestart = journalOn(storage);
    afterRestart.initialize();
    expect(afterRestart.completePending('container-shell')).toBe(true);
    expect(afterRestart.begin({ toolCallId: 'pending-complete', toolName: 'exec', argsSha256: 'complete' })).toEqual({
      status: 'completed',
      result: { command: 'touch file', exitCode: 0 },
    });
  });

  it('fails the command waiting on a backend whose synchronization can never complete', () => {
    const journal = journalOn(new TestStorage());
    journal.initialize();
    journal.failPending('container-shell', 'nothing waits');
    journal.begin({ toolCallId: 'pending-lost', toolName: 'exec', argsSha256: 'lost' });
    journal.registerPending({ backend: 'container-shell', toolCallId: 'pending-lost', result: { exitCode: 0 } });

    journal.failPending('container-shell', 'The container that ran it is gone.');

    expect(journal.pending()).toEqual([]);
    expect(journal.begin({ toolCallId: 'pending-lost', toolName: 'exec', argsSha256: 'lost' })).toMatchObject({
      status: 'failed',
    });
  });

  it('blocks new work after restart when a pending continuation has no Computer retry row', () => {
    const storage = new TestStorage();
    const beforeRestart = journalOn(storage);
    beforeRestart.initialize();
    beforeRestart.begin({ toolCallId: 'pending-restart', toolName: 'exec', argsSha256: 'restart' });
    beforeRestart.registerPending({
      backend: 'container-shell',
      toolCallId: 'pending-restart',
      result: { command: 'touch file', exitCode: 0 },
    });

    const afterRestart = journalOn(storage);
    afterRestart.initialize();
    expect(() => requireWorkspaceSyncBarrier(afterRestart.pending(), () => null, 1_000)).toThrow(
      WorkspaceSyncPendingError,
    );
    try {
      requireWorkspaceSyncBarrier(afterRestart.pending(), () => null, 1_000);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'workspace_sync_pending',
        backend: 'container-shell',
        attempt: 1,
        notBefore: 2_000,
      });
    }

    expect(afterRestart.completePending('container-shell')).toBe(true);
    expect(() => requireWorkspaceSyncBarrier(afterRestart.pending(), () => null, 1_000)).not.toThrow();
  });

  it('rejects corrupted pending recovery state instead of omitting the operation', () => {
    const storage = new TestStorage();
    const journal = journalOn(storage);
    journal.initialize();
    journal.begin({ toolCallId: 'pending-corrupt', toolName: 'exec', argsSha256: 'corrupt' });
    storage.rows.get('pending-corrupt')!.result_json = JSON.stringify({ kind: 'unknown' });

    expect(() => journal.pending()).toThrow('invalid recovery state');
  });
});

/**
 * TestStorage implements the two members ToolOperationJournal reaches for, not the rest of
 * DurableObjectStorage.
 */
function journalOn(storage: TestStorage): ToolOperationJournal {
  // SAFETY: the journal only calls `sql.exec` and `transactionSync`, and TestStorage implements
  // both with the same signatures.
  return new ToolOperationJournal(storage as never);
}

function invocation() {
  return { toolCallId: 'call-1', toolName: 'write', argsSha256: 'a'.repeat(64) };
}

type Row = {
  tool_name: string;
  args_sha256: string;
  status: 'running' | 'completed' | 'failed';
  result_json: string | null;
  error: string | null;
  updated_at: number;
};

class TestStorage {
  readonly rows = new Map<string, Row>();
  readonly cancellations = new Map<string, { error: string; cancelledAt: number }>();
  readonly sql = {
    exec: <T>(query: string, ...bindings: unknown[]): T[] => {
      const normalized = query.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT tool_name')) {
        const row = this.rows.get(String(bindings[0]));
        return (row ? [row] : []) as T[];
      }
      if (normalized.startsWith('SELECT error FROM ghostbuild_tool_cancellations')) {
        const cancellation = this.cancellations.get(String(bindings[0]));
        return (cancellation ? [{ error: cancellation.error }] : []) as T[];
      }
      if (normalized.startsWith('SELECT COUNT(*)')) {
        return [{ count: [...this.rows.values()].filter((row) => row.status === 'running').length }] as T[];
      }
      if (normalized.startsWith('SELECT tool_call_id')) {
        return [...this.rows]
          .filter(([, row]) => row.status === 'running' && row.result_json !== null)
          .map(([tool_call_id, row]) => ({ tool_call_id, result_json: row.result_json })) as T[];
      }
      if (normalized.startsWith('INSERT INTO ghostbuild_tool_cancellations')) {
        if (!this.cancellations.has(String(bindings[0]))) {
          this.cancellations.set(String(bindings[0]), {
            error: String(bindings[1]),
            cancelledAt: Number(bindings[2]),
          });
        }
      } else if (normalized.startsWith('INSERT INTO ghostbuild_tool_operations')) {
        const failed = normalized.includes("'failed'");
        this.rows.set(String(bindings[0]), {
          tool_name: String(bindings[1]),
          args_sha256: String(bindings[2]),
          status: failed ? 'failed' : 'running',
          result_json: null,
          error: failed ? String(bindings[3]) : null,
          updated_at: Number(bindings[failed ? 5 : 4]),
        });
      } else if (normalized.startsWith('DELETE FROM ghostbuild_tool_cancellations')) {
        if (normalized.includes('SELECT tool_call_id')) {
          const keep = Number(bindings[0]);
          const retained = [...this.cancellations]
            .sort(
              ([leftId, left], [rightId, right]) =>
                right.cancelledAt - left.cancelledAt || rightId.localeCompare(leftId),
            )
            .slice(0, keep)
            .map(([toolCallId]) => toolCallId);
          for (const toolCallId of this.cancellations.keys()) {
            if (!retained.includes(toolCallId)) {
              this.cancellations.delete(toolCallId);
            }
          }
        } else {
          this.cancellations.delete(String(bindings[0]));
        }
      } else if (normalized.startsWith('DELETE FROM ghostbuild_tool_operations')) {
        const keep = Number(bindings[0]);
        const retained = [...this.rows]
          .filter(([, row]) => row.status !== 'running')
          .sort(
            ([leftId, left], [rightId, right]) => right.updated_at - left.updated_at || rightId.localeCompare(leftId),
          )
          .slice(0, keep)
          .map(([toolCallId]) => toolCallId);
        for (const [toolCallId, row] of this.rows) {
          if (row.status !== 'running' && !retained.includes(toolCallId)) {
            this.rows.delete(toolCallId);
          }
        }
      } else if (normalized.includes("SET status = 'completed'")) {
        const row = this.rows.get(String(bindings[2]))!;
        this.rows.set(String(bindings[2]), {
          ...row,
          status: 'completed',
          result_json: String(bindings[0]),
          error: null,
          updated_at: Number(bindings[1]),
        });
      } else if (normalized.includes("SET status = 'failed'")) {
        const preservesError = normalized.includes('result_json = NULL, updated_at = ?');
        const key = String(bindings[preservesError ? 1 : 2]);
        const row = this.rows.get(key)!;
        this.rows.set(key, {
          ...row,
          status: 'failed',
          result_json: null,
          error: preservesError ? row.error : String(bindings[0]),
          updated_at: Number(bindings[preservesError ? 0 : 1]),
        });
      } else if (normalized.includes('SET error = ?')) {
        const row = this.rows.get(String(bindings[2]))!;
        if (row.status === 'running' && row.error === null) {
          this.rows.set(String(bindings[2]), {
            ...row,
            error: String(bindings[0]),
            updated_at: Number(bindings[1]),
          });
        }
      } else if (normalized.includes('SET result_json = ?')) {
        const row = this.rows.get(String(bindings[2]))!;
        this.rows.set(String(bindings[2]), {
          ...row,
          result_json: String(bindings[0]),
          updated_at: Number(bindings[1]),
        });
      }
      return [];
    },
  };

  transactionSync<T>(closure: () => T): T {
    const snapshot = new Map(this.rows);
    const cancellationSnapshot = new Map(this.cancellations);
    try {
      return closure();
    } catch (error) {
      this.rows.clear();
      for (const [key, row] of snapshot) {
        this.rows.set(key, row);
      }
      this.cancellations.clear();
      for (const [key, value] of cancellationSnapshot) {
        this.cancellations.set(key, value);
      }
      throw error;
    }
  }
}
