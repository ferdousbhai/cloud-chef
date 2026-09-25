import {
  WORKSPACE_OPERATION_CONFLICT_ERROR_CODE,
  workspaceOperationConflictMessage,
} from '../../cloudchef-agent/cloudflare-computer';
import type { ExecutionObservation } from './execution-reattach';
import { first } from './sql-rows';

const WORKSPACE_OPERATION_LEASE_MS = 15 * 60_000;

type OperationLaneStorage = Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type OperationLaneRow = {
  owner: string | null;
  idempotency_key: string | null;
  kind: string | null;
  acquired_at: number | null;
  deadline: number | null;
};

export type WorkspaceOperationLease = {
  owner: string;
  idempotencyKey: string;
  kind: string;
  acquiredAt: number;
  deadline: number;
  recoveredOwner: string | null;
};

type WorkspaceOperationHolder = {
  owner: string;
  idempotencyKey: string;
};

export class WorkspaceOperationConflictError extends Error {
  readonly code = WORKSPACE_OPERATION_CONFLICT_ERROR_CODE;

  constructor(
    readonly activeKind: string,
    readonly retryAfterMs: number,
  ) {
    super(workspaceOperationConflictMessage({ activeKind, retryAfterMs }));
    this.name = 'WorkspaceOperationConflictError';
  }
}

export class WorkspaceOperationIndeterminateError extends Error {
  readonly code = 'workspace_operation_indeterminate';

  constructor(readonly operationKind: string) {
    super(`The prior ${operationKind} operation was interrupted after it started and will not be repeated.`);
    this.name = 'WorkspaceOperationIndeterminateError';
  }
}

/**
 * The lease lapsed underneath an operation that was still running. This is not
 * the same condition as a lost lane: the lane record still names this owner, so
 * nothing else has taken the workspace, but the window in which another request
 * was entitled to reclaim it has already opened. Reporting it separately keeps
 * "the workspace could not be held long enough" from being read as "the outcome
 * is unknowable".
 */
export class WorkspaceOperationLeaseExpiredError extends Error {
  readonly code = 'workspace_operation_lease_expired';

  constructor(
    readonly operationKind: string,
    readonly leaseMs: number,
  ) {
    super(
      `The ${operationKind} operation was still running when its ${Math.round(leaseMs / 1_000)}s workspace lease expired, so the workspace lane became reclaimable by another request. Retry the operation.`,
    );
    this.name = 'WorkspaceOperationLeaseExpiredError';
  }
}

/**
 * Durable, fail-closed serialization for stateful ProjectWorkspace operations.
 *
 * Calls never wait inside the Durable Object. An occupied lane produces an
 * observable conflict so callers can retry without holding an RPC open. A
 * stale owner can be replaced by a different idempotency key, while replay of
 * the stale key remains indeterminate and therefore cannot repeat external
 * effects after eviction.
 */
export class WorkspaceOperationLane {
  constructor(
    private readonly storage: OperationLaneStorage,
    private readonly isOwnerActive: (owner: string) => boolean = () => false,
    private readonly canRecoverInterruptedOwner: (kind: string) => boolean = () => false,
  ) {}

  initialize(): void {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS cloudchef_operation_lane (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         owner TEXT,
         idempotency_key TEXT,
         kind TEXT,
         acquired_at INTEGER,
         deadline INTEGER
       )`,
    );
    this.storage.sql.exec(`INSERT OR IGNORE INTO cloudchef_operation_lane (singleton) VALUES (1)`);
  }

  acquire(args: {
    owner: string;
    idempotencyKey: string;
    kind: string;
    now?: number;
    leaseMs?: number;
    /**
     * The caller is adopting the external effect this lane's own key already started, not starting
     * it again. Only that caller may re-enter an occupied lane under its own key, and only while
     * the owner it is replacing is no longer running here.
     */
    resume?: boolean;
    /**
     * The caller observed, outside this transaction, that this exact holder's external effect has
     * already finished, so its lease no longer protects anything. It applies only while the lane
     * still names that owner and key and the owner is no longer running here (#143).
     */
    settledHolder?: WorkspaceOperationHolder;
  }): WorkspaceOperationLease {
    const result = this.storage.transactionSync<
      WorkspaceOperationLease | { error: WorkspaceOperationConflictError | WorkspaceOperationIndeterminateError }
    >(() => {
      const now = args.now ?? Date.now();
      const leaseMs = args.leaseMs ?? WORKSPACE_OPERATION_LEASE_MS;
      const current = this.read();
      let recoveredOwner: string | null = null;

      const ownerIsActive = current.owner ? this.isOwnerActive(current.owner) : false;
      const canRecoverBeforeDeadline =
        !ownerIsActive && current.kind !== null && this.canRecoverInterruptedOwner(current.kind);
      const resuming = args.resume === true && !ownerIsActive && current.idempotency_key === args.idempotencyKey;
      const holderSettled =
        !ownerIsActive &&
        args.settledHolder !== undefined &&
        current.owner === args.settledHolder.owner &&
        current.idempotency_key === args.settledHolder.idempotencyKey;
      if (
        current.owner &&
        current.deadline !== null &&
        (ownerIsActive || (current.deadline > now && !canRecoverBeforeDeadline && !resuming && !holderSettled))
      ) {
        return {
          error: new WorkspaceOperationConflictError(
            current.kind ?? 'stateful operation',
            Math.max(1_000, current.deadline - now),
          ),
        };
      }

      if (current.owner) {
        if (current.idempotency_key === args.idempotencyKey && !resuming) {
          return { error: new WorkspaceOperationIndeterminateError(current.kind ?? args.kind) };
        }
        recoveredOwner = current.owner;
      }

      const deadline = now + leaseMs;
      this.storage.sql.exec(
        `UPDATE cloudchef_operation_lane
         SET owner = ?, idempotency_key = ?, kind = ?, acquired_at = ?, deadline = ?
         WHERE singleton = 1`,
        args.owner,
        args.idempotencyKey,
        args.kind,
        now,
        deadline,
      );
      return {
        owner: args.owner,
        idempotencyKey: args.idempotencyKey,
        kind: args.kind,
        acquiredAt: now,
        deadline,
        recoveredOwner,
      };
    });
    if ('error' in result) {
      throw result.error;
    }
    return result;
  }

  /** The operation currently holding the lane, if any, without claiming or renewing it. */
  holder(): (WorkspaceOperationHolder & { kind: string; deadline: number }) | null {
    const row = this.read();
    if (row.owner === null || row.idempotency_key === null || row.kind === null || row.deadline === null) {
      return null;
    }
    return { owner: row.owner, idempotencyKey: row.idempotency_key, kind: row.kind, deadline: row.deadline };
  }

  release(lease: WorkspaceOperationLease): void {
    this.storage.sql.exec(
      `UPDATE cloudchef_operation_lane
       SET owner = NULL, idempotency_key = NULL, kind = NULL, acquired_at = NULL, deadline = NULL
       WHERE singleton = 1 AND owner = ?`,
      lease.owner,
    );
  }

  find(idempotencyKey: string, owner: string): WorkspaceOperationLease | null {
    const row = this.read();
    if (
      row.owner !== owner ||
      row.idempotency_key !== idempotencyKey ||
      row.kind === null ||
      row.acquired_at === null ||
      row.deadline === null
    ) {
      return null;
    }
    return {
      owner,
      idempotencyKey,
      kind: row.kind,
      acquiredAt: row.acquired_at,
      deadline: row.deadline,
      recoveredOwner: null,
    };
  }

  renew(lease: WorkspaceOperationLease, leaseMs: number, now = Date.now()): WorkspaceOperationLease {
    return this.storage.transactionSync(() => {
      const current = this.read();
      if (
        current.owner !== lease.owner ||
        current.idempotency_key !== lease.idempotencyKey ||
        current.deadline === null
      ) {
        throw new WorkspaceOperationIndeterminateError(lease.kind);
      }
      if (current.deadline <= now) {
        throw new WorkspaceOperationLeaseExpiredError(lease.kind, leaseMs);
      }
      const renewed = { ...lease, deadline: now + leaseMs };
      this.storage.sql.exec(
        `UPDATE cloudchef_operation_lane SET deadline = ?
         WHERE singleton = 1 AND owner = ? AND idempotency_key = ?`,
        renewed.deadline,
        lease.owner,
        lease.idempotencyKey,
      );
      return renewed;
    });
  }

  private read(): OperationLaneRow {
    return (
      first(
        this.storage.sql.exec<OperationLaneRow>(
          `SELECT owner, idempotency_key, kind, acquired_at, deadline
           FROM cloudchef_operation_lane WHERE singleton = 1`,
        ),
      ) ?? {
        owner: null,
        idempotency_key: null,
        kind: null,
        acquired_at: null,
        deadline: null,
      }
    );
  }
}

/**
 * An exec lane whose owner died with a previous instance stays leased because its command may still
 * be running in the container, which outlives the reset (#143). When the container shows that the
 * command has finished, the lease protects nothing, so name the holder as reclaimable. A running or
 * unobservable command keeps the lease until its deadline, exactly as before. Only an exec holder
 * is probed, only for a different key (the same key must resume, never replay), and only while its
 * deadline has not already made it reclaimable.
 */
export async function findSettledExecHolder(args: {
  holder: ReturnType<WorkspaceOperationLane['holder']>;
  idempotencyKey: string;
  now: number;
  isOwnerActive: (owner: string) => boolean;
  observe: (executionId: string) => Promise<ExecutionObservation>;
}): Promise<WorkspaceOperationHolder | undefined> {
  const { holder } = args;
  if (
    !holder ||
    holder.kind !== 'exec' ||
    holder.idempotencyKey === args.idempotencyKey ||
    holder.deadline <= args.now ||
    args.isOwnerActive(holder.owner)
  ) {
    return undefined;
  }
  // The exec lane's key is the id its command runs under in the container.
  const observation = await args.observe(holder.idempotencyKey).catch((): ExecutionObservation => 'unobservable');
  return observation === 'finished' ? { owner: holder.owner, idempotencyKey: holder.idempotencyKey } : undefined;
}
