import type { WorkspaceRuntimeResult } from '@cloudflare/computer';
import {
  COMPUTER_SYNC_EXHAUSTED_ERROR_CODE,
  COMPUTER_SYNC_PENDING_ERROR_CODE,
} from '../../cloudchef-agent/cloudflare-computer';
import { addMissingColumn, first } from './sql-rows';

/**
 * The durable post-command sync contract, owned by CloudChef.
 *
 * A command is not a durable mutation until the files it changed in the container have been pulled
 * into the Durable Object's VFS. Computer 0.2 kept a retry scheduler for a pull that failed; Computer
 * 0.3 and later only report the pull as pending (`sync: { status: 'pending' }`) and leave retrying
 * it, and refusing to pull from a container that did not run the command, to the host. This module is
 * that host code: one durable intent per backend, bounded exponential backoff, exhaustion, and the
 * origin check that turns a pull from a replacement container into `lost` rather than `complete`.
 */

type SyncRetryStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

/** A persisted pull to retry: which backend, which attempt, not before when, and from which runtime. */
type SyncRetryIntent = {
  backend: string;
  attempt: number;
  notBefore: number;
  /** The container runtime that ran the command. A pull from any other runtime cannot confirm it. */
  runtimeId?: string;
};

export type SyncRetryPolicy = { initialDelayMs: number; maxDelayMs: number; maxAttempts: number };

/** The policy ProjectWorkspace has always used: 1s doubling to 60s, five attempts. */
const WORKSPACE_SYNC_RETRY_POLICY: SyncRetryPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAttempts: 5,
};

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

/**
 * The container that ran a command is gone, so the files it changed can never be pulled. Reported as
 * a failure of that command, never as a completed pull: a pull from the replacement container would
 * succeed while carrying none of the command's changes.
 */
export class WorkspaceSyncRuntimeLostError extends Error {
  readonly code = 'workspace_sync_lost';

  constructor(
    readonly backend: string,
    readonly expectedRuntimeId: string,
    readonly currentRuntimeId: string | null,
  ) {
    super(`The container runtime that ran the command on ${backend} was replaced before its changes were saved.`);
    this.name = 'WorkspaceSyncRuntimeLostError';
  }
}

/** Block new work while either the sync intent or the tool journal still proves a pull is outstanding. */
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
    throw new WorkspaceSyncPendingError(backend, 1, now + 1_000, false, result.sync.error ?? null, result);
  }
  return result;
}

/** Durable intents for pending post-command pulls, one per backend, in the Durable Object's SQLite. */
export class DurableWorkspaceSyncRetryScheduler {
  constructor(
    private readonly storage: SyncRetryStorage,
    private readonly wake: (intent: SyncRetryIntent) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The table keeps its original name: a runtime upgraded from Computer 0.2 carries its pending
   * intents across, and those still have to block new work and be retried (or found lost) here.
   */
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
    // Without it the retry loses the identity of the runtime that ran the command: the origin check
    // is then skipped and a pull from a replacement container reports the interrupted command as
    // durably synced.
    addMissingColumn(this.storage.sql, 'ghostbuild_workspace_sync_retries', 'runtime_id', 'TEXT');
  }

  async get(backend: string): Promise<SyncRetryIntent | undefined> {
    const row = this.read(backend);
    return row ? intentOf(row) : undefined;
  }

  async schedule(intent: SyncRetryIntent): Promise<void> {
    const now = this.now();
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
      now,
      now,
      intent.runtimeId ?? null,
    );
    await this.wake(intent);
  }

  /**
   * Record the first pending pull of a command, unless one is already recorded for the same runtime.
   * A later report of the same pending pull must neither reset the backoff nor drop the runtime the
   * first one named.
   */
  async schedulePending(
    backend: string,
    runtimeId: string | undefined,
    error: string | null,
    policy: SyncRetryPolicy = WORKSPACE_SYNC_RETRY_POLICY,
  ): Promise<void> {
    const existing = this.read(backend);
    if (existing && (runtimeId === undefined || existing.runtime_id === runtimeId)) {
      return;
    }
    await this.schedule(retryIntent(backend, 1, runtimeId, this.now(), policy));
    if (error) {
      this.recordFailure(backend, error, false);
    }
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

/** What a pull needs from the workspace: the runtime it would talk to, and the pull itself. */
export type WorkspaceSyncPullTarget = {
  /**
   * Connect the backend if it is not connected and name the container runtime it is talking to now.
   * Throws when the backend cannot be reached, which is a failed attempt rather than proof of loss.
   */
  currentRuntimeId(backend: string): Promise<string | null>;
  /** Drain one pull of the backend's changes into the durable VFS. */
  pull(backend: string): Promise<void>;
};

type PendingSyncRetryResult =
  | { status: 'idle'; backend: string }
  | { status: 'complete'; backend: string }
  | { status: 'pending'; backend: string; attempt: number; notBefore: number; runtimeId?: string; error: string }
  | { status: 'exhausted'; backend: string; attempt: number; runtimeId?: string; error: string }
  | { status: 'lost'; backend: string; runtimeId: string; error: string };

/**
 * Pull a command's changes from the runtime that ran it, and only from that runtime.
 *
 * The runtime is checked before the pull and again after it. Before, because a replacement container
 * holds none of the command's changes. After, because Computer reconnects a dropped backend inside a
 * pull, and a pull that finished against a replacement proves nothing about the original.
 */
export async function pullFromOriginRuntime(
  target: WorkspaceSyncPullTarget,
  backend: string,
  expectedRuntimeId: string | undefined,
): Promise<void> {
  await requireOriginRuntime(target, backend, expectedRuntimeId);
  await target.pull(backend);
  await requireOriginRuntime(target, backend, expectedRuntimeId);
}

async function requireOriginRuntime(
  target: WorkspaceSyncPullTarget,
  backend: string,
  expectedRuntimeId: string | undefined,
): Promise<void> {
  if (expectedRuntimeId === undefined) {
    return;
  }
  const current = await target.currentRuntimeId(backend);
  if (current !== expectedRuntimeId) {
    throw new WorkspaceSyncRuntimeLostError(backend, expectedRuntimeId, current);
  }
}

/**
 * Run one host-scheduled retry of a pending pull from its stored intent.
 *
 * A successful pull from the origin runtime clears the intent. A failed pull advances bounded
 * exponential backoff; the last failed attempt stays stored and is reported as exhausted. A pull the
 * origin runtime can no longer answer clears the intent and reports `lost`.
 */
export async function retryPendingSync(args: {
  scheduler: DurableWorkspaceSyncRetryScheduler;
  target: WorkspaceSyncPullTarget;
  backend: string;
  policy?: SyncRetryPolicy;
  now?: () => number;
}): Promise<PendingSyncRetryResult> {
  const policy = args.policy ?? WORKSPACE_SYNC_RETRY_POLICY;
  const now = args.now ?? Date.now;
  const intent = await args.scheduler.get(args.backend);
  if (!intent) {
    return { status: 'idle', backend: args.backend };
  }
  const runtime = intent.runtimeId === undefined ? {} : { runtimeId: intent.runtimeId };
  if (intent.attempt > policy.maxAttempts) {
    return {
      status: 'exhausted',
      backend: args.backend,
      attempt: intent.attempt,
      ...runtime,
      error: 'pending sync retry attempts exhausted',
    };
  }
  try {
    await pullFromOriginRuntime(args.target, args.backend, intent.runtimeId);
    await args.scheduler.clear(args.backend);
    return { status: 'complete', backend: args.backend };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkspaceSyncRuntimeLostError) {
      await args.scheduler.clear(args.backend);
      return { status: 'lost', backend: args.backend, runtimeId: error.expectedRuntimeId, error: message };
    }
    if (intent.attempt >= policy.maxAttempts) {
      return { status: 'exhausted', backend: args.backend, attempt: intent.attempt, ...runtime, error: message };
    }
    const next = retryIntent(args.backend, intent.attempt + 1, intent.runtimeId, now(), policy);
    await args.scheduler.schedule(next);
    return { status: 'pending', ...next, error: message };
  }
}

function retryIntent(
  backend: string,
  attempt: number,
  runtimeId: string | undefined,
  now: number,
  policy: SyncRetryPolicy,
): SyncRetryIntent {
  const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.max(0, attempt - 1));
  const intent: SyncRetryIntent = { backend, attempt, notBefore: now + delay };
  if (runtimeId !== undefined) {
    intent.runtimeId = runtimeId;
  }
  return intent;
}

/** A present `runtimeId` is the identity the retry's pull must still be talking to. */
function intentOf(row: SyncRetryRow): SyncRetryIntent {
  const intent: SyncRetryIntent = { backend: row.backend, attempt: row.attempt, notBefore: row.not_before };
  if (row.runtime_id !== null) {
    intent.runtimeId = row.runtime_id;
  }
  return intent;
}
