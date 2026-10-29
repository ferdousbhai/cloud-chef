import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { canUseConnection } from '~/lib/cloudflare/data/organization-access.server';
import {
  connectionProvisionsWorkspace,
  isCurrentUserWorkspaceRuntime,
  sweepUserWorkspaceRuntimeUpgrade,
  type UserWorkspaceRuntimeUpgradeSweepOutcome,
} from '~/workflows/user-workspace-runtime-provisioning';
import { findActiveCloudflareConnection } from './cloudflare-connection-repository';
import { isUserWorkspaceImagePublished, USER_WORKSPACE_IMAGE } from './user-workspace-image';
import { workspaceRuntimeUpgradeAllowed } from './user-workspace-runtime-rollout';
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
  env: Pick<Env, 'DB' | 'USER_WORKSPACE_RUNTIME_PROVISIONING' | 'WORKSPACE_RUNTIME_UPGRADE_CANARY'>;
  scheduledTime: number;
  imagePublished?: () => boolean;
}): Promise<UserWorkspaceRuntimeUpgradeSweepSummary> {
  const summary: UserWorkspaceRuntimeUpgradeSweepSummary = {
    started: 0,
    restarted: 0,
    running: 0,
    left: 0,
    skipped: 0,
  };
  // A release that pins no published workspace image upgrades nothing: provisioning would refuse each one.
  if (!(args.imagePublished ?? isUserWorkspaceImagePublished)()) {
    return summary;
  }
  const sweep = Math.floor(args.scheduledTime / UPGRADE_SWEEP_INTERVAL_MS);
  const candidates = await listOutdatedUserWorkspaceRuntimes(args.env.DB, {
    runtimeVersion: USER_WORKSPACE_RUNTIME_SHA256,
    imageDigest: USER_WORKSPACE_IMAGE,
    protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
  });
  const restartFailed = sweep % FAILED_UPGRADE_RESTART_EVERY_SWEEPS === 0;
  for (const candidate of candidates) {
    if (summary.started + summary.restarted >= UPGRADE_SWEEP_MAX_LAUNCHES) {
      break;
    }
    // During a canary only the named people's runtimes are upgraded; everyone else's keeps serving as it is.
    if (!workspaceRuntimeUpgradeAllowed(args.env, candidate.userId)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const connection = await findActiveCloudflareConnection(args.env.DB, candidate.connectionId);
      // The generation was the connection's own when listed: it differs only after a reconnect since.
      if (
        !connection ||
        !connectionProvisionsWorkspace(connection, candidate.connectionGeneration) ||
        !(await canUseConnection(args.env.DB, candidate.userId, connection))
      ) {
        summary.skipped += 1;
        continue;
      }
      const outcome = await sweepUserWorkspaceRuntimeUpgrade({
        env: args.env,
        userId: candidate.userId,
        connectionId: candidate.connectionId,
        connectionGeneration: candidate.connectionGeneration,
        restartFailed,
        // Current on this release's build, and prepared for the generation the upgrade was for: one left on an
        // earlier generation still needs it, whatever build it runs.
        isCurrent: async () => {
          const runtime = await findUserWorkspaceRuntime(args.env.DB, candidate.userId, candidate.connectionId);
          return (
            runtime !== null &&
            runtime.connectionGeneration === candidate.connectionGeneration &&
            isCurrentUserWorkspaceRuntime(runtime)
          );
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
  env: Pick<Env, 'DB' | 'USER_WORKSPACE_RUNTIME_PROVISIONING' | 'WORKSPACE_RUNTIME_UPGRADE_CANARY'>,
  scheduledTime: number,
): Promise<void> {
  try {
    await sweepUserWorkspaceRuntimeUpgrades({ env, scheduledTime });
  } catch (error) {
    console.error('Workspace runtime upgrade sweep failed', error instanceof Error ? error.message : 'Unknown error');
  }
}
