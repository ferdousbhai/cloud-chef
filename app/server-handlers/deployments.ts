import {
  runtimeConnectionIdentity,
  type RuntimeConnectionIdentity,
} from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { buildDeploymentPlanFromSource, isCurrentDeploymentPlan } from '~/lib/.server/cloudflare/deployment-plan';
import type { DeploymentProjectProfile } from '~/lib/.server/cloudflare/deployment-project-profile';
import {
  createDeployment,
  DeploymentConcurrencyLimitError,
  DeploymentConnectionChangedError,
  DeploymentNotFoundError,
  DeploymentStateConflictError,
  listDeploymentActivity,
  prepareDeploymentRetry,
  requireDeployment,
  type Deployment,
} from '~/lib/.server/cloudflare/deployment-repository';
import { appResourceIdentity } from '~/lib/cloudflare/app-resource-names';
import { findWorkspace } from '~/lib/cloudflare/data/workspace-repository.server';
import {
  executeUserOwnedDeployment,
  terminalizeInterruptedUserOwnedDeployment,
} from '~/lib/.server/cloudflare/user-workspace-deployment-executor';
import { workspaceReference } from '~/lib/.server/cloudflare/workspace-reference';

export type PublicDeployment = ReturnType<typeof publicDeployment>;

/** One execution of a deployment record: the record, and the execution generation it ran as. */
export type DeploymentExecution = { deploymentId: string; executionGeneration: number };

/** A deployment record as a settle left it, and whether that settle is what settled it. */
type DeploymentSettle = { deployment: PublicDeployment; settled: boolean };

/**
 * Create the deployment plan of this id, or replay the one stored under it. A stored plan is replayed
 * only while it is the plan this revision would get now, under the current connection: one made before
 * the project's resources were named as they are now, or before the connection changed, is refused by
 * the executor every time, so it answers null and the caller plans the revision under another id.
 */
export async function createOrReplayDeploymentPlanForUser(args: {
  env: Env;
  userId: string;
  workspaceId: string;
  deploymentId: string;
  projectId: string;
  revision: string;
  workspaceRevision: number;
  project: DeploymentProjectProfile;
}): Promise<PublicDeployment | null> {
  const reference = workspaceReference(args);
  const stored = await requireDeployment(args.env.DB, args.deploymentId, args.userId).catch((error) => {
    if (error instanceof DeploymentNotFoundError) {
      return null;
    }
    throw error;
  });
  const existing = stored?.workspaceReference === reference ? stored : null;
  const connection = runtimeCloudflareIdentity(args.env, args.userId);
  const workspace = await findWorkspace(args.env.DB, { id: args.workspaceId, sessionId: args.userId });
  if (!workspace) {
    throw new DeploymentWorkspaceNotFoundError();
  }
  const { plan, digest } = await buildDeploymentPlanFromSource({
    deploymentId: args.deploymentId,
    sourceSha256: args.revision,
    project: args.project,
    // The revision deploys onto the project's resources, not resources of its own.
    naming: { identity: await appResourceIdentity(args.projectId) },
  });
  if (existing) {
    const current =
      existing.planDigest === digest &&
      existing.connectionId === connection.connectionId &&
      existing.connectionGeneration === connection.connectionGeneration;
    return current ? publicDeployment(existing) : null;
  }
  return publicDeployment(
    await createDeployment({
      db: args.env.DB,
      id: args.deploymentId,
      workspaceId: workspace.id,
      userId: args.userId,
      connectionId: connection.connectionId,
      connectionGeneration: connection.connectionGeneration,
      workspaceReference: reference,
      plan,
      planDigest: digest,
    }),
  );
}

/**
 * Terminalize an execution whose durable fiber was interrupted so a retry cannot be blocked indefinitely.
 * Given the `executionGeneration` seen holding the record, it settles only that execution: a record a
 * later execution holds is answered as it is, and the settling write itself matches the generation.
 * Only a record this call settled is answered `settled`: one found settled, or held by a later
 * execution, says nothing of what production serves now.
 */
export async function terminalizeInterruptedDeploymentForUser(args: {
  env: Env;
  deploymentId: string;
  userId: string;
  executionGeneration?: number;
}): Promise<DeploymentSettle | null> {
  const connection = runtimeCloudflareIdentity(args.env, args.userId);
  const deployment = await requireDeployment(args.env.DB, args.deploymentId, args.userId).catch((error) => {
    if (error instanceof DeploymentNotFoundError) {
      return null;
    }
    throw error;
  });
  if (!deployment) {
    return null;
  }
  const executionGeneration = args.executionGeneration ?? deployment.executionGeneration;
  if (
    (deployment.status !== 'provisioning' && deployment.status !== 'deploying') ||
    deployment.executionGeneration !== executionGeneration
  ) {
    return { deployment: publicDeployment(deployment), settled: false };
  }
  const settled = await terminalizeInterruptedUserOwnedDeployment({
    env: args.env,
    deploymentId: deployment.id,
    userId: args.userId,
    connectionId: connection.connectionId,
    executionGeneration,
  });
  return { deployment: publicDeployment(settled), settled: true };
}

/** Start or resume one exact-revision deployment without a client-side approval protocol. */
export async function deployForUser(args: {
  env: Env;
  deploymentId: string;
  userId: string;
  abortSignal?: AbortSignal;
  /** Called with the execution about to run, before it claims the record. */
  onExecution?: (execution: DeploymentExecution) => void;
}): Promise<PublicDeployment> {
  const connection = runtimeCloudflareIdentity(args.env, args.userId);
  let deployment = await requireDeployment(args.env.DB, args.deploymentId, args.userId);
  await requireActiveDeploymentChat(args.env.DB, deployment);
  if (!isCurrentDeploymentPlan(deployment.plan)) {
    throw new DeploymentStateConflictError(deployment.status);
  }
  if (
    deployment.connectionId !== connection.connectionId ||
    deployment.connectionGeneration !== connection.connectionGeneration
  ) {
    throw new DeploymentConnectionChangedError();
  }
  if (deployment.status === 'succeeded' || deployment.status === 'provisioning' || deployment.status === 'deploying') {
    return publicDeployment(deployment);
  }
  if (deployment.status === 'failed') {
    deployment = await prepareDeploymentRetry({
      db: args.env.DB,
      deploymentId: deployment.id,
      userId: args.userId,
      connectionId: connection.connectionId,
      connectionGeneration: connection.connectionGeneration,
      executionGeneration: deployment.executionGeneration,
    });
  }
  if (deployment.status !== 'approved') {
    throw new DeploymentStateConflictError(deployment.status);
  }
  args.onExecution?.({ deploymentId: deployment.id, executionGeneration: deployment.executionGeneration });
  return publicDeployment(
    await executeUserOwnedDeployment({
      env: args.env,
      deploymentId: deployment.id,
      userId: args.userId,
      connectionId: connection.connectionId,
      executionGeneration: deployment.executionGeneration,
      abortSignal: args.abortSignal,
    }),
  );
}

export async function userRuntimeDeploymentAction(args: {
  env: Env;
  deploymentId: string;
  operation: 'get' | 'deploy';
  userId: string;
}): Promise<Response> {
  try {
    if (args.operation === 'get') {
      const deployment = await requireDeployment(args.env.DB, args.deploymentId, args.userId);
      const activity = await listDeploymentActivity(args.env.DB, deployment.id, deployment.executionGeneration);
      return Response.json({ deployment: { ...publicDeployment(deployment), activity } });
    }
    return Response.json({ deployment: await deployForUser(args) });
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

async function requireActiveDeploymentChat(db: D1Database, deployment: Deployment): Promise<void> {
  const active = await db
    .prepare(`SELECT 1 AS found FROM workspaces WHERE id = ? AND creator_id = ? AND is_deleted = 0 LIMIT 1`)
    .bind(deployment.workspaceId, deployment.userId)
    .first<{ found: number }>();
  if (!active) {
    throw new DeploymentWorkspaceNotFoundError();
  }
}

/** The connection this user-owned runtime was provisioned for, which must be the requesting person's. */
function runtimeCloudflareIdentity(env: Env, userId: string): RuntimeConnectionIdentity {
  const connection = runtimeConnectionIdentity(env);
  if (connection?.userId !== userId) {
    throw new DeploymentConnectionRequiredError();
  }
  return connection;
}

function publicDeployment(deployment: Deployment) {
  return {
    id: deployment.id,
    status: deployment.status,
    productionUrl: deployment.productionUrl,
    error: deployment.errorCode
      ? { code: deployment.errorCode, message: deployment.errorMessage ?? 'Deployment failed.' }
      : null,
    updatedAt: deployment.updatedAt,
  };
}

function deploymentErrorResponse(error: unknown): Response {
  if (error instanceof DeploymentConnectionRequiredError) {
    return Response.json({ error: 'Connect Cloudflare before deploying.' }, { status: 409 });
  }
  if (error instanceof DeploymentWorkspaceNotFoundError || error instanceof DeploymentNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (
    error instanceof DeploymentConcurrencyLimitError ||
    error instanceof DeploymentConnectionChangedError ||
    error instanceof DeploymentStateConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  console.error('Deployment request failed');
  return Response.json({ error: 'Unable to process the deployment.' }, { status: 500 });
}

class DeploymentConnectionRequiredError extends Error {}
class DeploymentWorkspaceNotFoundError extends Error {
  constructor() {
    super('Chat not found.');
    this.name = 'DeploymentWorkspaceNotFoundError';
  }
}
