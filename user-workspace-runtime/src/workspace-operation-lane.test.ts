import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExecutionObservation } from './execution-reattach';
import {
  findSettledExecHolder,
  WorkspaceOperationConflictError,
  WorkspaceOperationIndeterminateError,
  WorkspaceOperationLane,
  WorkspaceOperationLeaseExpiredError,
} from './workspace-operation-lane';

describe('WorkspaceOperationLane', () => {
  it('rejects simultaneous stateful operations with observable retry timing', () => {
    const storage = new TestStorage();
    const lane = new WorkspaceOperationLane(storage as never);
    lane.initialize();
    lane.acquire(operation('validate', 'validation-a', 100));

    expect(() => lane.acquire(operation('editor-write', 'write-b', 200))).toThrow(WorkspaceOperationConflictError);
    try {
      lane.acquire(operation('editor-write', 'write-b', 200));
    } catch (error) {
      expect(error).toMatchObject({ code: 'workspace_operation_conflict', retryAfterMs: 1_000 });
    }
  });

  it('records every conflict the ProjectWorkspace admission path rejects', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('private async withStatefulOperation<T>(');
    const acquisition = source.slice(start, source.indexOf('\n  private ', start + 1));

    expect(acquisition).toContain("console.info('ProjectWorkspace operation lane conflict'");
    expect(acquisition).toContain('activeKind: error.activeKind');
    expect(acquisition).toContain('retryAfterMs: error.retryAfterMs');
    // The container probe for a settled interrupted exec must feed the claim acquisition re-checks.
    expect(acquisition).toContain('const settledHolder = await findSettledExecHolder(');
    expect(acquisition).toContain('settledHolder,');
  });

  it('recovers a stale owner for a different operation but never replays the stale idempotency key', () => {
    const lane = createLane();
    lane.acquire(operation('exec', 'tool-a', 100, 50));

    expect(() => lane.acquire(operation('exec', 'tool-a', 151))).toThrow(WorkspaceOperationIndeterminateError);

    const recovered = lane.acquire(operation('delete', 'delete-b', 152));
    expect(recovered.recoveredOwner).toBe('owner-exec-tool-a');
  });

  it('uses runtime liveness to recover an interrupted owner before its deadline', () => {
    let active = true;
    const storage = new TestStorage();
    const lane = new WorkspaceOperationLane(
      storage as never,
      () => active,
      (kind) => kind === 'validate',
    );
    lane.initialize();
    lane.acquire(operation('validate', 'validation-a', 100, 30 * 60_000));

    active = false;
    expect(() => lane.acquire(operation('validate', 'validation-a', 200))).toThrow(
      WorkspaceOperationIndeterminateError,
    );
    expect(lane.acquire(operation('validate', 'validation-b', 201))).toMatchObject({
      recoveredOwner: 'owner-validate-validation-a',
    });
  });

  it('recovers an interrupted preview before it can block foreground work', () => {
    const storage = new TestStorage();
    const lane = new WorkspaceOperationLane(
      storage as never,
      () => false,
      (kind) => kind === 'validate' || kind === 'preview',
    );
    lane.initialize();
    lane.acquire(operation('preview', 'preview-a', 100, 15 * 60_000));

    expect(lane.acquire(operation('validate', 'validation-b', 200))).toMatchObject({
      recoveredOwner: 'owner-preview-preview-a',
    });
  });

  it('keeps interrupted mutating operations leased until their deadline', () => {
    const lane = new WorkspaceOperationLane(
      new TestStorage() as never,
      () => false,
      (kind) => kind === 'validate',
    );
    lane.initialize();
    lane.acquire(operation('exec', 'exec-a', 100, 30 * 60_000));

    expect(() => lane.acquire(operation('write', 'write-b', 200))).toThrow(WorkspaceOperationConflictError);
  });

  it('never treats a still-executing owner as stale solely because its deadline passed', () => {
    let activeOwner: string | null = 'owner-deployment-deploy-a';
    const storage = new TestStorage();
    const lane = new WorkspaceOperationLane(storage as never, (owner) => owner === activeOwner);
    lane.initialize();
    lane.acquire(operation('deployment', 'deploy-a', 0, 15 * 60_000));

    expect(() => lane.acquire(operation('write', 'write-b', 16 * 60_000))).toThrow(WorkspaceOperationConflictError);

    activeOwner = null;
    expect(lane.acquire(operation('write', 'write-b', 16 * 60_000))).toMatchObject({
      recoveredOwner: 'owner-deployment-deploy-a',
    });
  });

  it('lets an interrupted operation re-enter its own lane to adopt the effect it already started', () => {
    const lane = createLane();
    lane.acquire(operation('exec', 'tool-a', 100, 10 * 60_000));

    // Without the resumption claim the stale key is refused for the whole lease and stays
    // indeterminate after it, because repeating it would repeat the command. With it the same
    // operation takes its own lane back and adopts what that command already did.
    expect(() => lane.acquire(operation('exec', 'tool-a', 200))).toThrow(WorkspaceOperationConflictError);
    expect(() => lane.acquire(operation('exec', 'tool-a', 100 + 10 * 60_000 + 1))).toThrow(
      WorkspaceOperationIndeterminateError,
    );
    expect(lane.acquire({ ...operation('exec', 'tool-a', 200), owner: 'owner-resumed', resume: true })).toMatchObject({
      owner: 'owner-resumed',
      recoveredOwner: 'owner-exec-tool-a',
    });
  });

  it('refuses to resume a lane whose owner is still running here', () => {
    const storage = new TestStorage();
    const lane = new WorkspaceOperationLane(storage as never, () => true);
    lane.initialize();
    lane.acquire(operation('exec', 'tool-a', 100, 10 * 60_000));

    expect(() => lane.acquire({ ...operation('exec', 'tool-a', 200), owner: 'owner-resumed', resume: true })).toThrow(
      WorkspaceOperationConflictError,
    );
  });

  it('never lets a resumption claim take a lane a different operation holds', () => {
    const lane = createLane();
    lane.acquire(operation('deployment', 'deploy-a', 100, 45 * 60_000));

    expect(() => lane.acquire({ ...operation('exec', 'tool-b', 200), resume: true })).toThrow(
      WorkspaceOperationConflictError,
    );
  });

  it('releases only the current owner and permits the next operation', () => {
    const lane = createLane();
    const first = lane.acquire(operation('preview', 'preview-a', 100));
    lane.release({ ...first, owner: 'not-the-owner' });
    expect(() => lane.acquire(operation('write', 'write-b', 111))).toThrow(WorkspaceOperationConflictError);

    lane.release(first);
    expect(lane.acquire(operation('write', 'write-b', 113))).toMatchObject({ kind: 'write' });
  });

  it('finds and renews a durable external-operation lease without changing its owner', () => {
    const lane = createLane();
    const lease = lane.acquire(operation('deployment', 'deploy-a', 100, 1_000));

    expect(lane.find('deploy-a', 'owner-deployment-deploy-a')).toEqual(lease);
    const renewed = lane.renew(lease, 5_000, 500);
    expect(renewed.deadline).toBe(5_500);
    expect(lane.find('deploy-a', lease.owner)).toEqual(renewed);
  });

  it('names a lease that lapsed under its own still-running operation', () => {
    const lane = createLane();
    const lease = lane.acquire(operation('exec', 'exec-a', 100, 1_000));

    expect(() => lane.renew(lease, 1_000, 1_101)).toThrow(WorkspaceOperationLeaseExpiredError);
    expect(() => lane.renew(lease, 1_000, 1_101)).toThrow(/still running when its 1s workspace lease expired/);
  });

  it('separates a lapsed lease from a lane another operation has taken', () => {
    const lane = createLane();
    const lease = lane.acquire(operation('exec', 'exec-a', 100, 1_000));
    lane.acquire(operation('write', 'write-b', 1_101));

    expect(() => lane.renew(lease, 1_000, 1_102)).toThrow(WorkspaceOperationIndeterminateError);
  });
});

describe('reclaiming an exec lane whose interrupted command settled (#143)', () => {
  const EXEC_LEASE_MS = 10 * 60_000;

  function laneHeldByInterruptedExec() {
    // The owner died with the previous instance, so nothing here reports it active.
    const lane = createLane();
    lane.acquire(operation('exec', 'tool:call-a', 100, EXEC_LEASE_MS));
    return lane;
  }

  async function acquireAfterProbe(lane: WorkspaceOperationLane, observation: ExecutionObservation, now = 200) {
    const observed: string[] = [];
    const settledHolder = await findSettledExecHolder({
      holder: lane.holder(),
      idempotencyKey: 'tool:call-b',
      now,
      isOwnerActive: () => false,
      observe: (executionId) => {
        observed.push(executionId);
        return Promise.resolve(observation);
      },
    });
    return { observed, acquire: () => lane.acquire({ ...operation('exec', 'tool:call-b', now), settledHolder }) };
  }

  it('reclaims the lane at once when the container shows the command finished', async () => {
    const lane = laneHeldByInterruptedExec();
    const { observed, acquire } = await acquireAfterProbe(lane, 'finished');

    expect(observed).toEqual(['tool:call-a']);
    expect(acquire()).toMatchObject({ owner: 'owner-exec-tool:call-b', recoveredOwner: 'owner-exec-tool:call-a' });
  });

  it.each<ExecutionObservation>(['running', 'unobservable'])(
    'keeps the lane leased until its deadline when the command is %s',
    async (observation) => {
      const lane = laneHeldByInterruptedExec();
      const { acquire } = await acquireAfterProbe(lane, observation);

      expect(acquire).toThrow(WorkspaceOperationConflictError);
    },
  );

  it('treats a probe that throws as unobservable', async () => {
    const lane = laneHeldByInterruptedExec();
    const settledHolder = await findSettledExecHolder({
      holder: lane.holder(),
      idempotencyKey: 'tool:call-b',
      now: 200,
      isOwnerActive: () => false,
      observe: () => Promise.reject(new Error('Container service disconnected')),
    });

    expect(settledHolder).toBeUndefined();
  });

  it('never probes a holder that is running here, is not an exec, has the same key, or already expired', async () => {
    const observe = () => Promise.reject(new Error('must not probe'));
    const lane = laneHeldByInterruptedExec();
    const holder = lane.holder();

    expect(
      await findSettledExecHolder({
        holder,
        idempotencyKey: 'tool:call-b',
        now: 200,
        isOwnerActive: () => true,
        observe,
      }),
    ).toBeUndefined();
    expect(
      await findSettledExecHolder({
        holder: holder && { ...holder, kind: 'install' },
        idempotencyKey: 'tool:call-b',
        now: 200,
        isOwnerActive: () => false,
        observe,
      }),
    ).toBeUndefined();
    // The same key must resume its own command, never be handed a lane that would replay it.
    expect(
      await findSettledExecHolder({
        holder,
        idempotencyKey: 'tool:call-a',
        now: 200,
        isOwnerActive: () => false,
        observe,
      }),
    ).toBeUndefined();
    expect(
      await findSettledExecHolder({
        holder,
        idempotencyKey: 'tool:call-b',
        now: 100 + EXEC_LEASE_MS,
        isOwnerActive: () => false,
        observe,
      }),
    ).toBeUndefined();
  });

  it('refuses a settlement claim for a holder the lane no longer names', async () => {
    const lane = laneHeldByInterruptedExec();
    const { acquire } = await acquireAfterProbe(lane, 'finished');
    // Between the probe and the claim, the dead owner resumed under its own key.
    lane.acquire({ ...operation('exec', 'tool:call-a', 150), owner: 'owner-resumed', resume: true });

    expect(acquire).toThrow(WorkspaceOperationConflictError);
  });
});

function operation(kind: string, idempotencyKey: string, now: number, leaseMs = 1_000) {
  return { kind, idempotencyKey, owner: `owner-${kind}-${idempotencyKey}`, now, leaseMs };
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
  row: LaneRow = {
    owner: null,
    idempotency_key: null,
    kind: null,
    acquired_at: null,
    deadline: null,
  };
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
