import type { SyncRetryIntent, SyncRetryScheduler, WorkspaceRuntimeResult } from '@cloudflare/computer';
import {
  COMPUTER_SYNC_EXHAUSTED_ERROR_CODE,
  COMPUTER_SYNC_PENDING_ERROR_CODE,
} from '../../ghostbuild-agent/cloudflare-computer';

type SyncRetryStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type SyncRetryRow = {
  backend: string;
  attempt: number;
  not_before: number;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  exhausted: number;
  runtime_id: string | null;
};

type WorkspaceSyncRetryState = SyncRetryIntent & {
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  exhausted: boolean;
};

type PendingWorkspaceSync = { backend: string };

export class WorkspaceSyncPendingError extends Error {
  readonly code: string;

  constructor(
    readonly backend: string,
    readonly attempt: number,
    readonly notBefore: number,
    exhausted: boolean,
    readonly causeCode: string | null,
    readonly commandResult?: WorkspaceRuntimeResult<'utf8'>,
  ) {
    const code = exhausted ? COMPUTER_SYNC_EXHAUSTED_ERROR_CODE : COMPUTER_SYNC_PENDING_ERROR_CODE;
    super(
      exhausted
        ? `[${code}] Computer synchronization for ${backend} exhausted its retry budget and requires intervention.`
        : `[${code}] Computer synchronization for ${backend} is pending; retry after ${Math.max(0, notBefore - Date.now())}ms.`,
    );
    this.name = 'WorkspaceSyncPendingError';
    this.code = code;
  }
}

/** Block new work while either Computer or the tool journal still proves a pull is outstanding. */
export function requireWorkspaceSyncBarrier(
  pendingCommands: readonly PendingWorkspaceSync[],
  state: (backend: string) => WorkspaceSyncRetryState | null,
  now = Date.now(),
): void {
  const continuation = pendingCommands[0];
  if (continuation) {
    const retry = state(continuation.backend);
    throw new WorkspaceSyncPendingError(
      continuation.backend,
      retry?.attempt ?? 1,
      retry?.notBefore ?? now + 1_000,
      retry?.exhausted ?? false,
      retry?.lastError ?? null,
    );
  }
  const retry = state('container-shell');
  if (retry) {
    throw new WorkspaceSyncPendingError(
      'container-shell',
      retry.attempt,
      retry.notBefore,
      retry.exhausted,
      retry.lastError,
    );
  }
}

/** A successful command is not a durable mutation until its post-command pull completed. */
export function requireDurableCommandResult(
  result: WorkspaceRuntimeResult<'utf8'>,
  backend: string,
  now = Date.now(),
): WorkspaceRuntimeResult<'utf8'> {
  if (result.sync.status === 'pending') {
    throw new WorkspaceSyncPendingError(backend, 1, now + 1_000, false, result.sync.error, result);
  }
  return result;
}

/** Durable host adapter for Computer's pending post-command pull protocol. */
export class DurableWorkspaceSyncRetryScheduler implements SyncRetryScheduler {
  constructor(
    private readonly storage: SyncRetryStorage,
    private readonly wake: (intent: SyncRetryIntent) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  initialize(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ghostbuild_workspace_sync_retries (
         backend TEXT PRIMARY KEY,
         attempt INTEGER NOT NULL,
         not_before INTEGER NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         last_error TEXT,
         exhausted INTEGER NOT NULL DEFAULT 0,
         runtime_id TEXT
       )`,
    );
    // CREATE TABLE IF NOT EXISTS will not add the column to an already-provisioned workspace, and
    // without it the retry loses the identity of the runtime that ran the command: Computer then
    // skips its stale-runtime assertion and a pull from a replacement container reports the
    // interrupted command as durably synced.
    const columns = [
      ...this.storage.sql.exec<{ name: string }>('PRAGMA table_info(ghostbuild_workspace_sync_retries)'),
    ];
    if (!columns.some((column) => column.name === 'runtime_id')) {
      this.storage.sql.exec('ALTER TABLE ghostbuild_workspace_sync_retries ADD COLUMN runtime_id TEXT');
    }
  }

  async get(backend: string): Promise<SyncRetryIntent | undefined> {
    const row = this.read(backend);
    return row ? intentOf(row) : undefined;
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    const now = this.now();
    this.storage.transactionSync(() => {
      const existing = this.read(intent.backend);
      this.storage.sql.exec(
        `INSERT INTO ghostbuild_workspace_sync_retries (
           backend, attempt, not_before, created_at, updated_at, last_error, exhausted, runtime_id
         ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?)
         ON CONFLICT(backend) DO UPDATE SET
           attempt = excluded.attempt,
           not_before = excluded.not_before,
           updated_at = excluded.updated_at,
           exhausted = 0,
           runtime_id = excluded.runtime_id`,
        intent.backend,
        intent.attempt,
        intent.notBefore,
        existing?.created_at ?? now,
        now,
        intent.runtimeId ?? null,
      );
    });
    await this.wake(intent);
  }

  /**
   * Re-arm the wake for an already-stored intent. Rewriting it through `schedule` would have to
   * reconstruct the intent from the read state, and dropping its runtime identity there is exactly
   * what lets a later retry pull from a container that never ran the command.
   */
  async rearm(backend: string): Promise<void> {
    const row = this.read(backend);
    if (row) {
      await this.wake(intentOf(row));
    }
  }

  async clear(backend: string): Promise<void> {
    this.storage.sql.exec('DELETE FROM ghostbuild_workspace_sync_retries WHERE backend = ?', backend);
  }

  async reconcile(): Promise<void> {
    for (const row of this.readAll()) {
      if (row.exhausted === 1) {
        continue;
      }
      await this.wake(intentOf(row));
    }
  }

  recordFailure(backend: string, error: string, exhausted: boolean, now = this.now()): void {
    this.storage.sql.exec(
      `UPDATE ghostbuild_workspace_sync_retries
       SET last_error = ?, exhausted = ?, updated_at = ?
       WHERE backend = ?`,
      error.slice(-1_000),
      exhausted ? 1 : 0,
      now,
      backend,
    );
  }

  state(backend: string): WorkspaceSyncRetryState | null {
    const row = this.read(backend);
    return row
      ? {
          ...intentOf(row),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastError: row.last_error,
          exhausted: row.exhausted === 1,
        }
      : null;
  }

  private read(backend: string): SyncRetryRow | undefined {
    return first(
      this.storage.sql.exec<SyncRetryRow>(
        `SELECT backend, attempt, not_before, created_at, updated_at, last_error, exhausted, runtime_id
         FROM ghostbuild_workspace_sync_retries WHERE backend = ?`,
        backend,
      ),
    );
  }

  private readAll(): SyncRetryRow[] {
    return [
      ...this.storage.sql.exec<SyncRetryRow>(
        `SELECT backend, attempt, not_before, created_at, updated_at, last_error, exhausted, runtime_id
         FROM ghostbuild_workspace_sync_retries ORDER BY backend`,
      ),
    ];
  }
}

/** Computer treats a present `runtimeId` as the identity the retry's pull must still be talking to. */
function intentOf(row: SyncRetryRow): SyncRetryIntent {
  const intent: SyncRetryIntent = { backend: row.backend, attempt: row.attempt, notBefore: row.not_before };
  if (row.runtime_id !== null) {
    intent.runtimeId = row.runtime_id;
  }
  return intent;
}

function first<T>(rows: Iterable<T>): T | undefined {
  for (const row of rows) {
    return row;
  }
  return undefined;
}
