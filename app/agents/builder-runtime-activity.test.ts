import { describe, expect, it, vi } from 'vitest';
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
const START = 10 * 60 * 60_000;

describe('builder agent runtime activity', () => {
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
    let now = START;
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a', now: () => now });
    const row = () => database.prepare('SELECT busy, updated_at FROM runtime_activity').all();

    await activity.observe(true);
    now += 1_000;
    await activity.observe(true);
    expect(row()).toEqual([{ busy: 1, updated_at: START }]);

    now = START + RUNTIME_BUSY_RENEWAL_MS;
    await activity.observe(true);
    expect(row()).toEqual([{ busy: 1, updated_at: START + RUNTIME_BUSY_RENEWAL_MS }]);

    now += 1_000;
    await activity.observe(false);
    now += 1_000;
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
    let now = START;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now });
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a', now: () => now, sleep });

    await activity.admit();

    expect(sleep).toHaveBeenCalled();
    expect(now).toBe(START + RUNTIME_UPGRADE_WINDOW_MS);
  });

  it('holds work back while the upgrade keeps its window, and starts it once the upgrade releases it', async () => {
    const { db } = userWorkspaceDatabase();
    let now = START;
    // The new Worker is deployed and its container image rolling out: the upgrade renews its window
    // every minute.
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      if ((now - START) % 60_000 === 0) {
        await holdRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now });
      }
      if (now === START + RUNTIME_UPGRADE_WINDOW_MS + 10_000) {
        await releaseRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION });
      }
    });
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now });
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a', now: () => now, sleep });

    await activity.admit();

    // Past the claimed window (renewed) and not a moment past the release.
    expect(now).toBe(START + RUNTIME_UPGRADE_WINDOW_MS + 10_000);
  });

  it('gives up waiting on an upgrade that keeps renewing its window past the limit of the work, and says so', async () => {
    const { db, database } = userWorkspaceDatabase();
    let now = START;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      // The upgrade renews its window every minute, and never finishes.
      if ((now - START) % 60_000 === 0) {
        await holdRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now });
      }
    });
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now });
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a', now: () => now, sleep });
    const waiting: boolean[] = [];

    await expect(
      activity.admit({ maxWaitMs: 3 * 60_000, onWaiting: (value) => waiting.push(value) }),
    ).rejects.toBeInstanceOf(RuntimeUpgradeWaitExceededError);

    expect(now).toBe(START + 3 * 60_000);
    expect(waiting).toEqual([true, false]);
    // It never started, so it no longer counts.
    await vi.waitFor(() => expect(database.prepare('SELECT busy FROM runtime_activity').get()?.busy).toBe(0));
  });

  it('a stop calls the wait off at once', async () => {
    const { db } = userWorkspaceDatabase();
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: Date.now() });
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
    const activity = new BuilderRuntimeActivity({ db, agentName: () => 'chat-a', now: () => START });

    await activity.admit();

    await expect(claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: START + 1_000 })).resolves.toEqual({
      granted: false,
      busy: 1,
    });
  });

  it('does not start work it could not record until the record is written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = userWorkspaceDatabase();
    let now = START;
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
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const activity = new BuilderRuntimeActivity({ db: flaky, agentName: () => 'chat-a', now: () => now, sleep });

    await activity.admit();

    expect(sleep).toHaveBeenCalledTimes(3);
    await expect(claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now })).resolves.toMatchObject({
      granted: false,
    });
    warn.mockRestore();
  });

  it('starts work anyway once the database has stayed unavailable for a while', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let now = START;
    const failing: Pick<D1Database, 'prepare'> = {
      prepare: () => {
        throw new Error('D1 is unavailable');
      },
    };
    const activity = new BuilderRuntimeActivity({
      db: failing,
      agentName: () => 'chat-a',
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(activity.run(async () => 'done')).resolves.toBe('done');
    expect(now).toBe(START + UNRECORDED_ADMISSION_WAIT_MS);
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
