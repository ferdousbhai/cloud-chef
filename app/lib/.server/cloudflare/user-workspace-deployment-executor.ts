import { deploymentPlanResourceName, isCurrentDeploymentPlan } from './deployment-plan';
import {
  claimApprovedDeployment,
  findDeploymentResource,
  recordDeploymentActivity,
  recordDeploymentResource,
  requireDeployment,
  transitionDeployment,
  type Deployment,
  type DeploymentStatus,
} from './deployment-repository';
import { validatePreparedDeploymentArtifact, type PreparedDeploymentArtifact } from './deployment-artifact';
import type { DeploymentProjectProfile } from './deployment-project-profile';
import { UserCloudflareAccountApi, type ManagedWorkerVersionArgs } from './user-account-api';
import { GHOSTBUILD_CONTROL_PLANE_ENDPOINT } from './user-workspace-runtime-policy';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';

type UserOwnedDeploymentArgs = {
  env: Env;
  deploymentId: string;
  userId: string;
  connectionId: string;
  executionGeneration: number;
  request?: typeof fetch;
};

type UserOwnedRuntimeContext = {
  runtimeEnv: Env;
  connectionGeneration: number;
  request: typeof fetch;
  accountId: string;
};

type ProjectWorkspaceStub = ReturnType<Env['PROJECT_WORKSPACE']['get']>;
type WorkspaceReference = ReturnType<typeof parseWorkspaceReference>;
type PublicationSession = { sessionId: string; finish(status: 'completed' | 'failed'): Promise<void> };

/**
 * Deployment binds the production databases and promotes the version it uploads; preview binds the
 * per-project preview databases and leaves the version unpromoted. Everything between — resource
 * provisioning, artifact preparation, migrations, upload — is the same path.
 */
const PRODUCTION_D1_BINDINGS = { app: 'DB', agentSecurity: 'AGENT_SECURITY_DB' } as const;
const PREVIEW_D1_BINDINGS = { app: 'DB_PREVIEW', agentSecurity: 'AGENT_SECURITY_DB_PREVIEW' } as const;
type PublicationD1Bindings = typeof PRODUCTION_D1_BINDINGS | typeof PREVIEW_D1_BINDINGS;

/** Which of the plan's provider resources this publication needs, before any of them exist. */
type PublicationResourcePlan = {
  d1: PublicationD1Bindings['app'] | null;
  agentD1: PublicationD1Bindings['agentSecurity'] | null;
  r2: boolean;
  kv: boolean;
};

type PublicationResources = {
  d1: { id: string; name: string } | null;
  agentD1: { id: string; name: string } | null;
  r2: { id: string; name: string } | null;
  kv: { id: string; name: string } | null;
};

export async function terminalizeInterruptedUserOwnedDeployment(args: UserOwnedDeploymentArgs): Promise<Deployment> {
  const deployment = await requireDeployment(args.env.DB, args.deploymentId);
  requireExecutionIdentityForRecovery(deployment, args);
  const reference = parseWorkspaceReference(deployment.workspaceReference);
  const workspace = args.env.PROJECT_WORKSPACE.get(args.env.PROJECT_WORKSPACE.idFromName(reference.projectId));
  await workspace.terminalizeInterruptedDeploymentSession({
    sessionId: `${deployment.id}:${args.executionGeneration}`,
  });
  await transitionDeployment({
    db: args.env.DB,
    deploymentId: deployment.id,
    executionGeneration: args.executionGeneration,
    expectedStatus: deployment.status,
    nextStatus: 'failed',
    errorCode: 'cloudflare_cleanup_required',
    errorMessage: 'Deployment was interrupted. Retry to reconcile the exact revision.',
  });
  return requireDeployment(args.env.DB, deployment.id);
}

/** Publish one validated artifact as the promoted Worker version in the user's account. */
export async function executeUserOwnedDeployment(args: UserOwnedDeploymentArgs): Promise<Deployment> {
  let phase: DeploymentStatus = 'approved';
  let providerChangesPossible = false;
  let session: PublicationSession | null = null;
  try {
    const { runtimeEnv, connectionGeneration, request, accountId } = requireUserOwnedRuntimeContext(args);
    let deployment = await requireDeployment(args.env.DB, args.deploymentId);
    requireExecutionIdentity(deployment, args);
    deployment = await claimApprovedDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      userId: args.userId,
      connectionId: args.connectionId,
      connectionGeneration,
      executionGeneration: args.executionGeneration,
    });
    phase = 'provisioning';
    await activity(args, 10, 'Preparing Cloudflare resources');
    const accountApi = await createUserAccountApi(runtimeEnv, request);
    const reference = requireApprovedWorkspaceReference(deployment, 'deployment');
    const workspace = runtimeEnv.PROJECT_WORKSPACE.get(runtimeEnv.PROJECT_WORKSPACE.idFromName(reference.projectId));
    const operationId = `${deployment.id}:${args.executionGeneration}`;
    session = await beginPublicationSession(workspace, operationId, reference);

    const resourcePlan = publicationResourcePlan(deployment.plan, PRODUCTION_D1_BINDINGS);
    // Provisioning can create account resources before it fails, so a plan that names any of them
    // makes provider cleanup possible from here on.
    providerChangesPossible = Boolean(resourcePlan.d1 || resourcePlan.agentD1 || resourcePlan.r2 || resourcePlan.kv);
    const resources = await ensurePublicationResources({ db: args.env.DB, deployment, accountApi, resourcePlan });
    await activity(args, 20, 'Cloudflare resources ready');
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: 'provisioning',
      nextStatus: 'deploying',
    });
    phase = 'deploying';
    deployment = await requireDeployment(args.env.DB, deployment.id);
    const workerName = requireResourceName(deployment, 'worker', 'app');
    const profile = deployment.plan.project;
    const artifact = await prepareValidatedArtifact({
      workspace,
      sessionId: session.sessionId,
      operationId,
      executionGeneration: args.executionGeneration,
      deployment,
      reference,
      accountId,
      workerName,
      profile,
      resources,
    });

    // The build may take several minutes. Resolve again at the authenticated
    // boundary; the credential vault refreshes expiring tokens and the API
    // client retries once if Cloudflare reports that the token expired.
    const publishApi = await createUserAccountApi(runtimeEnv, request);
    await workspace.assertDeploymentSession({ sessionId: session.sessionId });
    await activity(args, 40, 'Applying database migrations');
    await applyArtifactMigrations(publishApi, resources, artifact);
    providerChangesPossible = true;
    await activity(args, 50, 'Uploading assets and publishing Worker');
    await publishApi.deployManagedWorker(
      managedWorkerVersionArgs({ workerName, profile, reference, artifact, resources }),
    );
    await activity(args, 60, 'Configuring public Cloudflare route');
    await publishApi.configureManagedWorkerSchedule(workerName, profile.bindings.appAgent);
    await publishApi.enableWorkerSubdomain(workerName);
    await recordResource(args.env.DB, deployment.id, 'worker', 'app', workerName);
    const workersSubdomain = await publishApi.getWorkersSubdomain();
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: 'deploying',
      nextStatus: 'succeeded',
      productionUrl: `https://${workerName}.${workersSubdomain}.workers.dev`,
    });
    await activity(args, 80, 'Deployment complete');
    await session.finish('completed');
    return requireDeployment(args.env.DB, deployment.id);
  } catch (error) {
    if (phase !== 'approved') {
      await transitionDeployment({
        db: args.env.DB,
        deploymentId: args.deploymentId,
        executionGeneration: args.executionGeneration,
        expectedStatus: phase,
        nextStatus: 'failed',
        errorCode: providerChangesPossible ? 'cloudflare_cleanup_required' : `deployment_${phase}_failed`,
        errorMessage: safeError(error),
      }).catch(() => console.error('Unable to persist user-owned deployment failure'));
    }
    throw error;
  } finally {
    await session
      ?.finish('failed')
      .catch(() => console.error('Unable to finalize ProjectWorkspace deployment session'));
  }
}

export type UserOwnedPreviewResult = {
  id: string;
  url: string;
  workspaceRevision: number;
  snapshotRevision: string;
  readyAt: string;
};

/** Publish one validated artifact as an unpromoted Worker version in the user's account. */
export async function executeUserOwnedPreview(
  args: UserOwnedDeploymentArgs & { previewId: string },
): Promise<UserOwnedPreviewResult> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.previewId)) {
    throw new Error('Preview identity is invalid.');
  }
  const { runtimeEnv, connectionGeneration, request, accountId } = requireUserOwnedRuntimeContext(args);
  const deployment = await requireDeployment(args.env.DB, args.deploymentId);
  requirePreviewExecutionIdentity(deployment, args, connectionGeneration);
  const reference = requireApprovedWorkspaceReference(deployment, 'preview');
  const workspace = runtimeEnv.PROJECT_WORKSPACE.get(runtimeEnv.PROJECT_WORKSPACE.idFromName(reference.projectId));
  const workerName = requireResourceName(deployment, 'worker', 'app');
  const versionReceipt = await findDeploymentResource(
    args.env.DB,
    deployment.id,
    'worker_version',
    `preview:${args.previewId}`,
  );
  if (versionReceipt) {
    const accountApi = await createUserAccountApi(runtimeEnv, request);
    return {
      id: versionReceipt.providerResourceId,
      url: await accountApi.readManagedWorkerPreviewUrl(workerName, versionReceipt.providerResourceId),
      workspaceRevision: reference.workspaceRevision,
      snapshotRevision: reference.revision,
      readyAt: new Date(versionReceipt.createdAt).toISOString(),
    };
  }
  const operationId = `preview:${deployment.id}:${args.executionGeneration}:${args.previewId}`;
  const session = await beginPublicationSession(workspace, operationId, reference);
  try {
    await activity(args, 1, 'Preparing Cloudflare preview resources');
    const provisionApi = await createUserAccountApi(runtimeEnv, request);
    const resources = await ensurePublicationResources({
      db: args.env.DB,
      deployment,
      accountApi: provisionApi,
      resourcePlan: publicationResourcePlan(deployment.plan, PREVIEW_D1_BINDINGS),
    });
    await activity(args, 2, 'Cloudflare preview resources ready');

    const profile = deployment.plan.project;
    const artifact = await prepareValidatedArtifact({
      workspace,
      sessionId: session.sessionId,
      operationId,
      executionGeneration: args.executionGeneration,
      deployment,
      reference,
      accountId,
      workerName,
      profile,
      resources,
    });
    await workspace.assertDeploymentSession({ sessionId: session.sessionId });

    const publishApi = await createUserAccountApi(runtimeEnv, request);
    await activity(args, 3, 'Applying preview database migrations');
    await applyArtifactMigrations(publishApi, resources, artifact);
    await activity(args, 4, 'Uploading assets and Worker preview version');
    const published = await publishApi.previewManagedWorker(
      managedWorkerVersionArgs({ workerName, profile, reference, artifact, resources }),
    );
    await recordResource(args.env.DB, deployment.id, 'worker', 'app', workerName);
    await recordResource(
      args.env.DB,
      deployment.id,
      'worker_version',
      `preview:${args.previewId}`,
      published.workerVersionId,
    );
    const checkpoint = await workspace.assertDeploymentSession({ sessionId: session.sessionId });
    const readyAt = new Date().toISOString();
    await activity(args, 5, 'Workers preview ready');
    await session.finish('completed');
    return {
      id: published.workerVersionId,
      url: published.previewUrl,
      workspaceRevision: checkpoint.workspaceRevision,
      snapshotRevision: checkpoint.revision,
      readyAt,
    };
  } finally {
    await session.finish('failed').catch(() => console.error('Unable to finalize ProjectWorkspace preview session'));
  }
}

async function beginPublicationSession(
  workspace: ProjectWorkspaceStub,
  operationId: string,
  reference: WorkspaceReference,
): Promise<PublicationSession> {
  await workspace.beginDeploymentSession({
    operationId,
    expectedWorkspaceRevision: reference.workspaceRevision,
    expectedSnapshotRevision: reference.revision,
  });
  const sessionId = operationId;
  let finished = false;
  return {
    sessionId,
    async finish(status) {
      if (finished) {
        return;
      }
      await workspace.finishDeploymentSession({ sessionId, status });
      finished = true;
    },
  };
}

function publicationResourcePlan(plan: Deployment['plan'], bindings: PublicationD1Bindings): PublicationResourcePlan {
  return {
    d1: deploymentPlanResourceName(plan, 'd1', bindings.app) ? bindings.app : null,
    agentD1: deploymentPlanResourceName(plan, 'd1', bindings.agentSecurity) ? bindings.agentSecurity : null,
    r2: deploymentPlanResourceName(plan, 'r2', 'APP_STORAGE') !== null,
    kv: deploymentPlanResourceName(plan, 'kv', 'APP_CACHE') !== null,
  };
}

async function ensurePublicationResources(args: {
  db: D1Database;
  deployment: Deployment;
  accountApi: UserCloudflareAccountApi;
  resourcePlan: PublicationResourcePlan;
}): Promise<PublicationResources> {
  const { db, deployment, accountApi, resourcePlan } = args;
  const resources: PublicationResources = { d1: null, agentD1: null, r2: null, kv: null };
  if (resourcePlan.d1) {
    resources.d1 = await accountApi.ensureD1ForPlan(deployment.plan, resourcePlan.d1);
    await recordResource(db, deployment.id, 'd1', resourcePlan.d1, resources.d1.id);
  }
  if (resourcePlan.agentD1) {
    resources.agentD1 = await accountApi.ensureD1ForPlan(deployment.plan, resourcePlan.agentD1);
    await recordResource(db, deployment.id, 'd1', resourcePlan.agentD1, resources.agentD1.id);
  }
  if (resourcePlan.r2) {
    resources.r2 = await accountApi.ensureR2ForPlan(deployment.plan);
    await recordResource(db, deployment.id, 'r2', 'APP_STORAGE', resources.r2.id);
  }
  if (resourcePlan.kv) {
    resources.kv = await accountApi.ensureKvForPlan(deployment.plan);
    await recordResource(db, deployment.id, 'kv', 'APP_CACHE', resources.kv.id);
  }
  return resources;
}

async function prepareValidatedArtifact(args: {
  workspace: ProjectWorkspaceStub;
  sessionId: string;
  operationId: string;
  executionGeneration: number;
  deployment: Deployment;
  reference: WorkspaceReference;
  accountId: string;
  workerName: string;
  profile: DeploymentProjectProfile;
  resources: PublicationResources;
}): Promise<PreparedDeploymentArtifact> {
  const { deployment, reference, profile, resources } = args;
  return validatePreparedDeploymentArtifact(
    await args.workspace.prepareDeploymentArtifact({
      sessionId: args.sessionId,
      operationId: args.operationId,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      revision: reference.revision,
      accountId: args.accountId,
      workerName: args.workerName,
      projectType: profile.type,
      workersAi: profile.bindings.ai,
      appAgent: profile.bindings.appAgent,
      d1DatabaseId: resources.d1?.id,
      d1DatabaseName: resources.d1?.name,
      agentSecurityD1DatabaseId: resources.agentD1?.id,
      agentSecurityD1DatabaseName: resources.agentD1?.name,
      r2BucketName: resources.r2?.name,
      kvNamespaceId: resources.kv?.id,
    }),
    { revision: reference.revision, projectType: profile.type },
  );
}

async function applyArtifactMigrations(
  accountApi: UserCloudflareAccountApi,
  resources: PublicationResources,
  artifact: PreparedDeploymentArtifact,
): Promise<void> {
  if (resources.d1) {
    await accountApi.applyD1Migrations(resources.d1.id, artifact.migrations.DB);
  }
  if (resources.agentD1) {
    await accountApi.applyD1Migrations(resources.agentD1.id, artifact.migrations.AGENT_SECURITY_DB);
  }
}

function managedWorkerVersionArgs(args: {
  workerName: string;
  profile: DeploymentProjectProfile;
  reference: WorkspaceReference;
  artifact: PreparedDeploymentArtifact;
  resources: PublicationResources;
}): ManagedWorkerVersionArgs {
  const { profile, artifact, resources } = args;
  return {
    workerName: args.workerName,
    projectType: profile.type,
    sourceSha256: args.reference.revision,
    mainModule: artifact.mainModule,
    modules: artifact.modules,
    assets: artifact.assets,
    workersAi: profile.bindings.ai,
    appAgent: profile.bindings.appAgent,
    d1DatabaseId: resources.d1?.id,
    agentSecurityD1DatabaseId: resources.agentD1?.id,
    r2BucketName: resources.r2?.name,
    kvNamespaceId: resources.kv?.id,
  };
}

function activity(args: UserOwnedDeploymentArgs, sequence: number, message: string): Promise<void> {
  return recordDeploymentActivity({
    db: args.env.DB,
    deploymentId: args.deploymentId,
    executionGeneration: args.executionGeneration,
    sequence,
    message,
  });
}

export async function resolveFreshCloudflareAccessToken(
  env: {
    GHOSTBUILD_CONTROL_PLANE_ENDPOINT?: string;
    CONTROL_PLANE_SECRET?: string;
    GHOSTBUILD_USER_ID?: string;
    GHOSTBUILD_CONNECTION_ID?: string;
    GHOSTBUILD_CONNECTION_GENERATION?: string;
  },
  request: typeof fetch = fetch,
  forceRefresh = false,
): Promise<string> {
  if (
    env.GHOSTBUILD_CONTROL_PLANE_ENDPOINT !== GHOSTBUILD_CONTROL_PLANE_ENDPOINT ||
    !env.CONTROL_PLANE_SECRET ||
    !env.GHOSTBUILD_USER_ID ||
    !env.GHOSTBUILD_CONNECTION_ID
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const connectionGeneration = Number(env.GHOSTBUILD_CONNECTION_GENERATION);
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const response = await request(`${GHOSTBUILD_CONTROL_PLANE_ENDPOINT}/api/cloudflare/runtime-credential`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CONTROL_PLANE_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId: env.GHOSTBUILD_USER_ID,
      connectionId: env.GHOSTBUILD_CONNECTION_ID,
      connectionGeneration,
      forceRefresh,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Cloudflare connection is unavailable.');
  }
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (!containsNoStore(cacheControl)) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  let body: Record<string, unknown> | null;
  try {
    const parsed = await readJsonBodyWithLimit(response, 8 * 1024, 'Cloudflare runtime credential');
    body = isCredentialResponseBody(parsed) ? parsed : null;
  } catch {
    body = null;
  }
  if (
    !response.ok ||
    !body ||
    typeof body.accessToken !== 'string' ||
    body.accessToken.length < 1 ||
    body.accessToken.length > 4_096
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  return body.accessToken;
}

export async function createUserAccountApi(
  env: {
    GHOSTBUILD_CONTROL_PLANE_ENDPOINT?: string;
    CONTROL_PLANE_SECRET?: string;
    GHOSTBUILD_USER_ID?: string;
    GHOSTBUILD_CONNECTION_ID?: string;
    GHOSTBUILD_CONNECTION_GENERATION?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
  },
  request: typeof fetch,
): Promise<UserCloudflareAccountApi> {
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const accessToken = await resolveFreshCloudflareAccessToken(env, request);
  return new UserCloudflareAccountApi(env.CLOUDFLARE_ACCOUNT_ID, accessToken, request, undefined, () =>
    resolveFreshCloudflareAccessToken(env, request, true),
  );
}

function isCredentialResponseBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsNoStore(value: string): boolean {
  return value
    .toLowerCase()
    .split(',')
    .some((directive) => directive.trim() === 'no-store');
}

function requireExecutionIdentityForRecovery(deployment: Deployment, args: UserOwnedDeploymentArgs): void {
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    deployment.executionGeneration !== args.executionGeneration ||
    (deployment.status !== 'provisioning' && deployment.status !== 'deploying') ||
    !isCurrentDeploymentPlan(deployment.plan)
  ) {
    throw new Error('Deployment no longer matches the interrupted user-owned execution.');
  }
}

function requireExecutionIdentity(deployment: Deployment, args: UserOwnedDeploymentArgs): void {
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    deployment.executionGeneration !== args.executionGeneration ||
    deployment.status !== 'approved' ||
    !isCurrentDeploymentPlan(deployment.plan)
  ) {
    throw new Error('Deployment no longer matches the approved user-owned execution.');
  }
}

function requirePreviewExecutionIdentity(
  deployment: Deployment,
  args: UserOwnedDeploymentArgs,
  connectionGeneration: number,
): void {
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    deployment.connectionGeneration !== connectionGeneration ||
    deployment.executionGeneration !== args.executionGeneration ||
    deployment.status === 'provisioning' ||
    deployment.status === 'deploying' ||
    !isCurrentDeploymentPlan(deployment.plan)
  ) {
    throw new Error('Preview no longer matches the approved user-owned execution.');
  }
}

function requireUserOwnedRuntimeContext(args: UserOwnedDeploymentArgs): UserOwnedRuntimeContext {
  const runtimeEnv = args.env;
  const connectionGeneration = Number(runtimeEnv.GHOSTBUILD_CONNECTION_GENERATION);
  if (
    runtimeEnv.GHOSTBUILD_USER_RUNTIME !== '1' ||
    runtimeEnv.GHOSTBUILD_USER_ID !== args.userId ||
    runtimeEnv.GHOSTBUILD_CONNECTION_ID !== args.connectionId ||
    !Number.isSafeInteger(connectionGeneration) ||
    connectionGeneration < 1 ||
    !runtimeEnv.CLOUDFLARE_ACCOUNT_ID ||
    runtimeEnv.GHOSTBUILD_CONTROL_PLANE_ENDPOINT !== GHOSTBUILD_CONTROL_PLANE_ENDPOINT ||
    !runtimeEnv.CONTROL_PLANE_SECRET ||
    !runtimeEnv.PROJECT_WORKSPACE
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  return {
    runtimeEnv,
    connectionGeneration,
    request: args.request ?? fetch,
    accountId: runtimeEnv.CLOUDFLARE_ACCOUNT_ID,
  };
}

function parseWorkspaceReference(value: string | null) {
  const match = /^workspace-runtime:([^:]+):(\d+):([a-f0-9]{64})$/.exec(value ?? '');
  if (!match) {
    throw new Error('The approved user-owned workspace reference is invalid.');
  }
  return { projectId: decodeURIComponent(match[1]!), workspaceRevision: Number(match[2]), revision: match[3]! };
}

function requireApprovedWorkspaceReference(deployment: Deployment, publication: 'deployment' | 'preview') {
  const reference = parseWorkspaceReference(deployment.workspaceReference);
  if (reference.revision !== deployment.plan.sourceSha256) {
    throw new Error(`The approved ${publication} revision no longer matches its workspace reference.`);
  }
  return reference;
}

function requireResourceName(deployment: Deployment, type: 'worker', logicalName: string): string {
  const name = deploymentPlanResourceName(deployment.plan, type, logicalName);
  if (!name) {
    throw new Error(`Approved deployment plan has an invalid ${type} resource.`);
  }
  return name;
}

function recordResource(
  db: D1Database,
  deploymentId: string,
  resourceType: 'worker' | 'worker_version' | 'd1' | 'r2' | 'kv',
  logicalName: string,
  providerResourceId: string,
) {
  return recordDeploymentResource({ db, deploymentId, resourceType, logicalName, providerResourceId });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'User-owned deployment failed.').slice(-4_000);
}
