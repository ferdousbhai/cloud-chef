import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('collapses duplicate constructor reconciliation and wake schedules to one pending row', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const scheduler = source.slice(
      source.indexOf('this.#syncRetries = new DurableWorkspaceSyncRetryScheduler'),
      source.indexOf('this.#syncRetries.initialize()'),
    );
    expect(scheduler).toContain("'retryPendingComputerSync'");
    expect(scheduler).toContain('this.scheduleOnce(');

    const scheduleOnceStart = source.indexOf('private async scheduleOnce(');
    const scheduleOnce = source.slice(scheduleOnceStart, source.indexOf('\n  }', scheduleOnceStart));
    // `Container.schedule` mints a fresh row id per call, so dedupe has to be explicit.
    // An options bag such as `{ idempotent: true }` is dropped by its 3-arg signature.
    expect(scheduleOnce).toContain('this.deleteSchedules(callback)');
    expect(scheduleOnce).not.toContain('idempotent');
    expect(scheduleOnce.indexOf('this.deleteSchedules(callback)')).toBeLessThan(
      scheduleOnce.indexOf('await this.schedule('),
    );
  });

  it('proves exhausted recovery through a fresh pull before preserving the result and clearing the barrier', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('private async recoverExhaustedComputerSync(');
    const recovery = source.slice(start, source.indexOf('\n  private ', start + 1));

    expect(recovery.indexOf('await this.#workspace.close()')).toBeGreaterThanOrEqual(0);
    expect(recovery.indexOf('await this.#workspace.pull(backend)')).toBeGreaterThan(
      recovery.indexOf('await this.#workspace.close()'),
    );
    expect(recovery.indexOf('this.finishPendingCommand(backend)')).toBeGreaterThan(
      recovery.indexOf('await this.#workspace.pull(backend)'),
    );
    expect(recovery.indexOf('await this.#syncRetries.clear(backend)')).toBeGreaterThan(
      recovery.indexOf('this.finishPendingCommand(backend)'),
    );
    expect(recovery).toContain('return false');
  });

  it('recycles the container after consecutive failed recoveries instead of pulling forever', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('private async recoverExhaustedComputerSync(');
    const recovery = source.slice(start, source.indexOf('\n  private ', start + 1));

    // A recovery pull that keeps failing after Computer exhausted its own retries is the
    // signature of a container whose control connection never returns; each further pull only
    // burns the vendor's fixed connect retries. The escalation must reuse the same recycle the
    // preview path uses, count failures per backend, and reset the count on success.
    expect(source).toContain('const SYNC_RECOVERY_CONTAINER_RECYCLE_THRESHOLD = 2;');
    expect(recovery).toContain('SYNC_RECOVERY_CONTAINER_RECYCLE_THRESHOLD');
    expect(recovery).toContain('await this.recycleWorkspaceContainer()');
    expect(recovery.indexOf('this.#syncRecoveryFailures.delete(backend)')).toBeGreaterThanOrEqual(0);
    expect(recovery.indexOf('this.#syncRecoveryFailures.delete(backend)')).toBeLessThan(
      recovery.indexOf('} catch (error) {'),
    );
    expect(recovery.indexOf('await this.#workspace.pull(backend)')).toBeLessThan(
      recovery.indexOf('await this.recycleWorkspaceContainer()'),
    );
    // Recycling still reports the recovery as pending so every caller reschedules it.
    expect(recovery.lastIndexOf('return false')).toBeGreaterThan(
      recovery.indexOf('await this.recycleWorkspaceContainer()'),
    );
  });

  it('keeps exhausted sync recovery armed even when no tool continuation remains', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const constructor = source.slice(source.indexOf('constructor(ctx:'), source.indexOf('override fetch('));
    const reconcileStart = source.indexOf('async reconcilePendingCommands()');
    const reconcile = source.slice(reconcileStart, source.indexOf('\n  async beginToolOperation(', reconcileStart));

    expect(constructor).toContain("this.#syncRetries.state('container-shell')?.exhausted === true");
    expect(reconcile).toContain("backends.add('container-shell')");
    expect(reconcile).toContain('await this.schedulePendingCommandRecovery');
  });

  it('rejects tools on a pre-existing pending backend before allocating journal rows', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    for (const [start, end] of [
      ['async beginToolOperation(', 'completeToolOperation('],
      ['private async runToolOperation(', 'private async withStatefulOperation<'],
    ]) {
      const method = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
      expect(method.indexOf('requireCompletedComputerSync()')).toBeGreaterThanOrEqual(0);
      expect(method.indexOf('requireCompletedComputerSync()')).toBeLessThan(method.indexOf('#toolOperations.begin'));
    }
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
