import { describe, expect, it, vi } from 'vitest';
import type { CloudflareExecutionPublicState, CloudflareExecutionStatus } from 'cloudchef-agent/cloudflare-api';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import {
  claimRuntimeUpgradeWindow,
  RUNTIME_BUSY_RENEWAL_MS,
  RUNTIME_UPGRADE_WINDOW_MS,
} from '~/lib/.server/cloudflare/user-workspace-runtime-activity';
import { idleBuilderPreviewState } from './builder-preview-types';
import { BuilderRuntimeActivity, isBuilderAgentBusy } from './builder-runtime-activity';
import { createBuilderTurn } from './builder-turn-state';

const OLD_VERSION = 'a'.repeat(64);
const NEW_VERSION = 'b'.repeat(64);
const START = 10 * 60 * 60_000;

describe('builder agent runtime activity', () => {
  it('counts every kind of work a redeploy would cut off as busy, and nothing else', () => {
    expect(isBuilderAgentBusy(undefined)).toBe(false);
    expect(isBuilderAgentBusy({ activeTurn: null, preview: idleBuilderPreviewState(), deployment: null })).toBe(false);
    expect(isBuilderAgentBusy({ activeTurn: createBuilderTurn('request-1') })).toBe(true);
    expect(isBuilderAgentBusy({ validationProgress: { toolCallId: 'tool-1', stage: 'installing' } })).toBe(true);
    expect(
      isBuilderAgentBusy({ publication: { lane: 'preview', message: 'Uploading', percent: 40, updatedAt: 1 } }),
    ).toBe(true);
    expect(isBuilderAgentBusy({ preview: { ...idleBuilderPreviewState(), status: 'queued' } })).toBe(true);
    expect(isBuilderAgentBusy({ preview: { ...idleBuilderPreviewState(), status: 'building' } })).toBe(true);
    expect(isBuilderAgentBusy({ preview: { ...idleBuilderPreviewState(), status: 'ready' } })).toBe(false);
    expect(isBuilderAgentBusy({ deployment: { status: 'deploying' } })).toBe(true);
    expect(isBuilderAgentBusy({ deployment: { status: 'failed' } })).toBe(false);
    expect(isBuilderAgentBusy({ cloudflareExecutions: [execution('executing')] })).toBe(true);
    expect(isBuilderAgentBusy({ cloudflareExecutions: [execution('approved')] })).toBe(true);
    // A proposal waiting for its owner's decision can wait through a redeploy: it is durable.
    expect(isBuilderAgentBusy({ cloudflareExecutions: [execution('awaiting_approval')] })).toBe(false);
  });

  it('writes only when the agent turns busy or idle, and renews a long busy stretch', async () => {
    const { db, database } = userWorkspaceDatabase();
    let now = START;
    const activity = new BuilderRuntimeActivity({
      db,
      agentName: () => 'chat-a',
      runtimeVersion: OLD_VERSION,
      now: () => now,
    });
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

  it('holds back work starting inside an upgrade window until the window closes', async () => {
    const { db } = userWorkspaceDatabase();
    let now = START;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now });
    const activity = new BuilderRuntimeActivity({
      db,
      agentName: () => 'chat-a',
      runtimeVersion: OLD_VERSION,
      now: () => now,
      sleep,
    });

    await activity.admit();

    expect(sleep).toHaveBeenCalled();
    expect(now).toBe(START + RUNTIME_UPGRADE_WINDOW_MS);
  });

  it('starts work at once on the version the window is upgrading to', async () => {
    const { db } = userWorkspaceDatabase();
    const sleep = vi.fn(async () => undefined);
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: START });
    const activity = new BuilderRuntimeActivity({
      db,
      agentName: () => 'chat-a',
      runtimeVersion: NEW_VERSION,
      now: () => START,
      sleep,
    });

    await activity.admit();

    expect(sleep).not.toHaveBeenCalled();
  });

  it('records work before it starts, so an upgrade claimed after that is refused', async () => {
    const { db } = userWorkspaceDatabase();
    const activity = new BuilderRuntimeActivity({
      db,
      agentName: () => 'chat-a',
      runtimeVersion: OLD_VERSION,
      now: () => START,
    });

    await activity.admit();

    await expect(claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: START + 1_000 })).resolves.toEqual({
      granted: false,
      busy: 1,
    });
  });

  it('never fails the work it records when the database does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing: Pick<D1Database, 'prepare'> = {
      prepare: () => {
        throw new Error('D1 is unavailable');
      },
    };
    const activity = new BuilderRuntimeActivity({
      db: failing,
      agentName: () => 'chat-a',
      runtimeVersion: OLD_VERSION,
    });

    await expect(activity.admit()).resolves.toBeUndefined();
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
