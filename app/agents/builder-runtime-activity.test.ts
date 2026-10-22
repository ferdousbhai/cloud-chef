import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareExecutionPublicState, CloudflareExecutionStatus } from 'cloudchef-agent/cloudflare-api';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import {
  claimRuntimeUpgradeWindow,
  holdRuntimeUpgradeWindow,
  releaseRuntimeUpgradeWindow,
  RUNTIME_BUSY_RENEWAL_MS,
  RUNTIME_UPGRADE_WINDOW_MS,
} from '~/lib/.server/cloudflare/user-workspace-runtime-activity';
import { idleBuilderPreviewState } from './builder-preview-types';
import {
  BuilderRuntimeActivity,
  isBuilderAgentBusy,
  RuntimeUpgradeWaitExceededError,
  UNRECORDED_ADMISSION_WAIT_MS,
} from './builder-runtime-activity';
import { createBuilderTurn } from './builder-turn-state';

const NEW_VERSION = 'b'.repeat(64);
const HOLDER = 'workspace-upgrade';
const START = 10 * 60 * 60_000;

/** When `work` settled, by the clock, and how. */
function settledAt<T>(work: Promise<T>): Promise<{ at: number; value?: T; error?: Error }> {
  return work.then(
    (value) => ({ at: Date.now(), value }),
    (error: Error) => ({ at: Date.now(), error }),
  );
}

describe('builder agent runtime activity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts only the agent's own turn from its state", () => {
    expect(isBuilderAgentBusy(undefined)).toBe(false);
    expect(isBuilderAgentBusy({ activeTurn: null, preview: idleBuilderPreviewState(), deployment: null })).toBe(false);
    expect(isBuilderAgentBusy({ activeTurn: createBuilderTurn('request-1') })).toBe(true);
    expect(isBuilderAgentBusy({ validationProgress: { toolCallId: 'tool-1', stage: 'installing' } })).toBe(true);
    // Records other paths rewrite while the work behind them continues are not what counts: that work is
    // counted while it runs.
    expect(
      isBuilderAgentBusy({ publication: { lane: 'preview', message: 'Uploading', percent: 40, updatedAt: 1 } }),
    ).toBe(false);
    expect(isBuilderAgentBusy({ preview: { ...idleBuilderPreviewState(), status: 'building' } })).toBe(false);
    expect(isBuilderAgentBusy({ deployment: { status: 'deploying' } })).toBe(false);
    expect(isBuilderAgentBusy({ cloudflareExecutions: [execution('executing')] })).toBe(false);
  });

  it('writes only when the agent turns busy or idle, and renews a long busy stretch', async () => {
    const { db, database } = userWorkspaceDatabase();
    vi.useFakeTimers({ toFake: ['Date'], now: START });
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a' });
    const row = () => database.prepare('SELECT busy, updated_at FROM runtime_activity').all();

    await activity.observe(true);
    vi.setSystemTime(START + 1_000);
    await activity.observe(true);
    expect(row()).toEqual([{ busy: 1, updated_at: START }]);

    vi.setSystemTime(START + RUNTIME_BUSY_RENEWAL_MS);
    await activity.observe(true);
    expect(row()).toEqual([{ busy: 1, updated_at: START + RUNTIME_BUSY_RENEWAL_MS }]);

    vi.setSystemTime(START + RUNTIME_BUSY_RENEWAL_MS + 1_000);
    await activity.observe(false);
    vi.setSystemTime(START + RUNTIME_BUSY_RENEWAL_MS + 2_000);
    await activity.observe(false);
    expect(row()).toEqual([{ busy: 0, updated_at: START + RUNTIME_BUSY_RENEWAL_MS + 1_000 }]);
  });

  it('counts work busy until it settles, whatever the state says meanwhile', async () => {
    const { db, database } = userWorkspaceDatabase();
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a' });
    const busy = () => database.prepare('SELECT busy FROM runtime_activity').get()?.busy;
    let finish: () => void = () => undefined;

    const work = activity.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.waitFor(() => expect(busy()).toBe(1));
    // An editor save clears the deployment record; a cancelled preview reads cancelled. The work runs on.
    await activity.observe(false);
    expect(busy()).toBe(1);

    finish();
    await work;
    await activity.observe(false);
    expect(busy()).toBe(0);
  });

  it('holds back work starting inside an upgrade window until the window closes', async () => {
    const { db } = userWorkspaceDatabase();
    vi.useFakeTimers({ now: START });
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: START });
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a' });

    const admitted = settledAt(activity.admit());
    await vi.runAllTimersAsync();

    expect(await admitted).toEqual({ at: START + RUNTIME_UPGRADE_WINDOW_MS, value: undefined });
  });

  it('holds work back while the upgrade keeps its window, and starts it once the upgrade releases it', async () => {
    const { db } = userWorkspaceDatabase();
    vi.useFakeTimers({ now: START });
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: START });
    // The new Worker is deployed and its container image rolling out: the upgrade renews its window
    // every minute, then releases it.
    const renewals = setInterval(
      () => void holdRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: Date.now() }),
      60_000,
    );
    setTimeout(() => {
      clearInterval(renewals);
      void releaseRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER });
    }, RUNTIME_UPGRADE_WINDOW_MS + 10_000);
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a' });

    const admitted = settledAt(activity.admit());
    await vi.runAllTimersAsync();

    // Past the claimed window (renewed) and not a moment past the release.
    expect(await admitted).toEqual({ at: START + RUNTIME_UPGRADE_WINDOW_MS + 10_000, value: undefined });
  });

  it('gives up waiting on an upgrade that keeps renewing its window past the limit of the work, and says so', async () => {
    const { db, database } = userWorkspaceDatabase();
    vi.useFakeTimers({ now: START });
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: START });
    // The upgrade renews its window every minute, and never finishes.
    const renewals = setInterval(
      () => void holdRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: Date.now() }),
      60_000,
    );
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a' });
    const waiting: boolean[] = [];

    const admitted = settledAt(activity.admit({ maxWaitMs: 3 * 60_000, onWaiting: (value) => waiting.push(value) }));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    clearInterval(renewals);

    const { at, error } = await admitted;
    expect(error).toBeInstanceOf(RuntimeUpgradeWaitExceededError);
    expect(at).toBe(START + 3 * 60_000);
    expect(waiting).toEqual([true, false]);
    // It never started, so it no longer counts.
    await vi.waitFor(() => expect(database.prepare('SELECT busy FROM runtime_activity').get()?.busy).toBe(0));
  });

  it('a stop calls the wait off at once', async () => {
    const { db } = userWorkspaceDatabase();
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: Date.now() });
    // Real time: the poll would otherwise sleep its full second.
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a' });
    const stop = new AbortController();
    const waiting: boolean[] = [];
    const work = vi.fn(async () => undefined);

    const admitted = activity.run(work, { signal: stop.signal, onWaiting: (value) => waiting.push(value) });
    await vi.waitFor(() => expect(waiting).toEqual([true]));
    const stoppedAt = Date.now();
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    stop.abort(new Error('Stopped by the person'));

    await expect(admitted).rejects.toThrow('Stopped by the person');
    expect(Date.now() - stoppedAt).toBeLessThan(500);
    // The poll's timer ends with the wait instead of running out its second.
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
    expect(work).not.toHaveBeenCalled();
    expect(waiting).toEqual([true, false]);
  });

  it('records work before it starts, so an upgrade claimed after that is refused', async () => {
    const { db } = userWorkspaceDatabase();
    vi.useFakeTimers({ toFake: ['Date'], now: START });
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a' });

    await activity.admit();

    await expect(
      claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: START + 1_000 }),
    ).resolves.toEqual({
      granted: false,
      busy: 1,
    });
  });

  it('does not start work it could not record until the record is written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = userWorkspaceDatabase();
    vi.useFakeTimers({ now: START });
    let failures = 3;
    const flaky: Pick<D1Database, 'prepare'> = {
      prepare: (query) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('D1 is unavailable');
        }
        return db.prepare(query);
      },
    };
    const activity = new BuilderRuntimeActivity({ db: flaky, agentName: () => 'chat-a' });

    const admitted = settledAt(activity.admit());
    await vi.runAllTimersAsync();

    // A poll's wait after each of the three failed writes.
    expect(await admitted).toEqual({ at: START + 3 * 1_000, value: undefined });
    await expect(
      claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, holder: HOLDER, now: Date.now() }),
    ).resolves.toMatchObject({
      granted: false,
    });
    warn.mockRestore();
  });

  it('starts work anyway once the database has stayed unavailable for a while', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers({ now: START });
    const failing: Pick<D1Database, 'prepare'> = {
      prepare: () => {
        throw new Error('D1 is unavailable');
      },
    };
    const activity = new BuilderRuntimeActivity({ db: failing, agentName: () => 'chat-a' });

    const ran = settledAt(activity.run(async () => 'done'));
    await vi.runAllTimersAsync();

    expect(await ran).toEqual({ at: START + UNRECORDED_ADMISSION_WAIT_MS, value: 'done' });
    warn.mockRestore();
  });
});

function execution(status: CloudflareExecutionStatus): CloudflareExecutionPublicState {
  return {
    executionId: 'execution-1',
    toolCallId: 'tool-1',
    accountId: 'account-1',
    proposalSha256: 'c'.repeat(64),
    status,
    createdAt: 1,
    decidedAt: null,
    startedAt: null,
    completedAt: null,
    expiresAt: 2,
    outcome: null,
  };
}
