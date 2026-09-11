import { getOptionalBinding } from '~/lib/.server/env';
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
  requireDeploymentForUser,
  type Deployment,
} from '~/lib/.server/cloudflare/deployment-repository';
import { findChat } from '~/lib/cloudflare/data/chat-repository.server';
import {
  executeUserOwnedDeployment,
  executeUserOwnedPreview,
  terminalizeInterruptedUserOwnedDeployment,
} from '~/lib/.server/cloudflare/user-workspace-deployment-executor';

type PublicDeployment = ReturnType<typeof publicDeployment>;

export async function createOrReplayDeploymentPlanForUser(args: {
  env: Env;
  userId: string;
  chatId: string;
  deploymentId: string;
  projectId?: string;
  revision?: string;
  workspaceRevision?: number;
  project?: DeploymentProjectProfile;
}) {
  try {
    const existing = await requireDeploymentForUser(args.env.DB, args.deploymentId, args.userId);
    if (existing.workspaceReference === workspaceReference(requireWorkspaceDeploymentArgs(args))) {
      return publicDeployment(existing);
    }
  } catch (error) {
    if (!(error instanceof DeploymentNotFoundError)) {
      throw error;
    }
  }
  const workspaceArgs = requireWorkspaceDeploymentArgs(args);
  const connection = runtimeCloudflareIdentity(workspaceArgs.env, workspaceArgs.userId);
  const chat = await findChat(workspaceArgs.env.DB, { id: workspaceArgs.chatId, sessionId: workspaceArgs.userId });
  if (!chat) {
    throw new DeploymentChatNotFoundError();
  }
  const { plan, digest } = await buildDeploymentPlanFromSource({
    deploymentId: workspaceArgs.deploymentId,
    sourceSha256: workspaceArgs.revision,
    project: workspaceArgs.project,
  });
  return publicDeployment(
    await createDeployment({
      db: workspaceArgs.env.DB,
      id: workspaceArgs.deploymentId,
      chatId: chat.id,
      userId: workspaceArgs.userId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      workspaceReference: workspaceReference(workspaceArgs),
      plan,
      planDigest: digest,
    }),
  );
}

/** Terminalize an execution whose durable fiber was interrupted so a retry cannot be blocked indefinitely. */
export async function terminalizeInterruptedDeploymentForUser(args: {
  env: Env;
  deploymentId: string;
  userId: string;
}): Promise<PublicDeployment | null> {
  const connection = runtimeCloudflareIdentity(args.env, args.userId);
  const deployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, args.userId).catch((error) => {
    if (error instanceof DeploymentNotFoundError) {
      return null;
    }
    throw error;
  });
  if (!deployment) {
    return null;
  }
  if (deployment.status !== 'provisioning' && deployment.status !== 'deploying') {
    return publicDeployment(deployment);
  }
  return publicDeployment(
    await terminalizeInterruptedUserOwnedDeployment({
      env: args.env,
      deploymentId: deployment.id,
      userId: args.userId,
      connectionId: connection.id,
      executionGeneration: deployment.executionGeneration,
    }),
  );
}

/** Start or resume one exact-revision deployment without a client-side approval protocol. */
export async function deployForUser(args: {
  env: Env;
  deploymentId: string;
  userId: string;
}): Promise<PublicDeployment> {
  const connection = runtimeCloudflareIdentity(args.env, args.userId);
  let deployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, args.userId);
  await requireActiveDeploymentChat(args.env.DB, deployment);
  if (!isCurrentDeploymentPlan(deployment.plan)) {
    throw new DeploymentStateConflictError(deployment.status);
  }
  if (deployment.connectionId !== connection.id || deployment.connectionGeneration !== connection.generation) {
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
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      executionGeneration: deployment.executionGeneration,
    });
  }
  if (deployment.status !== 'approved') {
    throw new DeploymentStateConflictError(deployment.status);
  }
  return publicDeployment(
    await executeUserOwnedDeployment({
      env: args.env,
      deploymentId: deployment.id,
      userId: args.userId,
      connectionId: connection.id,
      executionGeneration: deployment.executionGeneration,
    }),
  );
}

/** Create an unpromoted preview version under the same plan and credential boundary as deployment. */
export async function previewForUser(args: { env: Env; deploymentId: string; previewId: string; userId: string }) {
  const connection = runtimeCloudflareIdentity(args.env, args.userId);
  const deployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, args.userId);
  await requireActiveDeploymentChat(args.env.DB, deployment);
  if (!isCurrentDeploymentPlan(deployment.plan)) {
    throw new DeploymentStateConflictError(deployment.status);
  }
  if (deployment.connectionId !== connection.id || deployment.connectionGeneration !== connection.generation) {
    throw new DeploymentConnectionChangedError();
  }
  if (deployment.status === 'provisioning' || deployment.status === 'deploying') {
    throw new DeploymentStateConflictError(deployment.status);
  }
  return executeUserOwnedPreview({
    env: args.env,
    deploymentId: deployment.id,
    previewId: args.previewId,
    userId: args.userId,
    connectionId: connection.id,
    executionGeneration: deployment.executionGeneration,
  });
}

export async function userRuntimeDeploymentAction(args: {
  env: Env;
  deploymentId: string;
  operation: 'get' | 'deploy';
  userId: string;
}): Promise<Response> {
  try {
    if (args.operation === 'get') {
      const deployment = await requireDeploymentForUser(args.env.DB, args.deploymentId, args.userId);
      const activity = await listDeploymentActivity(args.env.DB, deployment.id, deployment.executionGeneration);
      return Response.json({ deployment: { ...publicDeployment(deployment), activity } });
    }
    return Response.json({ deployment: await deployForUser(args) });
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

function requireWorkspaceDeploymentArgs(args: {
  env: Env;
  userId: string;
  chatId: string;
  deploymentId: string;
  projectId?: string;
  revision?: string;
  workspaceRevision?: number;
  project?: DeploymentProjectProfile;
}) {
  const { projectId, revision, workspaceRevision, project } = args;
  if (projectId === undefined || revision === undefined || workspaceRevision === undefined || !project) {
    throw new Error('The user-owned workspace deployment reference is incomplete.');
  }
  return { ...args, projectId, revision, workspaceRevision, project };
}

function workspaceReference(args: { projectId: string; revision: string; workspaceRevision: number }): string {
  if (!/^[a-f0-9]{64}$/.test(args.revision) || !Number.isSafeInteger(args.workspaceRevision)) {
    throw new Error('The user-owned workspace deployment reference is invalid.');
  }
  return `workspace-runtime:${encodeURIComponent(args.projectId)}:${args.workspaceRevision}:${args.revision}`;
}

async function requireActiveDeploymentChat(db: D1Database, deployment: Deployment): Promise<void> {
  const active = await db
    .prepare(`SELECT 1 AS found FROM chats WHERE id = ? AND creator_id = ? AND is_deleted = 0 LIMIT 1`)
    .bind(deployment.chatId, deployment.userId)
    .first<{ found: number }>();
  if (!active) {
    throw new DeploymentChatNotFoundError();
  }
}

type RuntimeCloudflareIdentity = {
  id: string;
  generation: number;
};

function runtimeCloudflareIdentity(env: Env, userId: string): RuntimeCloudflareIdentity {
  const connectionId = getOptionalBinding(env, 'GHOSTBUILD_CONNECTION_ID');
  const generation = Number(getOptionalBinding(env, 'GHOSTBUILD_CONNECTION_GENERATION'));
  if (
    getOptionalBinding(env, 'GHOSTBUILD_USER_RUNTIME') !== '1' ||
    getOptionalBinding(env, 'GHOSTBUILD_USER_ID') !== userId ||
    !connectionId ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw new DeploymentConnectionRequiredError();
  }
  return { id: connectionId, generation };
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
  if (error instanceof DeploymentChatNotFoundError || error instanceof DeploymentNotFoundError) {
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
class DeploymentChatNotFoundError extends Error {
  constructor() {
    super('Chat not found.');
    this.name = 'DeploymentChatNotFoundError';
  }
}
