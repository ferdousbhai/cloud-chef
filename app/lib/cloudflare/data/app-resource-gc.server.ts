import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { deploymentPlanResourceName, parseDeploymentPlanJson } from '~/lib/.server/cloudflare/deployment-plan';
import { createUserAccountApi } from '~/lib/.server/cloudflare/user-workspace-deployment-executor';
import type { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { AGENT_GC_GRACE_PERIOD_MS, AGENT_GC_RETRY_BASE_MS } from './agent-gc.server';

const APP_RESOURCE_GC_SWEEP_LIMIT = 2;
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
  provider_resource_id: string;
};

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
  for (const candidate of result.results) {
    await cleanupCandidate(env.DB, accountApi, candidate, now);
  }
}

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

async function cleanupCandidate(
  db: D1Database,
  accountApi: AppResourceCleanupApi,
  candidate: AppResourceGcCandidateRow,
  now: number,
): Promise<void> {
  try {
    const [plans, resources] = await Promise.all([
      db
        .prepare(
          `SELECT id, plan_json
           FROM deployments
           WHERE chat_id = ?
           ORDER BY created_at, id`,
        )
        .bind(candidate.chat_id)
        .all<DeploymentPlanRow>(),
      db
        .prepare(
          `SELECT resources.deployment_id, resources.resource_type, resources.provider_resource_id
           FROM deployment_resources AS resources
           INNER JOIN deployments ON deployments.id = resources.deployment_id
           WHERE deployments.chat_id = ?`,
        )
        .bind(candidate.chat_id)
        .all<DeploymentResourceRow>(),
    ]);
    const recorded = new Map<string, DeploymentResourceRow[]>();
    for (const row of resources.results) {
      recorded.set(row.deployment_id, [...(recorded.get(row.deployment_id) ?? []), row]);
    }

    for (const row of plans.results) {
      const owned = recorded.get(row.id);
      if (owned && owned.length > 0) {
        if (!(await cleanupRecordedResources(accountApi, owned))) {
          await rescheduleCandidate(db, candidate, now, false);
          return;
        }
        continue;
      }
      const plan = parsePlanForCleanup(row.plan_json);
      if (!plan) {
        // A newer schema version is not a completed cleanup: deleting the receipt here would strand
        // billable resources with no retry. Preserve the candidate so a build that understands the
        // plan can clean it up.
        logger.warn('Preserving a deployment whose stored plan this build cannot parse');
        await rescheduleCandidate(db, candidate, now, false);
        return;
      }
      if (!(await cleanupDeploymentPlan(accountApi, plan))) {
        await rescheduleCandidate(db, candidate, now, false);
        return;
      }
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

/**
 * Delete exactly what provisioning recorded, addressing each resource by the
 * provider id it was created with. Returns false while R2 still has objects, so
 * the receipt is retried rather than completed.
 */
async function cleanupRecordedResources(
  accountApi: AppResourceCleanupApi,
  resources: readonly DeploymentResourceRow[],
): Promise<boolean> {
  // The Worker goes first so the app stops serving before its data disappears.
  const order = ['worker', 'd1', 'kv', 'r2'];
  let drained = true;
  for (const type of order) {
    for (const resource of resources.filter((candidate) => candidate.resource_type === type)) {
      const id = resource.provider_resource_id;
      if (type === 'worker') {
        await accountApi.deleteManagedWorker(id);
      } else if (type === 'd1') {
        await accountApi.deleteD1DatabaseById(id);
      } else if (type === 'kv') {
        await accountApi.deleteKvNamespaceById(id);
      } else if (!(await accountApi.deleteR2Bucket(id))) {
        drained = false;
      }
    }
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

/** Clean up resources created before their provider ids could be recorded durably. */
async function cleanupDeploymentPlan(
  accountApi: AppResourceCleanupApi,
  plan: ReturnType<typeof parseDeploymentPlanJson>,
): Promise<boolean> {
  const workerName = deploymentPlanResourceName(plan, 'worker', 'app');
  if (!workerName) {
    throw new Error('Deployment cleanup plan has no valid Worker.');
  }
  await accountApi.deleteManagedWorker(workerName);

  for (const logicalName of ['DB', 'DB_PREVIEW', 'AGENT_SECURITY_DB', 'AGENT_SECURITY_DB_PREVIEW'] as const) {
    const name = deploymentPlanResourceName(plan, 'd1', logicalName);
    if (name) {
      await accountApi.deleteD1Database(name);
    }
  }
  const kvName = deploymentPlanResourceName(plan, 'kv', 'APP_CACHE');
  if (kvName) {
    await accountApi.deleteKvNamespace(kvName);
  }
  const r2Name = deploymentPlanResourceName(plan, 'r2', 'APP_STORAGE');
  return r2Name ? accountApi.deleteR2Bucket(r2Name) : true;
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
