import { describe, expect, it } from 'vitest';
import { userWorkspaceDatabase } from '~/test/control-plane-d1';
import {
  claimRuntimeUpgradeWindow,
  readRuntimeUpgradeWindow,
  recordRuntimeActivity,
  RUNTIME_BUSY_LEASE_MS,
  RUNTIME_QUIET_PERIOD_MS,
  RUNTIME_UPGRADE_WINDOW_MS,
} from './user-workspace-runtime-activity';

const NEW_VERSION = 'b'.repeat(64);
const NOW = 10 * 60 * 60_000;

describe('workspace runtime activity', () => {
  it('grants an upgrade window to a workspace where nothing has run', async () => {
    const { db } = userWorkspaceDatabase();

    await expect(claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: NOW })).resolves.toEqual({
      granted: true,
    });
    await expect(readRuntimeUpgradeWindow(db, NOW)).resolves.toEqual({
      targetVersion: NEW_VERSION,
      expiresAt: NOW + RUNTIME_UPGRADE_WINDOW_MS,
    });
  });

  it('refuses the window while any agent is working, and says how many are', async () => {
    const { db } = userWorkspaceDatabase();
    await recordRuntimeActivity(db, { agentName: 'chat-a', busy: true, now: NOW - 60 * 60_000 });
    await recordRuntimeActivity(db, { agentName: 'chat-b', busy: true, now: NOW - 1_000 });
    await recordRuntimeActivity(db, { agentName: 'chat-c', busy: false, now: NOW - 60 * 60_000 });

    await expect(claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: NOW })).resolves.toEqual({
      granted: false,
      busy: 2,
    });
    await expect(readRuntimeUpgradeWindow(db, NOW)).resolves.toBeNull();
  });

  it('keeps refusing for a quiet period after the work ends, then grants', async () => {
    const { db } = userWorkspaceDatabase();
    await recordRuntimeActivity(db, { agentName: 'chat-a', busy: true, now: NOW - 30 * 60_000 });
    await recordRuntimeActivity(db, { agentName: 'chat-a', busy: false, now: NOW });

    await expect(
      claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: NOW + RUNTIME_QUIET_PERIOD_MS - 1 }),
    ).resolves.toMatchObject({ granted: false });
    await expect(
      claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: NOW + RUNTIME_QUIET_PERIOD_MS }),
    ).resolves.toEqual({ granted: true });
  });

  it('stops counting a busy agent only after longer than a turn can run', async () => {
    const { db } = userWorkspaceDatabase();
    // An agent evicted mid-turn that never woke to clear its row.
    await recordRuntimeActivity(db, { agentName: 'chat-a', busy: true, now: NOW });

    await expect(
      claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: NOW + RUNTIME_BUSY_LEASE_MS - 1 }),
    ).resolves.toMatchObject({ granted: false });
    await expect(
      claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: NOW + RUNTIME_BUSY_LEASE_MS }),
    ).resolves.toEqual({ granted: true });
  });

  it('closes the window when it expires', async () => {
    const { db } = userWorkspaceDatabase();
    await claimRuntimeUpgradeWindow(db, { targetVersion: NEW_VERSION, now: NOW });

    await expect(readRuntimeUpgradeWindow(db, NOW + RUNTIME_UPGRADE_WINDOW_MS - 1)).resolves.not.toBeNull();
    await expect(readRuntimeUpgradeWindow(db, NOW + RUNTIME_UPGRADE_WINDOW_MS)).resolves.toBeNull();
  });
});
