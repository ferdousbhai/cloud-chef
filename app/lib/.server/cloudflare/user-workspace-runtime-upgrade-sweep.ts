import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { canUseConnection } from '~/lib/cloudflare/data/organization-access.server';
import {
  missingUserWorkspaceRuntimeCapabilities,
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
/** How many outdated runtimes one sweep looks at, including those whose upgrade is already waiting. */
export const UPGRADE_SWEEP_MAX_CANDIDATES = 50;
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
    limit: UPGRADE_SWEEP_MAX_CANDIDATES,
  });
  for (const candidate of candidates) {
    if (summary.started + summary.restarted >= UPGRADE_SWEEP_MAX_LAUNCHES) {
      break;
    }
    try {
      const connection = await dependencies.findConnection(args.env.DB, candidate.connectionId);
      if (
        !connection ||
        connection.generation !== candidate.connectionGeneration ||
        !connection.credentialHandle ||
        missingUserWorkspaceRuntimeCapabilities(connection).length > 0 ||
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
        // Each runtime has its own slot among the sweeps, so a failed upgrade is retried on one sweep in N
        // and the retries of many are spread over them.
        restartFailed: (sweep + sweepSlot(candidate)) % FAILED_UPGRADE_RESTART_EVERY_SWEEPS === 0,
        isCurrent: async () => {
          const runtime = await dependencies.findRuntime(args.env.DB, candidate.userId, candidate.connectionId);
          return (
            runtime?.runtimeVersion === USER_WORKSPACE_RUNTIME_SHA256 &&
            runtime.imageDigest === USER_WORKSPACE_SANDBOX_BASE_IMAGE
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

/** A stable number for a runtime, the same on every sweep. */
export function sweepSlot(runtime: { userId: string; connectionId: string }): number {
  let slot = 0;
  for (const character of `${runtime.userId}:${runtime.connectionId}`) {
    slot = (slot * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
  }
  return slot;
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
