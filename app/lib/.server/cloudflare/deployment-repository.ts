import { parseWorkspaceReference } from './workspace-reference';
import { parseDeploymentPlanJson, type DeploymentPlan } from './deployment-plan';

export type DeploymentStatus = 'approved' | 'provisioning' | 'deploying' | 'succeeded' | 'failed';

/** The start every workspace reference to a revision of the project shares. */
function projectReferencePrefix(projectId: string): string {
  return `workspace-runtime:${encodeURIComponent(projectId)}:`;
}

export type Deployment = {
  id: string;
  chatId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  executionGeneration: number;
  workspaceReference: string;
  status: DeploymentStatus;
  plan: DeploymentPlan;
  planDigest: string;
  productionUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

type DeploymentActivity = {
  sequence: number;
  message: string;
  createdAt: number;
};

type DeploymentRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  connection_id: string;
  connection_generation: number;
  execution_generation: number;
  workspace_reference: string;
  status: DeploymentStatus;
  plan_json: string;
  plan_digest: string;
  production_url: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

const DEPLOYMENT_COLUMNS = `id, workspace_id, user_id, connection_id, connection_generation, execution_generation,
  workspace_reference, status, plan_json, plan_digest, production_url,
  error_code, error_message, created_at, updated_at`;

export async function createDeployment(args: {
  db: D1Database;
  id: string;
  chatId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  workspaceReference: string;
  plan: DeploymentPlan;
  planDigest: string;
}): Promise<Deployment> {
  const now = Date.now();
  const committed = await verifiedWrite({
    write: () =>
      args.db
        .prepare(
          `INSERT INTO deployments (
           id, workspace_id, user_id, connection_id, connection_generation, execution_generation,
           workspace_reference, status, plan_json, plan_digest, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, 'approved', ?, ?, ?, ?)`,
        )
        .bind(
          args.id,
          args.chatId,
          args.userId,
          args.connectionId,
          args.connectionGeneration,
          args.workspaceReference,
          JSON.stringify(args.plan),
          args.planDigest,
          now,
          now,
        )
        .run(),
    read: () => requireDeployment(args.db, args.id, args.userId),
    landed: (committed) =>
      committed.workspaceReference === args.workspaceReference &&
      committed.planDigest === args.planDigest &&
      committed.connectionId === args.connectionId &&
      committed.connectionGeneration === args.connectionGeneration,
    refuse: () => new Error('The deployment was not created.'),
  });
  return committed ?? requireDeployment(args.db, args.id, args.userId);
}

/** The deployment, and with `userId` only when it is that person's. */
export async function requireDeployment(db: D1Database, deploymentId: string, userId?: string): Promise<Deployment> {
  const row = await db
    .prepare(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = ?1 AND (?2 IS NULL OR user_id = ?2)`)
    .bind(deploymentId, userId ?? null)
    .first<DeploymentRow>();
  if (!row) {
    throw new DeploymentNotFoundError();
  }
  return deploymentFromRow(row);
}

export async function recordDeploymentActivity(args: {
  db: D1Database;
  deploymentId: string;
  executionGeneration: number;
  sequence: number;
  message: string;
}): Promise<void> {
  await args.db
    .prepare(
      `INSERT OR IGNORE INTO deployment_activity (
         deployment_id, execution_generation, sequence, message, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(args.deploymentId, args.executionGeneration, args.sequence, args.message, Date.now())
    .run();
}

export async function listDeploymentActivity(
  db: D1Database,
  deploymentId: string,
  executionGeneration: number,
): Promise<DeploymentActivity[]> {
  const result = await db
    .prepare(
      `SELECT sequence, message, created_at
       FROM deployment_activity
       WHERE deployment_id = ? AND execution_generation = ?
       ORDER BY sequence`,
    )
    .bind(deploymentId, executionGeneration)
    .all<{ sequence: number; message: string; created_at: number }>();
  return result.results.map((row) => ({ sequence: row.sequence, message: row.message, createdAt: row.created_at }));
}

/**
 * The step this deployment recorded most recently, for narrating a publication while it runs. It
 * resolves the current execution generation in the same statement so a retry never shows a stage
 * left behind by the attempt before it.
 */
export async function latestDeploymentActivity(
  db: D1Database,
  deploymentId: string,
): Promise<DeploymentActivity | null> {
  const row = await db
    .prepare(
      `SELECT sequence, message, created_at
       FROM deployment_activity
       WHERE deployment_id = ?1
         AND execution_generation = (SELECT execution_generation FROM deployments WHERE id = ?1)
       ORDER BY created_at DESC, sequence DESC
       LIMIT 1`,
    )
    .bind(deploymentId)
    .first<{ sequence: number; message: string; created_at: number }>();
  return row ? { sequence: row.sequence, message: row.message, createdAt: row.created_at } : null;
}

export async function claimApprovedDeployment(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  executionGeneration: number;
}): Promise<Deployment> {
  const expected = await requireDeployment(args.db, args.deploymentId, args.userId);
  requireCurrentConnection(expected, args);
  if (expected.executionGeneration !== args.executionGeneration || expected.status !== 'approved') {
    throw new DeploymentStateConflictError(expected.status);
  }
  const reference = parseWorkspaceReference(expected.workspaceReference);
  if (!reference) {
    throw new Error('The deployment does not belong to a CloudChef project.');
  }
  const now = Date.now();
  // Which claim this is: another one landing in the same millisecond would match a timestamp too.
  const claim = crypto.randomUUID();
  // One project deploys one revision at a time; a person's other projects deploy alongside it.
  const project = projectReferencePrefix(reference.projectId);
  const committed = await verifiedWrite({
    write: () =>
      args.db
        .prepare(
          `UPDATE deployments
         SET status = 'provisioning', updated_at = ?, claim_id = ?
         WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ?
           AND execution_generation = ? AND status = 'approved' AND updated_at = ?
           AND EXISTS (
             SELECT 1 FROM workspaces
             WHERE workspaces.id = deployments.workspace_id
               AND workspaces.creator_id = deployments.user_id
               AND workspaces.is_deleted = 0
           )
           AND NOT EXISTS (
             SELECT 1 FROM deployments AS active
             WHERE active.user_id = ? AND active.id <> ?
               AND substr(active.workspace_reference, 1, ?) = ?
               AND active.status IN ('provisioning', 'deploying')
           )`,
        )
        .bind(
          now,
          claim,
          expected.id,
          expected.userId,
          expected.connectionId,
          expected.connectionGeneration,
          expected.executionGeneration,
          expected.updatedAt,
          expected.userId,
          expected.id,
          project.length,
          project,
        )
        .run(),
    // The record and the claim id on it are read in one statement, so a committed claim is never
    // reported lost by a second read failing.
    read: () => readClaimedDeployment(args.db, expected.id, expected.userId),
    landed: (committed) => isExactDeploymentClaim(committed, expected, claim),
    refuse: async (committed) => {
      const active = await findActiveProjectDeployment(args.db, {
        userId: expected.userId,
        projectId: reference.projectId,
      });
      return active && active.id !== expected.id
        ? new DeploymentConcurrencyLimitError()
        : new DeploymentStateConflictError(committed.deployment.status);
    },
  });
  return committed?.deployment ?? { ...expected, status: 'provisioning', updatedAt: now };
}

/** A deployment holding its project's one deployment slot, and the revision it publishes. */
type ActiveProjectDeployment = {
  id: string;
  executionGeneration: number;
  workspaceRevision: number;
  revision: string;
  /** When its execution last showed it was working: the later of the record's update and its latest activity. */
  lastActiveAt: number;
};

/**
 * The project's deployment that is provisioning or deploying, which refuses every other deployment of
 * the project until it settles.
 */
export async function findActiveProjectDeployment(
  db: D1Database,
  args: { userId: string; projectId: string },
): Promise<ActiveProjectDeployment | null> {
  const project = projectReferencePrefix(args.projectId);
  const row = await db
    .prepare(
      `SELECT id, execution_generation, workspace_reference,
              MAX(updated_at, COALESCE((
                SELECT MAX(activity.created_at) FROM deployment_activity AS activity
                WHERE activity.deployment_id = deployments.id
                  AND activity.execution_generation = deployments.execution_generation
              ), 0)) AS last_active_at
       FROM deployments
       WHERE user_id = ? AND substr(workspace_reference, 1, ?) = ?
         AND status IN ('provisioning', 'deploying')
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .bind(args.userId, project.length, project)
    .first<{ id: string; execution_generation: number; workspace_reference: string; last_active_at: number }>();
  const reference = row && parseWorkspaceReference(row.workspace_reference);
  if (!row || !reference) {
    return null;
  }
  return {
    id: row.id,
    executionGeneration: row.execution_generation,
    workspaceRevision: reference.workspaceRevision,
    revision: reference.revision,
    lastActiveAt: row.last_active_at,
  };
}

export async function prepareDeploymentRetry(args: {
  db: D1Database;
  deploymentId: string;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  executionGeneration: number;
}): Promise<Deployment> {
  const expected = await requireDeployment(args.db, args.deploymentId, args.userId);
  requireCurrentConnection(expected, args);
  if (
    expected.executionGeneration !== args.executionGeneration ||
    expected.status !== 'failed' ||
    expected.plan.deploymentId !== expected.id
  ) {
    throw new DeploymentStateConflictError(expected.status);
  }
  const now = Date.now();
  const committed = await verifiedWrite({
    write: () =>
      args.db
        .prepare(
          `UPDATE deployments
         SET status = 'approved', execution_generation = execution_generation + 1,
             production_url = NULL, error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ? AND user_id = ? AND connection_id = ? AND connection_generation = ?
           AND execution_generation = ? AND status = 'failed' AND updated_at = ?
           AND plan_digest = ? AND workspace_reference = ?`,
        )
        .bind(
          now,
          expected.id,
          expected.userId,
          expected.connectionId,
          expected.connectionGeneration,
          expected.executionGeneration,
          expected.updatedAt,
          expected.planDigest,
          expected.workspaceReference,
        )
        .run(),
    read: () => requireDeployment(args.db, expected.id, expected.userId),
    landed: (committed) => isExactDeploymentRetry(committed, expected, now),
    refuse: (committed) => new DeploymentStateConflictError(committed.status),
  });
  return (
    committed ?? {
      ...expected,
      executionGeneration: expected.executionGeneration + 1,
      status: 'approved',
      productionUrl: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    }
  );
}

export async function recordDeploymentResource(args: {
  db: D1Database;
  deploymentId: string;
  resourceType: string;
  logicalName: string;
  providerResourceId: string;
}): Promise<void> {
  await args.db
    .prepare(
      `INSERT INTO deployment_resources (
         id, deployment_id, resource_type, logical_name, provider_resource_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(deployment_id, resource_type, logical_name) DO UPDATE SET
         provider_resource_id = excluded.provider_resource_id`,
    )
    .bind(
      crypto.randomUUID(),
      args.deploymentId,
      args.resourceType,
      args.logicalName,
      args.providerResourceId,
      Date.now(),
    )
    .run();
}

export async function findDeploymentResource(
  db: D1Database,
  deploymentId: string,
  resourceType: string,
  logicalName: string,
): Promise<{ providerResourceId: string; createdAt: number } | null> {
  const row = await db
    .prepare(
      `SELECT provider_resource_id, created_at
       FROM deployment_resources
       WHERE deployment_id = ? AND resource_type = ? AND logical_name = ?`,
    )
    .bind(deploymentId, resourceType, logicalName)
    .first<{ provider_resource_id: string; created_at: number }>();
  return row ? { providerResourceId: row.provider_resource_id, createdAt: row.created_at } : null;
}

export async function transitionDeployment(args: {
  db: D1Database;
  deploymentId: string;
  executionGeneration: number;
  expectedStatus: DeploymentStatus;
  nextStatus: DeploymentStatus;
  productionUrl?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  await verifiedWrite({
    write: () =>
      args.db
        .prepare(
          `UPDATE deployments
         SET status = ?, production_url = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND execution_generation = ? AND status = ?`,
        )
        .bind(
          args.nextStatus,
          args.productionUrl ?? null,
          args.errorCode ?? null,
          args.errorMessage ?? null,
          now,
          args.deploymentId,
          args.executionGeneration,
          args.expectedStatus,
        )
        .run(),
    read: () => requireDeployment(args.db, args.deploymentId),
    landed: (committed) => isExactDeploymentTransition(committed, args, now),
    refuse: (committed) => new DeploymentStateConflictError(committed.status),
  });
}

/**
 * Runs a conditional write and settles what it did: null when it changed the record, or the record read
 * back when the write is known to have landed (`landed`) though D1 lost its acknowledgement or it changed
 * nothing because an earlier attempt already had. A write that failed is rethrown, and one that changed
 * nothing and did not land is refused with `refuse`'s error.
 */
async function verifiedWrite<T>(args: {
  write: () => Promise<D1Result>;
  read: () => Promise<T>;
  landed: (committed: T) => boolean;
  refuse: (committed: T) => Error | Promise<Error>;
}): Promise<T | null> {
  let result: D1Result;
  try {
    result = await args.write();
  } catch (error) {
    // The write may have landed with its acknowledgement lost: read it back, twice, before reporting it failed.
    const committed = await args
      .read()
      .catch(args.read)
      .catch(() => null);
    if (committed !== null && args.landed(committed)) {
      return committed;
    }
    throw error;
  }
  if (result.meta.changes === 1) {
    return null;
  }
  const committed = await args.read();
  if (args.landed(committed)) {
    return committed;
  }
  throw await args.refuse(committed);
}

function isExactDeploymentTransition(
  deployment: Deployment,
  args: {
    executionGeneration: number;
    nextStatus: DeploymentStatus;
    productionUrl?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
  now: number,
): boolean {
  return (
    deployment.executionGeneration === args.executionGeneration &&
    deployment.status === args.nextStatus &&
    deployment.productionUrl === (args.productionUrl ?? null) &&
    deployment.errorCode === (args.errorCode ?? null) &&
    deployment.errorMessage === (args.errorMessage ?? null) &&
    deployment.updatedAt === now
  );
}

type ClaimedDeployment = { deployment: Deployment; claimId: string | null };

async function readClaimedDeployment(db: D1Database, deploymentId: string, userId: string): Promise<ClaimedDeployment> {
  const row = await db
    .prepare(`SELECT ${DEPLOYMENT_COLUMNS}, claim_id FROM deployments WHERE id = ? AND user_id = ?`)
    .bind(deploymentId, userId)
    .first<DeploymentRow & { claim_id: string | null }>();
  if (!row) {
    throw new DeploymentNotFoundError();
  }
  return { deployment: deploymentFromRow(row), claimId: row.claim_id };
}

/** Whether the committed record is this claim's, by the claim id it wrote, which no other claim shares. */
function isExactDeploymentClaim(committed: ClaimedDeployment, expected: Deployment, claim: string): boolean {
  const { deployment } = committed;
  return (
    deployment.status === 'provisioning' &&
    deployment.executionGeneration === expected.executionGeneration &&
    sameDeploymentIdentity(deployment, expected) &&
    committed.claimId === claim
  );
}

function isExactDeploymentRetry(deployment: Deployment, expected: Deployment, now: number): boolean {
  return (
    deployment.status === 'approved' &&
    deployment.executionGeneration === expected.executionGeneration + 1 &&
    deployment.productionUrl === null &&
    deployment.errorCode === null &&
    deployment.errorMessage === null &&
    deployment.updatedAt === now &&
    sameDeploymentIdentity(deployment, expected)
  );
}

function requireCurrentConnection(
  deployment: Deployment,
  args: { connectionId: string; connectionGeneration: number },
): void {
  if (deployment.connectionId !== args.connectionId || deployment.connectionGeneration !== args.connectionGeneration) {
    throw new DeploymentConnectionChangedError();
  }
}

function sameDeploymentIdentity(current: Deployment, expected: Deployment): boolean {
  return (
    current.id === expected.id &&
    current.chatId === expected.chatId &&
    current.userId === expected.userId &&
    current.connectionId === expected.connectionId &&
    current.connectionGeneration === expected.connectionGeneration &&
    current.workspaceReference === expected.workspaceReference &&
    current.planDigest === expected.planDigest &&
    current.plan.deploymentId === expected.plan.deploymentId &&
    current.createdAt === expected.createdAt
  );
}

function deploymentFromRow(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    chatId: row.workspace_id,
    userId: row.user_id,
    connectionId: row.connection_id,
    connectionGeneration: row.connection_generation,
    executionGeneration: row.execution_generation,
    workspaceReference: row.workspace_reference,
    status: row.status,
    plan: parseDeploymentPlanJson(row.plan_json),
    planDigest: row.plan_digest,
    productionUrl: row.production_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DeploymentNotFoundError extends Error {
  constructor() {
    super('Deployment not found.');
    this.name = 'DeploymentNotFoundError';
  }
}

export class DeploymentConnectionChangedError extends Error {
  constructor() {
    super('The Cloudflare connection changed and this deployment must be prepared again.');
    this.name = 'DeploymentConnectionChangedError';
  }
}

export class DeploymentStateConflictError extends Error {
  constructor(readonly status: DeploymentStatus) {
    super(`Deployment cannot continue from status ${status}.`);
    this.name = 'DeploymentStateConflictError';
  }
}

export class DeploymentConcurrencyLimitError extends Error {
  constructor() {
    super('Finish the active deployment before starting another one.');
    this.name = 'DeploymentConcurrencyLimitError';
  }
}
