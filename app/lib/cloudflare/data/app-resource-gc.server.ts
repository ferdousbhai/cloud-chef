import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import {
  APP_ACCOUNT_RESOURCES,
  deploymentPlanResourceName,
  parseDeploymentPlanJson,
} from '~/lib/.server/cloudflare/deployment-plan';
import { createUserAccountApi } from '~/lib/.server/cloudflare/user-workspace-deployment-executor';
import type { UserCloudflareAccountApi } from '~/lib/.server/cloudflare/user-account-api';
import { nativeProjectRepo, ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { AGENT_GC_GRACE_PERIOD_MS, retryDelay } from './agent-gc.server';
import { forgetCloneTokens } from './clone-tokens.server';
import { EMPTY_CHAT_DISCARD_PREDICATE } from './empty-chat.server';

const APP_RESOURCE_GC_SWEEP_LIMIT = 2;
/**
 * Deployments one sweep releases, across its candidates. Each is a handful of Cloudflare API calls, and a
 * sweep runs in the `waitUntil` of the request or cron that started it, within that invocation's
 * subrequest budget; a chat with more is finished over later sweeps, from where the last one stopped.
 */
const APP_RESOURCE_GC_DEPLOYMENTS_PER_SWEEP = 6;
/** Deployments of one chat read per sweep; only a run of plans this build cannot read fills it. */
const APP_RESOURCE_GC_DEPLOYMENT_PAGE = 50;
/** Removed chats with leftover deployment records one scheduled sweep queues; later sweeps queue the rest. */
const APP_RESOURCE_GC_REQUEUE_PER_SWEEP = 20;

const logger = createScopedLogger('CloudflareAppResourceGc');

type AppResourceGcCandidateRow = {
  workspace_id: string;
  not_before: number;
  attempts: number;
};

type DeploymentPlanRow = {
  id: string;
  plan_json: string;
  created_at: number;
};

type DeploymentResourceRow = {
  deployment_id: string;
  resource_type: string;
  logical_name: string;
  provider_resource_id: string;
};

/**
 * One provider resource to delete: by the id provisioning recorded, or by the name the plan gives it.
 * `name` is the name the deployment's plan gives it, when the plan can be read. A Worker's and a
 * bucket's recorded id is its name.
 */
type CleanupTarget = { type: 'worker' | 'd1' | 'kv' | 'r2'; by: 'id' | 'name'; value: string; name: string | null };

export function prepareAppResourceGcCandidateStatement(
  db: D1Database,
  args: { initialId: string; ownerId: string; requireEmpty?: boolean },
): D1PreparedStatement {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO app_resource_gc_candidates (workspace_id, not_before, created_at, attempts)
       SELECT workspaces.id, ?, ?, 0
       FROM workspaces
       WHERE workspaces.initial_id = ? AND workspaces.creator_id = ?
         AND ${args.requireEmpty ? EMPTY_CHAT_DISCARD_PREDICATE : 'workspaces.is_deleted = 0'}
       ON CONFLICT(workspace_id) DO UPDATE SET
         not_before = MIN(app_resource_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(now + AGENT_GC_GRACE_PERIOD_MS, now, args.initialId, args.ownerId);
}

export async function sweepAppResourceGcCandidates(
  env: Pick<
    Env,
    | 'DB'
    | 'CLOUDCHEF_USER_RUNTIME'
    | 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT'
    | 'CONTROL_PLANE_SECRET'
    | 'CLOUDCHEF_USER_ID'
    | 'CLOUDCHEF_CONNECTION_ID'
    | 'CLOUDCHEF_CONNECTION_GENERATION'
    | 'CLOUDFLARE_ACCOUNT_ID'
    | 'CLOUDCHEF_SHARED_ACCOUNT'
  > &
    Partial<Pick<Env, 'ARTIFACTS'>>,
  options: AppResourceGcSweepOptions = {},
): Promise<void> {
  const now = Date.now();
  if (options.requeueRemovedChats) {
    await requeueRemovedChatsWithDeployments(env.DB, now);
  }
  const result = await env.DB.prepare(
    `SELECT candidates.workspace_id, candidates.not_before, candidates.attempts
     FROM app_resource_gc_candidates AS candidates
     INNER JOIN workspaces ON workspaces.id = candidates.workspace_id
     WHERE workspaces.is_deleted = 1 AND candidates.not_before <= ?
     ORDER BY candidates.not_before, candidates.workspace_id
     LIMIT ?`,
  )
    .bind(now, APP_RESOURCE_GC_SWEEP_LIMIT)
    .all<AppResourceGcCandidateRow>();
  if (result.results.length === 0) {
    return;
  }

  const accountApi = await createUserAccountApi(env);
  const sweep: CleanupSweep = {
    budget: APP_RESOURCE_GC_DEPLOYMENTS_PER_SWEEP,
    // A team's draft can become one of its projects, keeping its repository, so only a person's own
    // account deletes a removed chat's repositories.
    repositories:
      env.CLOUDCHEF_USER_RUNTIME === '1' && env.CLOUDCHEF_SHARED_ACCOUNT !== '1' && env.ARTIFACTS
        ? new ProjectRepositories(env.ARTIFACTS)
        : null,
  };
  for (const candidate of result.results) {
    if (sweep.budget === 0) {
      // Still due, so the next sweep starts with it.
      break;
    }
    await cleanupCandidate(env.DB, accountApi, candidate, now, sweep);
  }
}

type AppResourceGcSweepOptions = {
  /**
   * First queue removed chats that still have deployment records but no candidate, as the scheduled
   * maintenance sweep does. A request's sweep leaves this to it, so a data request adds no write.
   */
  requeueRemovedChats?: boolean;
};

/**
 * Queues, a bounded number at a time, removed chats whose deployment records outlived their candidate:
 * an older collector deleted their resources and receipt but not the records, and a deployment can
 * also be recorded after its chat's cleanup finished. Each is then released like any other candidate,
 * after the same grace period: what is left of its resources is deleted (a name already gone is
 * skipped) and its records with them. A chat that is not removed is never queued.
 */
function requeueRemovedChatsWithDeployments(db: D1Database, now: number): Promise<D1Result> {
  return db
    .prepare(
      `INSERT INTO app_resource_gc_candidates (workspace_id, not_before, created_at, attempts)
       SELECT workspaces.id, ?, ?, 0
       FROM workspaces
       WHERE workspaces.is_deleted = 1
         AND EXISTS (SELECT 1 FROM deployments WHERE deployments.workspace_id = workspaces.id)
         AND NOT EXISTS (SELECT 1 FROM app_resource_gc_candidates AS queued WHERE queued.workspace_id = workspaces.id)
       ORDER BY workspaces.id
       LIMIT ?
       ON CONFLICT(workspace_id) DO NOTHING`,
    )
    .bind(now + AGENT_GC_GRACE_PERIOD_MS, now, APP_RESOURCE_GC_REQUEUE_PER_SWEEP)
    .run();
}

/**
 * What is left of one sweep's work: the deployments it may still release, and the account's repositories
 * when a removed chat's own go with it.
 */
type CleanupSweep = { budget: number; repositories: ProjectRepositories | null };

export async function sweepAppResourceGcCandidatesBestEffort(
  env: Parameters<typeof sweepAppResourceGcCandidates>[0],
  options: AppResourceGcSweepOptions = {},
): Promise<void> {
  try {
    await sweepAppResourceGcCandidates(env, options);
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
 * names is gone or belongs to a deployment released after it too: its row (and its resource records)
 * is then deleted, so a retry resumes after it rather than walking the chat's whole history again. A
 * project's deployments share its resources, so the last of them deletes those, once. The receipt
 * completes once no deployment is left.
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
        `SELECT id, plan_json, created_at
         FROM deployments
         WHERE workspace_id = ?
         ORDER BY created_at, id
         LIMIT ?`,
      )
      .bind(candidate.workspace_id, APP_RESOURCE_GC_DEPLOYMENT_PAGE)
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
      const targets = await unsharedTargets(db, candidate.workspace_id, row, cleanupTargets(owned, plan));
      if (!(await removeTargets(accountApi, targets))) {
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
    if (sweep.repositories) {
      await deleteChatRepository(db, sweep.repositories, candidate.workspace_id);
    }
    await db
      .prepare(
        `DELETE FROM app_resource_gc_candidates
         WHERE workspace_id = ? AND not_before = ?`,
      )
      .bind(candidate.workspace_id, candidate.not_before)
      .run();
  } catch {
    await rescheduleCandidate(db, candidate, now, true);
    logger.warn('Unable to remove deferred app Cloudflare resources');
  }
}

/** The repository of a removed chat's own app; a team project it worked on keeps its own. */
async function deleteChatRepository(db: D1Database, repositories: ProjectRepositories, chatId: string): Promise<void> {
  const chat = await db
    .prepare('SELECT initial_id, org_project_id FROM workspaces WHERE id = ?')
    .bind(chatId)
    .first<{ initial_id: string; org_project_id: string | null }>();
  if (!chat || chat.org_project_id !== null) {
    return;
  }
  const repo = nativeProjectRepo(chat.initial_id);
  await repositories.deleteRepo(repo);
  await forgetCloneTokens(db, repo);
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
      targets.push({
        type,
        by: 'id',
        value: resource.provider_resource_id,
        name: plan ? deploymentPlanResourceName(plan, type, resource.logical_name) : null,
      });
    }
  }
  if (plan) {
    if (!deploymentPlanResourceName(plan, 'worker', 'app')) {
      throw new Error('Deployment cleanup plan has no valid Worker.');
    }
    for (const [type, logicalName] of APP_ACCOUNT_RESOURCES) {
      const name = deploymentPlanResourceName(plan, type, logicalName);
      const isRecorded = owned.some(
        (resource) => resource.resource_type === type && resource.logical_name === logicalName,
      );
      if (name && !isRecorded) {
        targets.push({ type, by: 'name', value: name, name });
      }
    }
  }
  // The Worker goes first so the app stops serving before its data disappears.
  return CLEANUP_TYPES.flatMap((type) => targets.filter((target) => target.type === type));
}

/**
 * The targets no deployment of the chat released after this one also has, by a record of the same
 * provider id or a plan naming the same resource. A project's deployments all deploy onto its
 * resources, so releasing one leaves them to the deployments after it, and the last one deletes them.
 * A later plan is read as stored, so one this build cannot parse keeps what it names until a build
 * that can releases it.
 */
async function unsharedTargets(
  db: D1Database,
  chatId: string,
  deployment: DeploymentPlanRow,
  targets: readonly CleanupTarget[],
): Promise<CleanupTarget[]> {
  const unshared: CleanupTarget[] = [];
  for (const target of targets) {
    const shared = await db
      .prepare(
        `SELECT 1 AS found FROM deployments
         WHERE workspace_id = ?1
           AND (created_at > ?6 OR (created_at = ?6 AND id > ?2))
           AND (
             EXISTS (
               SELECT 1 FROM deployment_resources
               WHERE deployment_resources.deployment_id = deployments.id
                 AND deployment_resources.resource_type = ?3
                 AND deployment_resources.provider_resource_id = ?4
             )
             OR EXISTS (
               SELECT 1
               FROM json_each(
                 CASE WHEN json_valid(deployments.plan_json) THEN deployments.plan_json ELSE '{}' END,
                 '$.resources'
               ) AS resource
               WHERE json_extract(resource.value, '$.type') = ?3
                 AND json_extract(resource.value, '$.proposedName') IN (?4, ?5)
             )
           )
         LIMIT 1`,
      )
      .bind(chatId, deployment.id, target.type, target.value, target.name, deployment.created_at)
      .first<{ found: number }>();
    if (!shared) {
      unshared.push(target);
    }
  }
  return unshared;
}

/**
 * Deletes each target. Returns false while an R2 bucket still has objects, so the deployment is retried
 * rather than released.
 */
async function removeTargets(accountApi: AppResourceCleanupApi, targets: readonly CleanupTarget[]): Promise<boolean> {
  let drained = true;
  for (const target of targets) {
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
       WHERE workspace_id = ? AND not_before = ?`,
    )
    .bind(failed ? candidate.attempts + 1 : candidate.attempts, retryAt, candidate.workspace_id, candidate.not_before)
    .run();
}
