import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntimeResult } from '@cloudflare/computer';
import {
  DurableWorkspaceSyncRetryScheduler,
  pullFromOriginRuntime,
  requireDurableCommandResult,
  retryPendingSync,
  type SyncRetryPolicy,
  WorkspaceSyncPendingError,
  type WorkspaceSyncPullTarget,
  WorkspaceSyncRuntimeLostError,
} from './workspace-sync-retry';

const POLICY: SyncRetryPolicy = { initialDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 5 };

describe('durable post-command sync', () => {
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
    const storage = new SqliteStorage();
    const wake = vi.fn(async () => undefined);
    let now = 100;
    const scheduler = new DurableWorkspaceSyncRetryScheduler(storage, wake, () => now);
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
    expect(storage.count()).toBe(1);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it('records the first pending pull of a command once, keeping its runtime and backoff', async () => {
    const storage = new SqliteStorage();
    const wake = vi.fn(async () => undefined);
    let now = 1_000;
    const scheduler = new DurableWorkspaceSyncRetryScheduler(storage, wake, () => now);
    scheduler.initialize();

    await scheduler.schedulePending('container-shell', 'runtime-1', 'pull failed');
    now = 5_000;
    // A second report of the same pending pull, as the tool journal makes, must not reset it.
    await scheduler.schedulePending('container-shell', undefined, null);
    await scheduler.schedulePending('container-shell', 'runtime-1', null);

    expect(scheduler.state('container-shell')).toMatchObject({
      attempt: 1,
      notBefore: 2_000,
      runtimeId: 'runtime-1',
      lastError: 'pull failed',
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it('re-arms every persisted retry intent after a Durable Object restart, but never an exhausted one', async () => {
    const storage = new SqliteStorage();
    const first = new DurableWorkspaceSyncRetryScheduler(
      storage,
      async () => undefined,
      () => 100,
    );
    first.initialize();
    await first.schedule({ backend: 'container-shell', runtimeId: 'runtime-1', attempt: 2, notBefore: 2_000 });
    await first.schedule({ backend: 'other', attempt: 5, notBefore: 1_000 });
    first.recordFailure('other', 'pull unavailable', true, 200);

    const restartWake = vi.fn(async () => undefined);
    const restarted = new DurableWorkspaceSyncRetryScheduler(storage, restartWake, () => 200);
    restarted.initialize();
    await restarted.reconcile();

    expect(restartWake).toHaveBeenCalledOnce();
    expect(restartWake).toHaveBeenCalledWith({
      backend: 'container-shell',
      runtimeId: 'runtime-1',
      attempt: 2,
      notBefore: 2_000,
    });
  });

  it('adds the runtime column to a table from before it existed', () => {
    const storage = new SqliteStorage();
    storage.sql.exec(
      `CREATE TABLE ghostbuild_workspace_sync_retries (
         backend TEXT PRIMARY KEY, attempt INTEGER NOT NULL, not_before INTEGER NOT NULL,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_error TEXT,
         exhausted INTEGER NOT NULL DEFAULT 0
       )`,
    );
    new DurableWorkspaceSyncRetryScheduler(storage, async () => undefined).initialize();

    expect(storage.columns()).toContain('runtime_id');
  });
});

describe('pulling only from the runtime that ran the command', () => {
  it('pulls when the runtime is still the one that ran the command', async () => {
    const target = new FakeTarget(['runtime-1', 'runtime-1']);

    await pullFromOriginRuntime(target, 'container-shell', 'runtime-1');

    expect(target.pulls).toBe(1);
  });

  it('refuses to pull from a replacement container', async () => {
    const target = new FakeTarget(['runtime-2']);

    await expect(pullFromOriginRuntime(target, 'container-shell', 'runtime-1')).rejects.toBeInstanceOf(
      WorkspaceSyncRuntimeLostError,
    );
    expect(target.pulls).toBe(0);
  });

  it('does not accept a pull that finished against a container that replaced the original mid-pull', async () => {
    // Computer reconnects a dropped backend inside a pull; the pull then succeeds against the
    // replacement while the original's changes are gone.
    const target = new FakeTarget(['runtime-1', 'runtime-2']);

    await expect(pullFromOriginRuntime(target, 'container-shell', 'runtime-1')).rejects.toMatchObject({
      expectedRuntimeId: 'runtime-1',
      currentRuntimeId: 'runtime-2',
    });
    expect(target.pulls).toBe(1);
  });

  it('pulls without a check when the intent never named a runtime', async () => {
    const target = new FakeTarget([]);

    await pullFromOriginRuntime(target, 'container-shell', undefined);

    expect(target.pulls).toBe(1);
    expect(target.identityChecks).toBe(0);
  });
});

describe('retrying a pending pull', () => {
  async function pendingScheduler(intent: { attempt: number; runtimeId?: string }, now = 10_000) {
    const storage = new SqliteStorage();
    const wake = vi.fn(async () => undefined);
    const scheduler = new DurableWorkspaceSyncRetryScheduler(storage, wake, () => now);
    scheduler.initialize();
    await scheduler.schedule({ backend: 'container-shell', notBefore: now, ...intent });
    wake.mockClear();
    return { scheduler, wake };
  }

  it('is idle with nothing to retry', async () => {
    const { scheduler } = await pendingScheduler({ attempt: 1 });
    await scheduler.clear('container-shell');

    await expect(
      retryPendingSync({ scheduler, target: new FakeTarget([]), backend: 'container-shell', policy: POLICY }),
    ).resolves.toEqual({ status: 'idle', backend: 'container-shell' });
  });

  it('completes and clears the intent once the origin runtime answers', async () => {
    const { scheduler } = await pendingScheduler({ attempt: 2, runtimeId: 'runtime-1' });
    const target = new FakeTarget(['runtime-1', 'runtime-1']);

    await expect(retryPendingSync({ scheduler, target, backend: 'container-shell', policy: POLICY })).resolves.toEqual({
      status: 'complete',
      backend: 'container-shell',
    });
    expect(scheduler.state('container-shell')).toBeNull();
    expect(target.pulls).toBe(1);
  });

  it('reports the command lost, and clears the intent, when its container was replaced', async () => {
    const { scheduler } = await pendingScheduler({ attempt: 1, runtimeId: 'runtime-1' });

    await expect(
      retryPendingSync({
        scheduler,
        target: new FakeTarget(['runtime-2']),
        backend: 'container-shell',
        policy: POLICY,
      }),
    ).resolves.toMatchObject({ status: 'lost', runtimeId: 'runtime-1' });
    expect(scheduler.state('container-shell')).toBeNull();
  });

  it('backs off exponentially from the stored attempt and keeps the origin runtime', async () => {
    const { scheduler, wake } = await pendingScheduler({ attempt: 2, runtimeId: 'runtime-1' });
    const target = new FakeTarget(['runtime-1'], new Error('pull interrupted'));

    await expect(
      retryPendingSync({ scheduler, target, backend: 'container-shell', policy: POLICY, now: () => 10_000 }),
    ).resolves.toEqual({
      status: 'pending',
      backend: 'container-shell',
      runtimeId: 'runtime-1',
      attempt: 3,
      notBefore: 14_000,
      error: 'pull interrupted',
    });
    expect(wake).toHaveBeenCalledWith({
      backend: 'container-shell',
      runtimeId: 'runtime-1',
      attempt: 3,
      notBefore: 14_000,
    });
    expect(scheduler.state('container-shell')).toMatchObject({ attempt: 3, runtimeId: 'runtime-1' });
  });

  it('caps the backoff at the policy maximum', async () => {
    const { scheduler } = await pendingScheduler({ attempt: 4 });
    const policy = { initialDelayMs: 1_000, maxDelayMs: 5_000, maxAttempts: 9 };

    await expect(
      retryPendingSync({
        scheduler,
        target: new FakeTarget([], new Error('down')),
        backend: 'container-shell',
        policy,
        now: () => 0,
      }),
    ).resolves.toMatchObject({ status: 'pending', attempt: 5, notBefore: 5_000 });
  });

  it('counts an unreachable container as a failed attempt, not as proof the command was lost', async () => {
    const { scheduler } = await pendingScheduler({ attempt: 1, runtimeId: 'runtime-1' });
    const target: WorkspaceSyncPullTarget = {
      currentRuntimeId: async () => {
        throw new Error('container did not start');
      },
      pull: vi.fn(async () => undefined),
    };

    await expect(
      retryPendingSync({ scheduler, target, backend: 'container-shell', policy: POLICY }),
    ).resolves.toMatchObject({ status: 'pending', attempt: 2, error: 'container did not start' });
    expect(target.pull).not.toHaveBeenCalled();
  });

  it('reports exhaustion on the last attempt and leaves the intent for recovery', async () => {
    const { scheduler, wake } = await pendingScheduler({ attempt: 5, runtimeId: 'runtime-1' });

    await expect(
      retryPendingSync({
        scheduler,
        target: new FakeTarget(['runtime-1'], new Error('still failing')),
        backend: 'container-shell',
        policy: POLICY,
      }),
    ).resolves.toEqual({
      status: 'exhausted',
      backend: 'container-shell',
      attempt: 5,
      runtimeId: 'runtime-1',
      error: 'still failing',
    });
    expect(wake).not.toHaveBeenCalled();
    expect(scheduler.state('container-shell')).not.toBeNull();
  });

  it('never pulls again past the attempt budget', async () => {
    const { scheduler } = await pendingScheduler({ attempt: 6 });
    const target = new FakeTarget([]);

    await expect(
      retryPendingSync({ scheduler, target, backend: 'container-shell', policy: POLICY }),
    ).resolves.toMatchObject({ status: 'exhausted', attempt: 6 });
    expect(target.pulls).toBe(0);
  });
});

/** Answers the runtime identities in order (the last one repeats), and fails pulls when told to. */
class FakeTarget implements WorkspaceSyncPullTarget {
  pulls = 0;
  identityChecks = 0;

  constructor(
    private readonly identities: string[],
    private readonly pullError?: Error,
  ) {}

  async currentRuntimeId(): Promise<string | null> {
    const identity = this.identities[Math.min(this.identityChecks, this.identities.length - 1)] ?? null;
    this.identityChecks += 1;
    return identity;
  }

  async pull(): Promise<void> {
    this.pulls += 1;
    if (this.pullError) {
      throw this.pullError;
    }
  }
}

/** Durable Object SQL over node:sqlite: `exec` returns an iterable of rows, as the platform's cursor is. */
class SqliteStorage {
  readonly #database = new DatabaseSync(':memory:');
  readonly sql: SqlStorage;

  constructor() {
    const exec = <Row extends Record<string, SqlStorageValue>>(query: string, ...bindings: SQLInputValue[]): Row[] => {
      const statement = this.#database.prepare(query);
      if (/^\s*(?:SELECT|PRAGMA)\b/i.test(query)) {
        // SAFETY: every row comes from a SELECT or PRAGMA naming the columns its caller reads.
        return statement.all(...bindings) as Row[];
      }
      statement.run(...bindings);
      return [];
    };
    // SAFETY: the scheduler calls only `sql.exec`, and only iterates the rows it returns.
    this.sql = { exec } as never;
  }

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  count(): number {
    return this.#database.prepare('SELECT * FROM ghostbuild_workspace_sync_retries').all().length;
  }

  columns(): string[] {
    return this.#database
      .prepare('PRAGMA table_info(ghostbuild_workspace_sync_retries)')
      .all()
      .map((column) => String(column.name));
  }
}
