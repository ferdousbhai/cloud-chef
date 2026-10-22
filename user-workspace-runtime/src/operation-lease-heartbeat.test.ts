import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationLeaseHeartbeat } from './operation-lease-heartbeat';
import {
  WorkspaceOperationConflictError,
  WorkspaceOperationIndeterminateError,
  WorkspaceOperationLane,
  WorkspaceOperationLeaseExpiredError,
  type WorkspaceOperationLease,
} from './workspace-operation-lane';

const LEASE_MS = 10 * 60_000;
const TOOL_BUDGET_MS = 35 * 60_000;
const TICK_MS = LEASE_MS / 3;

describe('OperationLeaseHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries a silent command past the lease it would have died at', () => {
    const lane = createLane();
    const heartbeat = start(lane, lane.acquire(acquisition()));

    // A freshly generated project typechecks for longer than the exec lease and
    // prints nothing while it does. That must not look like an abandoned lane.
    advance(20 * 60_000);

    expect(() => lane.acquire(acquisition('other-operation'))).toThrow(WorkspaceOperationConflictError);
    expect(() => heartbeat.requireHeld()).not.toThrow();
  });

  it('lets a command that ran past its lease finish and keep its result', () => {
    const lane = createLane();
    const lease = lane.acquire(acquisition());
    const heartbeat = start(lane, lease);

    advance(25 * 60_000, () => heartbeat.observed());
    heartbeat.requireHeld();

    // The lane was still held on the operation's own terms the whole way, so its
    // release is an ordinary handover rather than a recovery from a stale owner.
    expect(lane.find('exec', lease.owner)?.deadline).toBeGreaterThan(Date.now());
    heartbeat.stop();
    lane.release(lease);
    expect(lane.acquire(acquisition('other-operation'))).toMatchObject({ recoveredOwner: null });
  });

  it('keeps renewing past the tool budget while output still proves the command alive', () => {
    const lane = createLane();
    const heartbeat = start(lane, lane.acquire(acquisition()));

    advance(TOOL_BUDGET_MS + 20 * 60_000, () => heartbeat.observed());

    expect(() => lane.acquire(acquisition('other-operation'))).toThrow(WorkspaceOperationConflictError);
  });

  it('stops renewing once a quiet command has outlived the budget above its lane', () => {
    const lane = createLane();
    start(lane, lane.acquire(acquisition()));

    advance(TOOL_BUDGET_MS + LEASE_MS + TICK_MS);

    expect(lane.acquire(acquisition('other-operation'))).toMatchObject({
      recoveredOwner: 'owner-exec',
    });
  });

  it('leaves an abandoned lane reclaimable after a single lease', () => {
    const lane = createLane();
    const heartbeat = start(lane, lane.acquire(acquisition()));
    // The owner died: no ticks ever run again, exactly as when a Durable Object
    // is evicted mid-operation.
    heartbeat.stop();
    vi.setSystemTime(LEASE_MS + 1);

    expect(lane.acquire(acquisition('other-operation'))).toMatchObject({ recoveredOwner: 'owner-exec' });
  });

  it('names a lease that expired under a still-running operation', () => {
    const lane = createLane();
    const heartbeat = start(lane, lane.acquire(acquisition()));

    // The Durable Object stalled straight through the lease before the tick ran.
    vi.setSystemTime(LEASE_MS + 1);
    vi.advanceTimersByTime(TICK_MS);

    expect(() => heartbeat.requireHeld()).toThrow(WorkspaceOperationLeaseExpiredError);
    expect(() => heartbeat.requireHeld()).toThrow(/still running when its 600s workspace lease expired/);
  });

  it('reports a lane taken by another owner as indeterminate, not merely expired', () => {
    const lane = createLane();
    const heartbeat = start(lane, lane.acquire(acquisition()));

    vi.setSystemTime(LEASE_MS + 1);
    lane.acquire(acquisition('other-operation'));
    vi.advanceTimersByTime(TICK_MS);

    expect(() => heartbeat.requireHeld()).toThrow(WorkspaceOperationIndeterminateError);
  });
});

function start(lane: WorkspaceOperationLane, lease: WorkspaceOperationLease) {
  return new OperationLeaseHeartbeat({ lane, lease, leaseMs: LEASE_MS, silenceHorizon: TOOL_BUDGET_MS });
}

/** Run the fake clock and the heartbeat's timers forward one tick at a time, calling `onTick` before each. */
function advance(durationMs: number, onTick?: () => void): void {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    onTick?.();
    vi.advanceTimersByTime(Math.min(TICK_MS, end - Date.now()));
  }
}

function acquisition(idempotencyKey = 'exec') {
  return { kind: 'exec', idempotencyKey, owner: `owner-${idempotencyKey}`, leaseMs: LEASE_MS };
}

function createLane() {
  const lane = new WorkspaceOperationLane(new TestStorage() as never);
  lane.initialize();
  return lane;
}

type LaneRow = {
  owner: string | null;
  idempotency_key: string | null;
  kind: string | null;
  acquired_at: number | null;
  deadline: number | null;
};

class TestStorage {
  row: LaneRow = { owner: null, idempotency_key: null, kind: null, acquired_at: null, deadline: null };
  readonly sql = {
    exec: <T>(query: string, ...bindings: unknown[]): T[] => {
      const normalized = query.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT owner')) {
        return [{ ...this.row }] as T[];
      }
      if (normalized.startsWith('UPDATE cloudchef_operation_lane SET owner = ?')) {
        this.row = {
          owner: String(bindings[0]),
          idempotency_key: String(bindings[1]),
          kind: String(bindings[2]),
          acquired_at: Number(bindings[3]),
          deadline: Number(bindings[4]),
        };
      } else if (normalized.startsWith('UPDATE cloudchef_operation_lane SET owner = NULL')) {
        if (this.row.owner === bindings[0]) {
          this.row = { ...this.row, owner: null, idempotency_key: null, kind: null, acquired_at: null, deadline: null };
        }
      } else if (normalized.startsWith('UPDATE cloudchef_operation_lane SET deadline = ?')) {
        if (this.row.owner === bindings[1] && this.row.idempotency_key === bindings[2]) {
          this.row = { ...this.row, deadline: Number(bindings[0]) };
        }
      }
      return [];
    },
  };

  transactionSync<T>(closure: () => T): T {
    const row = { ...this.row };
    try {
      return closure();
    } catch (error) {
      this.row = row;
      throw error;
    }
  }
}
