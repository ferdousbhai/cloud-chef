import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { deploymentPlanResourceName, parseDeploymentPlanJson } from '~/lib/.server/cloudflare/deployment-plan';
import { createUserAccountApi } from '~/lib/.server/cloudflare/user-workspace-deployment-executor';
import type { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { AGENT_GC_GRACE_PERIOD_MS, AGENT_GC_RETRY_BASE_MS } from './agent-gc.server';

const APP_RESOURCE_GC_SWEEP_LIMIT = 2;
/**
 * Deployments one sweep releases, across its candidates. Each is a handful of Cloudflare API calls, and a
 * sweep runs in the `waitUntil` of the request or cron that started it, within that invocation's
 * subrequest budget; a chat with more is finished over later sweeps, from where the last one stopped.
 */
const APP_RESOURCE_GC_DEPLOYMENTS_PER_SWEEP = 6;
/** Deployments of one chat read per sweep; only a run of plans this build cannot read fills it. */
const APP_RESOURCE_GC_DEPLOYMENT_PAGE = 50;
const APP_RESOURCE_GC_RETRY_MAX_MS = 60 * 60 * 1000;

const logger = createScopedLogger('CloudflareAppResourceGc');

type AppResourceGcCandidateRow = {
  chat_id: string;
  not_before: number;
  attempts: number;
};

type DeploymentPlanRow = {
  id: string;
  plan_json: string;
};

type DeploymentResourceRow = {
  deployment_id: string;
  resource_type: string;
  logical_name: string;
  provider_resource_id: string;
};

/** One provider resource to delete: by the id provisioning recorded, or by the name the plan gives it. */
type CleanupTarget = { type: 'worker' | 'd1' | 'kv' | 'r2'; by: 'id' | 'name'; value: string };

export function prepareAppResourceGcCandidateStatement(
  db: D1Database,
  args: { initialId: string; ownerId: string; now?: number; requireEmpty?: boolean },
): D1PreparedStatement {
  const now = args.now ?? Date.now();
  const emptyClause = args.requireEmpty ? 'AND chats.has_messages = 0' : '';
  return db
    .prepare(
      `INSERT INTO app_resource_gc_candidates (chat_id, not_before, created_at, attempts)
       SELECT chats.id, ?, ?, 0
       FROM chats
       WHERE chats.initial_id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
         ${emptyClause}
       ON CONFLICT(chat_id) DO UPDATE SET
         not_before = MIN(app_resource_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(now + AGENT_GC_GRACE_PERIOD_MS, now, args.initialId, args.ownerId);
}

export async function sweepAppResourceGcCandidates(
  env: Pick<
    Env,
    | 'DB'
    | 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT'
    | 'CONTROL_PLANE_SECRET'
    | 'CLOUDCHEF_USER_ID'
    | 'CLOUDCHEF_CONNECTION_ID'
    | 'CLOUDCHEF_CONNECTION_GENERATION'
    | 'CLOUDFLARE_ACCOUNT_ID'
  >,
  options: { limit?: number; now?: number; accountApi?: AppResourceCleanupApi } = {},
): Promise<void> {
  const limit = Math.max(1, Math.min(options.limit ?? APP_RESOURCE_GC_SWEEP_LIMIT, APP_RESOURCE_GC_SWEEP_LIMIT));
  const now = options.now ?? Date.now();
  const result = await env.DB.prepare(
    `SELECT candidates.chat_id, candidates.not_before, candidates.attempts
     FROM app_resource_gc_candidates AS candidates
     INNER JOIN chats ON chats.id = candidates.chat_id
     WHERE chats.is_deleted = 1 AND candidates.not_before <= ?
     ORDER BY candidates.not_before, candidates.chat_id
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<AppResourceGcCandidateRow>();
  if (result.results.length === 0) {
    return;
  }

  const accountApi = options.accountApi ?? (await createUserAccountApi(env, fetch));
  const sweep: CleanupSweep = { budget: APP_RESOURCE_GC_DEPLOYMENTS_PER_SWEEP, removed: new Set() };
  for (const candidate of result.results) {
    if (sweep.budget === 0) {
      // Still due, so the next sweep starts with it.
      break;
    }
    await cleanupCandidate(env.DB, accountApi, candidate, now, sweep);
  }
}

/**
 * What is left of one sweep's work: deployments it may still release, and the resources it already
 * deleted, since a chat's deployments mostly name the same Worker, databases and bucket.
 */
type CleanupSweep = { budget: number; removed: Set<string> };

export async function sweepAppResourceGcCandidatesBestEffort(
  env: Parameters<typeof sweepAppResourceGcCandidates>[0],
): Promise<void> {
  try {
    await sweepAppResourceGcCandidates(env);
  } catch {
    logger.warn('Unable to sweep deferred app Cloudflare resources');
  }
}

type AppResourceCleanupApi = Pick<
  UserCloudflareAccountApi,
  | 'deleteManagedWorker'
  | 'deleteD1Database'
  | 'deleteD1DatabaseById'
  | 'deleteR2Bucket'
  | 'deleteKvNamespace'
  | 'deleteKvNamespaceById'
>;

/**
 * Releases the candidate's deployments oldest first, each once every resource it recorded or its plan
 * names is gone: its row (and its resource records) is then deleted, so a retry resumes after it rather
 * than walking the chat's whole history again. The receipt completes once no deployment is left.
 */
async function cleanupCandidate(
  db: D1Database,
  accountApi: AppResourceCleanupApi,
  candidate: AppResourceGcCandidateRow,
  now: number,
  sweep: CleanupSweep,
): Promise<void> {
  try {
    const plans = await db
      .prepare(
        `SELECT id, plan_json
         FROM deployments
         WHERE chat_id = ?
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .bind(candidate.chat_id, APP_RESOURCE_GC_DEPLOYMENT_PAGE)
      .all<DeploymentPlanRow>();
    const recorded = await recordedResources(
      db,
      plans.results.map((row) => row.id),
    );

    let remaining = plans.results.length;
    for (const row of plans.results) {
      if (sweep.budget === 0) {
        break;
      }
      const owned = recorded.get(row.id) ?? [];
      const plan = parsePlanForCleanup(row.plan_json);
      if (!plan && owned.length === 0) {
        // A newer schema version is not a completed cleanup: deleting the receipt here would strand
        // billable resources with no retry. Keep the deployment so a build that understands the plan
        // can clean up what it names.
        logger.warn('Preserving a deployment whose stored plan this build cannot parse');
        continue;
      }
      sweep.budget -= 1;
      if (!(await removeTargets(accountApi, cleanupTargets(owned, plan), sweep.removed))) {
        // An R2 bucket is still draining, a bounded batch at a time; the next sweep resumes here.
        break;
      }
      if (plan) {
        await releaseDeployment(db, row.id);
        remaining -= 1;
      } else {
        // What it recorded is gone; what its plan names waits for a build that can read it.
        await db.prepare('DELETE FROM deployment_resources WHERE deployment_id = ?').bind(row.id).run();
      }
    }
    if (remaining > 0) {
      await rescheduleCandidate(db, candidate, now, false);
      return;
    }
    await db
      .prepare(
        `DELETE FROM app_resource_gc_candidates
         WHERE chat_id = ? AND not_before = ?`,
      )
      .bind(candidate.chat_id, candidate.not_before)
      .run();
  } catch {
    await rescheduleCandidate(db, candidate, now, true);
    logger.warn('Unable to remove deferred app Cloudflare resources');
  }
}

async function recordedResources(
  db: D1Database,
  deploymentIds: readonly string[],
): Promise<Map<string, DeploymentResourceRow[]>> {
  const recorded = new Map<string, DeploymentResourceRow[]>();
  if (deploymentIds.length === 0) {
    return recorded;
  }
  const rows = await db
    .prepare(
      `SELECT deployment_id, resource_type, logical_name, provider_resource_id
       FROM deployment_resources
       WHERE deployment_id IN (${deploymentIds.map(() => '?').join(', ')})`,
    )
    .bind(...deploymentIds)
    .all<DeploymentResourceRow>();
  for (const row of rows.results) {
    recorded.set(row.deployment_id, [...(recorded.get(row.deployment_id) ?? []), row]);
  }
  return recorded;
}

function releaseDeployment(db: D1Database, deploymentId: string): Promise<D1Result[]> {
  return db.batch([
    db.prepare('DELETE FROM deployment_resources WHERE deployment_id = ?').bind(deploymentId),
    db.prepare('DELETE FROM deployment_activity WHERE deployment_id = ?').bind(deploymentId),
    db.prepare('DELETE FROM deployments WHERE id = ?').bind(deploymentId),
  ]);
}

const CLEANUP_TYPES = ['worker', 'd1', 'kv', 'r2'] as const;

/** The plan resources a deployment may have created, as (type, logical name). */
const PLAN_RESOURCES = [
  ['worker', 'app'],
  ['d1', 'DB'],
  ['d1', 'DB_PREVIEW'],
  ['d1', 'AGENT_SECURITY_DB'],
  ['d1', 'AGENT_SECURITY_DB_PREVIEW'],
  ['kv', 'APP_CACHE'],
  ['r2', 'APP_STORAGE'],
] as const;

/**
 * Everything a deployment recorded, by the provider id it was created with, and every resource its plan
 * names that it has no record of, by name: provisioning creates a resource before recording it, so a
 * failed record (or an upload that landed and failed after) leaves one only the plan's name finds.
 * Deleting by name is idempotent, and a name already gone is skipped.
 */
function cleanupTargets(
  owned: readonly DeploymentResourceRow[],
  plan: ReturnType<typeof parseDeploymentPlanJson> | null,
): CleanupTarget[] {
  const targets: CleanupTarget[] = [];
  for (const resource of owned) {
    const type = CLEANUP_TYPES.find((candidate) => candidate === resource.resource_type);
    if (type) {
      targets.push({ type, by: 'id', value: resource.provider_resource_id });
    }
  }
  if (plan) {
    if (!deploymentPlanResourceName(plan, 'worker', 'app')) {
      throw new Error('Deployment cleanup plan has no valid Worker.');
    }
    for (const [type, logicalName] of PLAN_RESOURCES) {
      const name = deploymentPlanResourceName(plan, type, logicalName);
      const isRecorded = owned.some(
        (resource) => resource.resource_type === type && resource.logical_name === logicalName,
      );
      if (name && !isRecorded) {
        targets.push({ type, by: 'name', value: name });
      }
    }
  }
  // The Worker goes first so the app stops serving before its data disappears.
  return CLEANUP_TYPES.flatMap((type) => targets.filter((target) => target.type === type));
}

/**
 * Deletes each target this sweep has not already removed. Returns false while an R2 bucket still has
 * objects, so the deployment is retried rather than released.
 */
async function removeTargets(
  accountApi: AppResourceCleanupApi,
  targets: readonly CleanupTarget[],
  removed: Set<string>,
): Promise<boolean> {
  let drained = true;
  for (const target of targets) {
    const key = `${target.type}:${target.by}:${target.value}`;
    if (removed.has(key)) {
      continue;
    }
    if (target.type === 'worker') {
      await accountApi.deleteManagedWorker(target.value);
    } else if (target.type === 'd1') {
      await (target.by === 'id'
        ? accountApi.deleteD1DatabaseById(target.value)
        : accountApi.deleteD1Database(target.value));
    } else if (target.type === 'kv') {
      await (target.by === 'id'
        ? accountApi.deleteKvNamespaceById(target.value)
        : accountApi.deleteKvNamespace(target.value));
    } else if (!(await accountApi.deleteR2Bucket(target.value))) {
      drained = false;
      continue;
    }
    removed.add(key);
  }
  return drained;
}

function parsePlanForCleanup(planJson: string): ReturnType<typeof parseDeploymentPlanJson> | null {
  try {
    return parseDeploymentPlanJson(planJson);
  } catch {
    return null;
  }
}

function rescheduleCandidate(
  db: D1Database,
  candidate: AppResourceGcCandidateRow,
  now: number,
  failed: boolean,
): Promise<D1Result> {
  const retryAt = now + retryDelay(failed ? candidate.attempts : 0);
  return db
    .prepare(
      `UPDATE app_resource_gc_candidates
       SET attempts = ?, not_before = ?
       WHERE chat_id = ? AND not_before = ?`,
    )
    .bind(failed ? candidate.attempts + 1 : candidate.attempts, retryAt, candidate.chat_id, candidate.not_before)
    .run();
}

function retryDelay(attempts: number): number {
  return Math.min(AGENT_GC_RETRY_BASE_MS * 2 ** Math.min(attempts, 7), APP_RESOURCE_GC_RETRY_MAX_MS);
}
