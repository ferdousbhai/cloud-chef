import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { canUseConnection } from '~/lib/cloudflare/data/organization-access.server';
import {
  connectionProvisionsWorkspace,
  isCurrentUserWorkspaceRuntime,
  sweepUserWorkspaceRuntimeUpgrade,
  USER_WORKSPACE_SANDBOX_BASE_IMAGE,
  type UserWorkspaceRuntimeUpgradeSweepOutcome,
} from '~/workflows/user-workspace-runtime-provisioning';
import { findActiveCloudflareConnection } from './cloudflare-connection-repository';
import { findUserWorkspaceRuntime, listOutdatedUserWorkspaceRuntimes } from './user-workspace-runtime-repository';

/**
 * How many upgrade Workflows one sweep starts or restarts. A release makes every runtime outdated at
 * once; this spreads their upgrades over the sweeps that follow instead of starting them all together.
 */
export const UPGRADE_SWEEP_MAX_LAUNCHES = 10;
/** The control plane's cron interval (`cloudflare.config.ts`), which the sweep runs on. */
export const UPGRADE_SWEEP_INTERVAL_MS = 15 * 60_000;
/** A failed upgrade is restarted on one sweep in this many, so at most hourly. */
export const FAILED_UPGRADE_RESTART_EVERY_SWEEPS = 4;

export type UserWorkspaceRuntimeUpgradeSweepDependencies = {
  listOutdated: typeof listOutdatedUserWorkspaceRuntimes;
  findConnection: typeof findActiveCloudflareConnection;
  canUseConnection: typeof canUseConnection;
  findRuntime: typeof findUserWorkspaceRuntime;
  sweepOne: typeof sweepUserWorkspaceRuntimeUpgrade;
};

const sweepDependencies: UserWorkspaceRuntimeUpgradeSweepDependencies = {
  listOutdated: listOutdatedUserWorkspaceRuntimes,
  findConnection: findActiveCloudflareConnection,
  canUseConnection,
  findRuntime: findUserWorkspaceRuntime,
  sweepOne: sweepUserWorkspaceRuntimeUpgrade,
};

type UserWorkspaceRuntimeUpgradeSweepSummary = Record<UserWorkspaceRuntimeUpgradeSweepOutcome, number> & {
  /** Not eligible to provision (a paused member, a connection missing a capability), or failed to inspect. */
  skipped: number;
};

/**
 * Upgrade the runtimes whose owners have not asked for a session since the release. A session request
 * already starts the upgrade of the runtime it is for; without one, an idle runtime would stay on an old
 * release until its owner came back, and a failed upgrade would stay failed until the browser's explicit
 * retry. Each upgrade is the same gated provisioning Workflow, which waits for the runtime's upgrade
 * window and never interrupts a turn, so the sweep only decides when one starts.
 */
export async function sweepUserWorkspaceRuntimeUpgrades(args: {
  env: Pick<Env, 'DB' | 'USER_WORKSPACE_RUNTIME_PROVISIONING'>;
  scheduledTime: number;
  dependencies?: UserWorkspaceRuntimeUpgradeSweepDependencies;
}): Promise<UserWorkspaceRuntimeUpgradeSweepSummary> {
  const dependencies = args.dependencies ?? sweepDependencies;
  const summary: UserWorkspaceRuntimeUpgradeSweepSummary = {
    started: 0,
    restarted: 0,
    running: 0,
    left: 0,
    skipped: 0,
  };
  const sweep = Math.floor(args.scheduledTime / UPGRADE_SWEEP_INTERVAL_MS);
  const candidates = await dependencies.listOutdated(args.env.DB, {
    runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
    imageDigest: USER_WORKSPACE_SANDBOX_BASE_IMAGE,
    protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
  });
  const restartFailed = sweep % FAILED_UPGRADE_RESTART_EVERY_SWEEPS === 0;
  for (const candidate of candidates) {
    if (summary.started + summary.restarted >= UPGRADE_SWEEP_MAX_LAUNCHES) {
      break;
    }
    try {
      const connection = await dependencies.findConnection(args.env.DB, candidate.connectionId);
      if (
        !connection ||
        !connectionProvisionsWorkspace(connection, candidate.connectionGeneration) ||
        !(await dependencies.canUseConnection(args.env.DB, candidate.userId, connection))
      ) {
        summary.skipped += 1;
        continue;
      }
      const outcome = await dependencies.sweepOne({
        env: args.env,
        userId: candidate.userId,
        connectionId: candidate.connectionId,
        connectionGeneration: candidate.connectionGeneration,
        restartFailed,
        isCurrent: async () => {
          const runtime = await dependencies.findRuntime(args.env.DB, candidate.userId, candidate.connectionId);
          return runtime !== null && isCurrentUserWorkspaceRuntime(runtime);
        },
      });
      summary[outcome] += 1;
    } catch (error) {
      summary.skipped += 1;
      console.warn({
        event: 'runtime_upgrade_sweep_failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  if (candidates.length > 0) {
    console.info({ event: 'runtime_upgrade_sweep', outdated: candidates.length, ...summary });
  }
  return summary;
}

/** The scheduled entry point: a sweep that fails is logged and tried again on the next schedule. */
export async function sweepUserWorkspaceRuntimeUpgradesBestEffort(
  env: Pick<Env, 'DB' | 'USER_WORKSPACE_RUNTIME_PROVISIONING'>,
  scheduledTime: number,
): Promise<void> {
  try {
    await sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime });
  } catch (error) {
    console.error('Workspace runtime upgrade sweep failed', error instanceof Error ? error.message : 'Unknown error');
  }
}
