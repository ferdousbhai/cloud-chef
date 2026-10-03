import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntimeResult } from '@cloudflare/computer';
import {
  DurableWorkspaceSyncRetryScheduler,
  requireDurableCommandResult,
  WorkspaceSyncPendingError,
} from './workspace-sync-retry';

describe('DurableWorkspaceSyncRetryScheduler', () => {
  it('never acknowledges a command whose post-command pull is pending', () => {
    const result = {
      status: 'completed',
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      pushed: 1,
      pulled: 0,
      skipped: [],
      sync: { status: 'pending', applied: 0, skipped: [], error: 'pull interrupted' },
    } satisfies WorkspaceRuntimeResult<'utf8'>;

    expect(() => requireDurableCommandResult(result, 'container-shell', 100)).toThrow(WorkspaceSyncPendingError);
    try {
      requireDurableCommandResult(result, 'container-shell', 100);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'workspace_sync_pending',
        backend: 'container-shell',
        attempt: 1,
        notBefore: 1_100,
        causeCode: 'pull interrupted',
      });
    }
  });

  it('persists one retry intent per backend and preserves its original age', async () => {
    const storage = new TestStorage();
    const wake = vi.fn(async () => undefined);
    let now = 100;
    const scheduler = new DurableWorkspaceSyncRetryScheduler(storage as never, wake, () => now);
    scheduler.initialize();

    await scheduler.schedule({ backend: 'container-shell', attempt: 1, notBefore: 1_100 });
    now = 200;
    await scheduler.schedule({ backend: 'container-shell', attempt: 2, notBefore: 2_200 });

    await expect(scheduler.get('container-shell')).resolves.toEqual({
      backend: 'container-shell',
      attempt: 2,
      notBefore: 2_200,
    });
    expect(scheduler.state('container-shell')).toMatchObject({ createdAt: 100, updatedAt: 200, exhausted: false });
    expect(storage.rows).toHaveLength(1);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('durably clears completion and retains actionable exhaustion metadata', async () => {
    const storage = new TestStorage();
    const scheduler = new DurableWorkspaceSyncRetryScheduler(
      storage as never,
      async () => undefined,
      () => 100,
    );
    scheduler.initialize();
    await scheduler.schedule({ backend: 'container-shell', attempt: 5, notBefore: 1_000 });

    scheduler.recordFailure('container-shell', 'FUSE pull unavailable', true, 200);
    expect(scheduler.state('container-shell')).toMatchObject({
      attempt: 5,
      lastError: 'FUSE pull unavailable',
      exhausted: true,
    });

    await scheduler.clear('container-shell');
    expect(scheduler.state('container-shell')).toBeNull();
  });

  it('re-arms every persisted retry intent after a Durable Object restart', async () => {
    const storage = new TestStorage();
    const firstWake = vi.fn(async () => undefined);
    const first = new DurableWorkspaceSyncRetryScheduler(storage as never, firstWake, () => 100);
    first.initialize();
    await first.schedule({ backend: 'container-shell', attempt: 2, notBefore: 2_000 });

    const restartWake = vi.fn(async () => undefined);
    const restarted = new DurableWorkspaceSyncRetryScheduler(storage as never, restartWake, () => 200);
    restarted.initialize();
    await restarted.reconcile();

    expect(restartWake).toHaveBeenCalledOnce();
    expect(restartWake).toHaveBeenCalledWith({ backend: 'container-shell', attempt: 2, notBefore: 2_000 });
  });

  it('round-trips the runtime identity a retry must still be talking to', async () => {
    // Computer only asserts the pull reaches the runtime that ran the command when the intent
    // carries its id. Dropping it lets a retry against a replacement container report an
    // interrupted command as durably synced.
    const storage = new TestStorage();
    const wake = vi.fn(async () => undefined);
    // SAFETY: TestStorage stands in for the two Durable Object storage members the scheduler uses.
    const scheduler = new DurableWorkspaceSyncRetryScheduler(storage as never, wake, () => 100);
    scheduler.initialize();

    await scheduler.schedule({ backend: 'container-shell', runtimeId: 'runtime-1', attempt: 1, notBefore: 1_100 });
    const intent = { backend: 'container-shell', runtimeId: 'runtime-1', attempt: 1, notBefore: 1_100 };

    await expect(scheduler.get('container-shell')).resolves.toEqual(intent);
    expect(scheduler.state('container-shell')).toMatchObject({ runtimeId: 'runtime-1' });

    // Re-reading it from storage is the proof: `schedule` hands its own argument to the wake.
    await scheduler.reconcile();
    expect(wake).toHaveBeenLastCalledWith(intent);
    await scheduler.rearm('container-shell');
    expect(wake).toHaveBeenLastCalledWith(intent);
  });

  it('never re-arms terminal exhaustion after duplicate wakes or Durable Object restarts', async () => {
    const storage = new TestStorage();
    const wake = vi.fn(async () => undefined);
    const first = new DurableWorkspaceSyncRetryScheduler(storage as never, wake, () => 100);
    first.initialize();
    await first.schedule({ backend: 'container-shell', attempt: 5, notBefore: 1_000 });
    first.recordFailure('container-shell', 'pull unavailable', true, 200);

    await first.reconcile();
    const restartedWake = vi.fn(async () => undefined);
    const restarted = new DurableWorkspaceSyncRetryScheduler(storage as never, restartedWake, () => 300);
    restarted.initialize();
    await restarted.reconcile();

    expect(wake).toHaveBeenCalledOnce();
    expect(restartedWake).not.toHaveBeenCalled();
  });
});

type Row = {
  backend: string;
  attempt: number;
  not_before: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  exhausted: number;
  runtime_id: string | null;
};

class TestStorage {
  rows: Row[] = [];
  readonly sql = {
    exec: <T>(query: string, ...bindings: unknown[]): T[] => {
      const normalized = query.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT backend')) {
        return (
          bindings.length === 0
            ? [...this.rows].sort((a, b) => a.backend.localeCompare(b.backend))
            : this.rows.filter((row) => row.backend === bindings[0])
        ) as T[];
      }
      if (normalized.startsWith('INSERT INTO ghostbuild_workspace_sync_retries')) {
        const backend = String(bindings[0]);
        const row = this.rows.find((candidate) => candidate.backend === backend);
        const next: Row = {
          backend,
          attempt: Number(bindings[1]),
          not_before: Number(bindings[2]),
          created_at: row?.created_at ?? Number(bindings[3]),
          updated_at: Number(bindings[4]),
          last_error: row?.last_error ?? null,
          exhausted: 0,
          runtime_id: bindings[5] === null || bindings[5] === undefined ? null : String(bindings[5]),
        };
        this.rows = [...this.rows.filter((candidate) => candidate.backend !== backend), next];
      } else if (normalized.startsWith('DELETE FROM ghostbuild_workspace_sync_retries')) {
        this.rows = this.rows.filter((row) => row.backend !== bindings[0]);
      } else if (normalized.startsWith('UPDATE ghostbuild_workspace_sync_retries')) {
        const row = this.rows.find((candidate) => candidate.backend === bindings[3]);
        if (row) {
          Object.assign(row, { last_error: bindings[0], exhausted: bindings[1], updated_at: bindings[2] });
        }
      }
      return [];
    },
  };

  transactionSync<T>(closure: () => T): T {
    return closure();
  }
}
