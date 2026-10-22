import { describe, expect, it, vi } from 'vitest';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { envWith } from '~/test/control-plane-d1';
import {
  USER_WORKSPACE_REQUIRED_CAPABILITIES,
  USER_WORKSPACE_SANDBOX_BASE_IMAGE,
  type UserWorkspaceRuntimeUpgradeSweepOutcome,
} from '~/workflows/user-workspace-runtime-provisioning';
import type { CloudflareConnection } from './cloudflare-connection-repository';
import type { OutdatedUserWorkspaceRuntime, UserWorkspaceRuntime } from './user-workspace-runtime-repository';
import {
  FAILED_UPGRADE_RESTART_EVERY_SWEEPS,
  sweepSlot,
  sweepUserWorkspaceRuntimeUpgrades,
  UPGRADE_SWEEP_INTERVAL_MS,
  UPGRADE_SWEEP_MAX_CANDIDATES,
  UPGRADE_SWEEP_MAX_LAUNCHES,
  type UserWorkspaceRuntimeUpgradeSweepDependencies,
} from './user-workspace-runtime-upgrade-sweep';

const env = envWith({});

function connectionFor(id: string, overrides: Partial<CloudflareConnection> = {}): CloudflareConnection {
  return {
    id,
    userId: `owner-of-${id}`,
    orgId: null,
    accountId: 'account-1',
    accountName: null,
    status: 'active',
    credentialHandle: 'handle-1',
    grantedCapabilities: [...USER_WORKSPACE_REQUIRED_CAPABILITIES],
    requestedOAuthScopes: [],
    grantedOAuthScopes: [],
    oauthScopeProfileVersion: null,
    oauthScopeGrantStatus: 'full',
    connectedAt: 1,
    updatedAt: 1,
    generation: 1,
    ...overrides,
  };
}

function runtime(connectionId: string): OutdatedUserWorkspaceRuntime {
  return { userId: `owner-of-${connectionId}`, connectionId, connectionGeneration: 1 };
}

function sweepDependencies({
  outdated,
  connections = new Map(outdated.map(({ connectionId }) => [connectionId, connectionFor(connectionId)])),
  outcome = async () => 'started',
  canUse = async () => true,
  live = null,
}: {
  outdated: OutdatedUserWorkspaceRuntime[];
  connections?: Map<string, CloudflareConnection>;
  outcome?: (
    args: Parameters<UserWorkspaceRuntimeUpgradeSweepDependencies['sweepOne']>[0],
  ) => Promise<UserWorkspaceRuntimeUpgradeSweepOutcome>;
  canUse?: UserWorkspaceRuntimeUpgradeSweepDependencies['canUseConnection'];
  live?: UserWorkspaceRuntime | null;
}) {
  return {
    listOutdated: vi.fn<UserWorkspaceRuntimeUpgradeSweepDependencies['listOutdated']>(async () => outdated),
    findConnection: vi.fn<UserWorkspaceRuntimeUpgradeSweepDependencies['findConnection']>(
      async (_db, id) => connections.get(id) ?? null,
    ),
    canUseConnection: vi.fn<UserWorkspaceRuntimeUpgradeSweepDependencies['canUseConnection']>(canUse),
    findRuntime: vi.fn<UserWorkspaceRuntimeUpgradeSweepDependencies['findRuntime']>(async () => live),
    sweepOne: vi.fn<UserWorkspaceRuntimeUpgradeSweepDependencies['sweepOne']>(outcome),
  } satisfies UserWorkspaceRuntimeUpgradeSweepDependencies;
}

describe('scheduled workspace runtime upgrade sweep', () => {
  it('starts the gated upgrade of each outdated runtime this release can still serve', async () => {
    const dependencies = sweepDependencies({ outdated: [runtime('a'), runtime('b')] });

    await expect(sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: 0, dependencies })).resolves.toMatchObject({
      started: 2,
      skipped: 0,
    });

    expect(dependencies.listOutdated).toHaveBeenCalledWith(env.DB, {
      runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
      imageDigest: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
      protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
      limit: UPGRADE_SWEEP_MAX_CANDIDATES,
      rotation: 0,
    });
    expect(dependencies.sweepOne.mock.calls.map(([args]) => [args.userId, args.connectionId])).toEqual([
      ['owner-of-a', 'a'],
      ['owner-of-b', 'b'],
    ]);
  });

  it('looks at the next page of outdated runtimes on each sweep', async () => {
    const dependencies = sweepDependencies({ outdated: [] });

    await sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: 0, dependencies });
    await sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: UPGRADE_SWEEP_INTERVAL_MS, dependencies });

    expect(dependencies.listOutdated.mock.calls.map(([, args]) => args.rotation)).toEqual([0, 1]);
  });

  it('launches at most a batch per sweep, not counting upgrades already waiting', async () => {
    const outdated = Array.from({ length: UPGRADE_SWEEP_MAX_LAUNCHES + 5 }, (_, index) => runtime(`c${index}`));
    // The first two are already waiting for a quiet moment; the rest are launched up to the batch.
    const dependencies = sweepDependencies({
      outdated,
      outcome: async ({ connectionId }) => (connectionId === 'c0' || connectionId === 'c1' ? 'running' : 'started'),
    });

    await expect(sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: 0, dependencies })).resolves.toMatchObject({
      running: 2,
      started: UPGRADE_SWEEP_MAX_LAUNCHES,
    });
    expect(dependencies.sweepOne).toHaveBeenCalledTimes(UPGRADE_SWEEP_MAX_LAUNCHES + 2);
  });

  it('starts nothing for a person who may no longer use the connection, or one that cannot provision', async () => {
    const connections = new Map([
      ['paused', connectionFor('paused', { userId: null, orgId: 'org-1' })],
      ['regenerated', connectionFor('regenerated', { generation: 2 })],
      ['missing-capability', connectionFor('missing-capability', { grantedCapabilities: ['workers'] })],
      ['no-credential', connectionFor('no-credential', { credentialHandle: null })],
    ]);
    const dependencies = sweepDependencies({
      outdated: [...connections.keys(), 'revoked'].map(runtime),
      connections,
      canUse: async (_db, userId) => userId !== 'owner-of-paused',
    });

    await expect(sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: 0, dependencies })).resolves.toMatchObject({
      started: 0,
      skipped: 5,
    });
    expect(dependencies.sweepOne).not.toHaveBeenCalled();
  });

  it('retries each failed upgrade on one sweep in four, and keeps sweeping past one that throws', async () => {
    const candidate = runtime('failing');
    const restartFailed: boolean[] = [];
    for (let sweep = 0; sweep < FAILED_UPGRADE_RESTART_EVERY_SWEEPS * 2; sweep += 1) {
      const dependencies = sweepDependencies({
        outdated: [candidate],
        outcome: async (args) => {
          restartFailed.push(args.restartFailed);
          return args.restartFailed ? 'restarted' : 'left';
        },
      });
      await sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: sweep * UPGRADE_SWEEP_INTERVAL_MS, dependencies });
    }
    expect(restartFailed.filter(Boolean)).toHaveLength(2);
    expect(restartFailed.indexOf(true)).toBe(
      (FAILED_UPGRADE_RESTART_EVERY_SWEEPS - (sweepSlot(candidate) % FAILED_UPGRADE_RESTART_EVERY_SWEEPS)) %
        FAILED_UPGRADE_RESTART_EVERY_SWEEPS,
    );

    const dependencies = sweepDependencies({
      outdated: [runtime('throws'), runtime('fine')],
      outcome: async ({ connectionId }) => {
        if (connectionId === 'throws') {
          throw new Error('Workflow binding unavailable');
        }
        return 'started';
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: 0, dependencies })).resolves.toMatchObject({
      started: 1,
      skipped: 1,
    });
    expect(warn).toHaveBeenCalledWith({
      event: 'runtime_upgrade_sweep_failed',
      message: 'Workflow binding unavailable',
    });
    warn.mockRestore();
  });

  it('asks whether the runtime became current before restarting a finished upgrade', async () => {
    const dependencies = sweepDependencies({
      outdated: [runtime('a')],
      live: {
        connectionId: 'a',
        connectionGeneration: 1,
        endpoint: 'https://workspace.example',
        runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
        imageDigest: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
        protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
        lastSessionAt: null,
      },
      outcome: async ({ isCurrent }) => ((await isCurrent()) ? 'left' : 'restarted'),
    });

    await expect(sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: 0, dependencies })).resolves.toMatchObject({
      left: 1,
    });
    expect(dependencies.findRuntime).toHaveBeenCalledWith(env.DB, 'owner-of-a', 'a');
  });

  it('does not count a runtime recorded with an earlier protocol as current', async () => {
    const dependencies = sweepDependencies({
      outdated: [runtime('a')],
      live: {
        connectionId: 'a',
        connectionGeneration: 1,
        endpoint: 'https://workspace.example',
        runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
        imageDigest: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
        protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION - 1,
        lastSessionAt: null,
      },
      outcome: async ({ isCurrent }) => ((await isCurrent()) ? 'left' : 'restarted'),
    });

    await expect(sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime: 0, dependencies })).resolves.toMatchObject({
      restarted: 1,
    });
  });
});
