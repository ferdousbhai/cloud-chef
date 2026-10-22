import { z } from 'zod';
import { deploymentPlanResourceName, isCurrentDeploymentPlan } from './deployment-plan';
import {
  claimApprovedDeployment,
  DeploymentConcurrencyLimitError,
  DeploymentStateConflictError,
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
import { D1MigrationChangedError, UserCloudflareAccountApi, type ManagedWorkerVersionArgs } from './user-account-api';
import { CLOUDCHEF_CONTROL_PLANE_ENDPOINT } from './user-workspace-runtime-policy';
import { runtimeRequestHeaders } from './user-workspace-cloudflare-credential';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';

type UserOwnedDeploymentArgs = {
  env: Env;
  deploymentId: string;
  userId: string;
  connectionId: string;
  executionGeneration: number;
  request?: typeof fetch;
  /**
   * Stops the publication at its next step while stopping is still clean: before migrations run and
   * the version is uploaded. Past that point it finishes, since stopping would leave production half
   * changed. A stop rejects with the signal's reason, and only a stop does: a failure past that point
   * rejects with its own error, aborted signal or not.
   */
  abortSignal?: AbortSignal;
};

type UserOwnedRuntimeContext = {
  runtimeEnv: Env;
  connectionGeneration: number;
  request: typeof fetch;
};

type ProjectWorkspaceStub = ReturnType<Env['PROJECT_WORKSPACE']['get']>;
/** The Durable Object class the Agent capability exports, and the only one a CloudChef app has. */
const APP_AGENT_CLASS_NAME = 'AppAgent';
/** How much of an applied migration's SQL a refusal quotes; the failure it records keeps its last 4,000 characters. */
const MIGRATION_SQL_QUOTE_LIMIT = 2_000;
/** How many times the success write is tried once production serves the version, which nothing may record as failed. */
const SUCCESS_WRITE_ATTEMPTS = 3;
const SUCCESS_WRITE_RETRY_DELAY_MS = 200;
type WorkspaceReference = ReturnType<typeof parseWorkspaceReference>;
type PublicationSession = { sessionId: string; finish(status: 'completed' | 'failed'): Promise<void> };

/**
 * Deployment publishes to the project's Worker with its production databases, bucket and namespace;
 * preview publishes to the project's preview Worker with resources of its own, so a preview never
 * reads or writes production's data. Everything between — resource provisioning, artifact
 * preparation, migrations, upload and promotion — is the same path.
 */
const PRODUCTION_BINDINGS = {
  worker: 'app',
  app: 'DB',
  agentSecurity: 'AGENT_SECURITY_DB',
  storage: 'APP_STORAGE',
  cache: 'APP_CACHE',
} as const;
const PREVIEW_BINDINGS = {
  worker: 'app_preview',
  app: 'DB_PREVIEW',
  agentSecurity: 'AGENT_SECURITY_DB_PREVIEW',
  storage: 'APP_STORAGE_PREVIEW',
  cache: 'APP_CACHE_PREVIEW',
} as const;
type PublicationBindings = typeof PRODUCTION_BINDINGS | typeof PREVIEW_BINDINGS;

/** Which of the plan's provider resources this publication needs, before any of them exist. */
type PublicationResourcePlan = {
  d1: PublicationBindings['app'] | null;
  agentD1: PublicationBindings['agentSecurity'] | null;
  r2: PublicationBindings['storage'] | null;
  kv: PublicationBindings['cache'] | null;
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
  const promoted = await findDeploymentResource(
    args.env.DB,
    deployment.id,
    'worker_version',
    productionVersionReceipt(args.executionGeneration),
  );
  if (promoted) {
    // Production serves the version this execution promoted before it could record that: it succeeded.
    await transitionDeployment({
      db: args.env.DB,
      deploymentId: deployment.id,
      executionGeneration: args.executionGeneration,
      expectedStatus: deployment.status,
      nextStatus: 'succeeded',
      errorCode: 'deployment_follow_up_failed',
      errorMessage:
        'Production serves the new revision, but its deployment was interrupted before it was recorded. The next deployment repeats the steps after it.',
    });
    return requireDeployment(args.env.DB, deployment.id);
  }
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
  let promoted = false;
  let session: PublicationSession | null = null;
  const abortSignal = args.abortSignal;
  try {
    abortSignal?.throwIfAborted();
    const { runtimeEnv, connectionGeneration, request } = requireUserOwnedRuntimeContext(args);
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
    await requireAgentCapabilityKept(
      accountApi,
      requireResourceName(deployment, PRODUCTION_BINDINGS.worker),
      deployment,
    );
    abortSignal?.throwIfAborted();
    session = await beginPublicationSession(workspace, operationId, reference);
    abortSignal?.throwIfAborted();

    const resourcePlan = publicationResourcePlan(deployment.plan, PRODUCTION_BINDINGS);
    // Provisioning can create account resources before it fails, so a plan that names any of them
    // makes provider cleanup possible from here on.
    providerChangesPossible = Boolean(resourcePlan.d1 || resourcePlan.agentD1 || resourcePlan.r2 || resourcePlan.kv);
    const resources = await ensurePublicationResources({ db: args.env.DB, deployment, accountApi, resourcePlan });
    abortSignal?.throwIfAborted();
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
    const workerName = requireResourceName(deployment, PRODUCTION_BINDINGS.worker);
    const profile = deployment.plan.project;
    const artifact = await prepareValidatedArtifact({
      workspace,
      sessionId: session.sessionId,
      operationId,
      executionGeneration: args.executionGeneration,
      deployment,
      reference,
      workerName,
      profile,
      resources,
    });

    // The build may take several minutes. Resolve again at the authenticated
    // boundary; the credential vault refreshes expiring tokens and the API
    // client retries once if Cloudflare reports that the token expired.
    const publishApi = await createUserAccountApi(runtimeEnv, request);
    await workspace.assertDeploymentSession({ sessionId: session.sessionId });
    // The last point at which stopping leaves production as it was.
    abortSignal?.throwIfAborted();
    await activity(args, 40, 'Applying database migrations');
    await applyProductionMigrations(publishApi, resources, artifact);
    providerChangesPossible = true;
    await activity(args, 50, 'Uploading assets and publishing Worker');
    const published = await publishApi.deployManagedWorker(
      managedWorkerVersionArgs({ workerName, profile, reference, artifact, resources }),
    );
    // Production serves the new revision from here on, so the deployment succeeded whatever follows:
    // a step after it that fails is reported with the success, and the next deployment repeats it.
    // Nothing records it as failed from here, and recovery reads this receipt as its success.
    promoted = true;
    const recordPromotion = () =>
      recordResource(
        args.env.DB,
        deployment.id,
        'worker_version',
        productionVersionReceipt(args.executionGeneration),
        published.workerVersionId,
      );
    await recordPromotion()
      .catch(recordPromotion)
      .catch(() => console.error('Unable to record the promoted production version'));
    const followUps = new PublicationFollowUps();
    await followUps.run('recording the route step', () => activity(args, 60, 'Configuring public Cloudflare route'));
    await followUps.run("setting the Worker's schedule", () =>
      publishApi.configureManagedWorkerSchedule(workerName, profile.bindings.appAgent),
    );
    await followUps.run('turning on its workers.dev address', () => publishApi.enableWorkerSubdomain(workerName));
    await followUps.run("recording the app's Worker", () =>
      recordResource(args.env.DB, deployment.id, 'worker', PRODUCTION_BINDINGS.worker, workerName),
    );
    const workersSubdomain = await followUps.run("reading the account's workers.dev subdomain", () =>
      publishApi.getWorkersSubdomain(),
    );
    const productionUrl = workersSubdomain === null ? null : workersDevUrl(workerName, workersSubdomain);
    const warning = followUps.warning();
    await recordSucceeded(args, deployment.id, {
      productionUrl,
      errorCode: warning ? 'deployment_follow_up_failed' : null,
      errorMessage: warning,
    });
    phase = 'succeeded';
    // Production is promoted and recorded: what follows is bookkeeping, and its failure must not
    // report a live deployment as failed.
    await activity(args, 80, 'Deployment complete').catch(() =>
      console.error('Unable to record the completed deployment activity'),
    );
    await session
      .finish('completed')
      .catch(() => console.error('Unable to finalize the completed ProjectWorkspace deployment session'));
    return await requireDeployment(args.env.DB, deployment.id).catch(() => ({
      ...deployment,
      status: 'succeeded' as const,
      productionUrl,
      errorCode: warning ? 'deployment_follow_up_failed' : null,
      errorMessage: warning,
    }));
  } catch (error) {
    if (
      phase === 'approved' &&
      error instanceof DeploymentStateConflictError &&
      (error.status === 'provisioning' || error.status === 'deploying')
    ) {
      // Another execution claimed it first and is running it: it is in progress, not failed, and the
      // caller follows that one.
      const running = await requireDeployment(args.env.DB, args.deploymentId).catch(() => null);
      if (running && running.status !== 'approved' && running.status !== 'failed') {
        return running;
      }
    }
    if (promoted && phase !== 'succeeded') {
      // Production serves the version, but its success could not be recorded: the record stays
      // deploying, never failed, and the retry this asks for recovers it as succeeded.
      console.error('Unable to record the promoted user-owned deployment');
      throw new Error(
        `Production serves the new revision, but recording its deployment failed (${safeError(error).slice(0, 300)}). Deployment was interrupted. Retry to record it.`,
      );
    }
    if (phase === 'approved' && error instanceof DeploymentConcurrencyLimitError) {
      // Refused before it started: record it as failed, so it reads as what it is and retries
      // through the same path as any other failed deployment.
      await transitionDeployment({
        db: args.env.DB,
        deploymentId: args.deploymentId,
        executionGeneration: args.executionGeneration,
        expectedStatus: 'approved',
        nextStatus: 'failed',
        errorCode: 'deployment_concurrency_limited',
        errorMessage: safeError(error),
      }).catch(() => console.error('Unable to persist the refused user-owned deployment'));
    } else if (phase !== 'approved' && phase !== 'succeeded') {
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

/**
 * Publish one validated artifact as the active version of the project's preview Worker, with the
 * preview's own databases, bucket and namespace, and return its workers.dev address.
 */
export async function executeUserOwnedPreview(
  args: UserOwnedDeploymentArgs & { previewId: string },
): Promise<UserOwnedPreviewResult> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(args.previewId)) {
    throw new Error('Preview identity is invalid.');
  }
  const abortSignal = args.abortSignal;
  abortSignal?.throwIfAborted();
  const { runtimeEnv, connectionGeneration, request } = requireUserOwnedRuntimeContext(args);
  const deployment = await requireDeployment(args.env.DB, args.deploymentId);
  requirePreviewExecutionIdentity(deployment, args, connectionGeneration);
  const reference = requireApprovedWorkspaceReference(deployment, 'preview');
  const workspace = runtimeEnv.PROJECT_WORKSPACE.get(runtimeEnv.PROJECT_WORKSPACE.idFromName(reference.projectId));
  const workerName = requireResourceName(deployment, PREVIEW_BINDINGS.worker);
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
      url: workersDevUrl(workerName, await accountApi.getWorkersSubdomain()),
      workspaceRevision: reference.workspaceRevision,
      snapshotRevision: reference.revision,
      readyAt: new Date(versionReceipt.createdAt).toISOString(),
    };
  }
  const operationId = `preview:${deployment.id}:${args.executionGeneration}:${args.previewId}`;
  abortSignal?.throwIfAborted();
  const session = await beginPublicationSession(workspace, operationId, reference);
  try {
    // A preview reaches nothing production serves, so it stops at any step; each check releases the
    // workspace sooner.
    abortSignal?.throwIfAborted();
    await activity(args, 1, 'Preparing Cloudflare preview resources');
    const provisionApi = await createUserAccountApi(runtimeEnv, request);
    const resourcePlan = publicationResourcePlan(deployment.plan, PREVIEW_BINDINGS);
    const provisioned = await ensurePublicationResources({
      db: args.env.DB,
      deployment,
      accountApi: provisionApi,
      resourcePlan,
    });
    abortSignal?.throwIfAborted();
    await activity(args, 2, 'Cloudflare preview resources ready');

    const profile = deployment.plan.project;
    const artifact = await prepareValidatedArtifact({
      workspace,
      sessionId: session.sessionId,
      operationId,
      executionGeneration: args.executionGeneration,
      deployment,
      reference,
      workerName,
      profile,
      resources: provisioned,
    });
    await workspace.assertDeploymentSession({ sessionId: session.sessionId });
    abortSignal?.throwIfAborted();

    const publishApi = await createUserAccountApi(runtimeEnv, request);
    await activity(args, 3, 'Applying preview database migrations');
    // The artifact's bytes do not depend on which database it binds, so one started over binds as well.
    const resources = await applyPreviewMigrations({
      db: args.env.DB,
      deploymentId: deployment.id,
      accountApi: publishApi,
      resources: provisioned,
      resourcePlan,
      artifact,
    });
    abortSignal?.throwIfAborted();
    await activity(args, 4, 'Uploading assets and publishing the preview Worker');
    if (!profile.bindings.appAgent && (await hasAppAgentObjects(publishApi, workerName))) {
      // Unlike production's, the preview's Agent data is only what previews wrote, and deleting the
      // Worker deletes its Durable Objects with it, so the preview Worker starts over without them.
      await publishApi.deleteManagedWorker(workerName);
    }
    const published = await publishApi.deployManagedWorker(
      managedWorkerVersionArgs({ workerName, profile, reference, artifact, resources }),
    );
    await publishApi.configureManagedWorkerSchedule(workerName, profile.bindings.appAgent);
    await publishApi.enableWorkerSubdomain(workerName);
    await recordResource(args.env.DB, deployment.id, 'worker', PREVIEW_BINDINGS.worker, workerName);
    await recordResource(
      args.env.DB,
      deployment.id,
      'worker_version',
      `preview:${args.previewId}`,
      published.workerVersionId,
    );
    const url = workersDevUrl(workerName, await publishApi.getWorkersSubdomain());
    const checkpoint = await workspace.assertDeploymentSession({ sessionId: session.sessionId });
    const readyAt = new Date().toISOString();
    await activity(args, 5, 'Workers preview ready');
    await session.finish('completed');
    return {
      id: published.workerVersionId,
      url,
      workspaceRevision: checkpoint.workspaceRevision,
      snapshotRevision: checkpoint.revision,
      readyAt,
    };
  } finally {
    await session.finish('failed').catch(() => console.error('Unable to finalize ProjectWorkspace preview session'));
  }
}

/** Which receipt says an execution promoted production's version, read by recovery as its success. */
function productionVersionReceipt(executionGeneration: number): string {
  return `production:${executionGeneration}`;
}

/**
 * Record a promoted deployment as succeeded, trying again while D1 fails, under one timestamp so an attempt
 * that landed without its acknowledgement is known by the next. Another write that settled it as succeeded
 * (recovery, say) is the same answer; one that settled it otherwise stands.
 */
async function recordSucceeded(
  args: UserOwnedDeploymentArgs,
  deploymentId: string,
  outcome: { productionUrl: string | null; errorCode: string | null; errorMessage: string | null },
): Promise<void> {
  const now = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await transitionDeployment({
        db: args.env.DB,
        deploymentId,
        executionGeneration: args.executionGeneration,
        expectedStatus: 'deploying',
        nextStatus: 'succeeded',
        ...outcome,
        now,
      });
      return;
    } catch (error) {
      if (error instanceof DeploymentStateConflictError) {
        if (error.status === 'succeeded') {
          return;
        }
        throw error;
      }
      if (attempt >= SUCCESS_WRITE_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, SUCCESS_WRITE_RETRY_DELAY_MS * attempt));
    }
  }
}

/**
 * The steps after a deployment promoted its version: each is idempotent, so a failed one is tried once
 * more, and one that fails again is kept for the warning the succeeded deployment carries.
 */
class PublicationFollowUps {
  readonly #failures: string[] = [];

  async run<T>(step: string, operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch {
      try {
        return await operation();
      } catch (error) {
        this.#failures.push(`${step} failed (${safeError(error).slice(0, 300)})`);
        return null;
      }
    }
  }

  warning(): string | null {
    return this.#failures.length === 0
      ? null
      : `Production serves the new revision, but ${this.#failures.join('; ')}. The next deployment repeats these steps.`;
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

/**
 * Refuses, before anything changes, a deployment that would drop the Agent capability from a Worker
 * that has AppAgent Durable Objects. Cloudflare removes a Durable Object class only by deleting it,
 * every object and its data with it (a `deleted` export, or a `deleted_classes` migration), and
 * CloudChef never deletes an app's data to deploy it.
 */
async function requireAgentCapabilityKept(
  accountApi: UserCloudflareAccountApi,
  workerName: string,
  deployment: Deployment,
): Promise<void> {
  if (!deployment.plan.project.bindings.appAgent && (await hasAppAgentObjects(accountApi, workerName))) {
    throw new Error(
      "The Agent capability can't be removed from this published app: its Worker holds the app's Agent data " +
        "(AppAgent Durable Objects), and Cloudflare removes them only by deleting that data, which CloudChef won't do. " +
        'Restore the Agent capability (pnpm run agent:enable) and publish again.',
    );
  }
}

function hasAppAgentObjects(accountApi: UserCloudflareAccountApi, workerName: string): Promise<boolean> {
  return accountApi
    .managedWorkerDurableObjectClasses(workerName)
    .then((classes) => classes.includes(APP_AGENT_CLASS_NAME));
}

function publicationResourcePlan(plan: Deployment['plan'], bindings: PublicationBindings): PublicationResourcePlan {
  return {
    d1: deploymentPlanResourceName(plan, 'd1', bindings.app) ? bindings.app : null,
    agentD1: deploymentPlanResourceName(plan, 'd1', bindings.agentSecurity) ? bindings.agentSecurity : null,
    r2: deploymentPlanResourceName(plan, 'r2', bindings.storage) ? bindings.storage : null,
    kv: deploymentPlanResourceName(plan, 'kv', bindings.cache) ? bindings.cache : null,
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
    resources.r2 = await accountApi.ensureR2ForPlan(deployment.plan, resourcePlan.r2);
    await recordResource(db, deployment.id, 'r2', resourcePlan.r2, resources.r2.id);
  }
  if (resourcePlan.kv) {
    resources.kv = await accountApi.ensureKvForPlan(deployment.plan, resourcePlan.kv);
    await recordResource(db, deployment.id, 'kv', resourcePlan.kv, resources.kv.id);
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
      workerName: args.workerName,
      projectType: profile.type,
      workersAi: profile.bindings.ai,
      appAgent: profile.bindings.appAgent,
      assets: profile.bindings.assets === true,
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

/**
 * Applies the migrations each production database has not applied yet. The databases outlive every
 * revision, so one that applied a migration never runs it again, and refuses it once its contents have
 * changed: production's data is never given up to apply one.
 */
async function applyProductionMigrations(
  accountApi: UserCloudflareAccountApi,
  resources: PublicationResources,
  artifact: PreparedDeploymentArtifact,
): Promise<void> {
  try {
    if (resources.d1) {
      await accountApi.applyD1Migrations(resources.d1.id, artifact.migrations.DB);
    }
    if (resources.agentD1) {
      await accountApi.applyD1Migrations(resources.agentD1.id, artifact.migrations.AGENT_SECURITY_DB);
    }
  } catch (error) {
    if (error instanceof D1MigrationChangedError) {
      throw new Error(migrationChangedMessage(error));
    }
    throw error;
  }
}

/**
 * Applies the migrations each preview database has not applied yet, and starts over one that refuses a
 * changed migration: a preview can apply a migration production never ran, and edited before it
 * deployed, every later preview would be refused with nothing to reset the database but this. Its data
 * is only what previews wrote. Returns the resources with each database started over in its place.
 */
async function applyPreviewMigrations(args: {
  db: D1Database;
  deploymentId: string;
  accountApi: UserCloudflareAccountApi;
  resources: PublicationResources;
  resourcePlan: PublicationResourcePlan;
  artifact: PreparedDeploymentArtifact;
}): Promise<PublicationResources> {
  const { resources, resourcePlan, artifact } = args;
  const apply = async (
    database: { id: string; name: string },
    logicalName: PublicationBindings['app'] | PublicationBindings['agentSecurity'],
    migrations: PreparedDeploymentArtifact['migrations']['DB'],
  ): Promise<{ id: string; name: string }> => {
    try {
      await args.accountApi.applyD1Migrations(database.id, migrations);
      return database;
    } catch (error) {
      if (!(error instanceof D1MigrationChangedError)) {
        throw error;
      }
    }
    await args.accountApi.deleteD1DatabaseById(database.id);
    const fresh = await args.accountApi.ensureD1Database(database.name);
    if (fresh.id === database.id) {
      throw new Error(
        `The preview database ${database.name} is still being replaced after a migration it applied changed. Publish the preview again.`,
      );
    }
    await recordResource(args.db, args.deploymentId, 'd1', logicalName, fresh.id);
    await args.accountApi.applyD1Migrations(fresh.id, migrations);
    return fresh;
  };
  return {
    ...resources,
    d1: resources.d1 && resourcePlan.d1 ? await apply(resources.d1, resourcePlan.d1, artifact.migrations.DB) : null,
    agentD1:
      resources.agentD1 && resourcePlan.agentD1
        ? await apply(resources.agentD1, resourcePlan.agentD1, artifact.migrations.AGENT_SECURITY_DB)
        : null,
  };
}

/**
 * The way out of a changed migration: put the change in a new one, and give the applied one back its
 * applied contents, quoted when the database recorded them. Deleting the file is the other way back,
 * fit only for one that holds nothing a new database needs, like the starter's placeholder.
 */
function migrationChangedMessage(error: D1MigrationChangedError): string {
  const name = error.migrationName;
  const applied =
    error.appliedSql === null
      ? ''
      : ` It was applied as:\n${error.appliedSql.slice(0, MIGRATION_SQL_QUOTE_LIMIT)}${
          error.appliedSql.length > MIGRATION_SQL_QUOTE_LIMIT ? '\n[truncated]' : ''
        }`;
  return (
    `The migration ${name} was already applied to the production database with different contents, and an applied migration never runs again. ` +
    `Put the change in a new migration numbered after the last one, and restore ${name} exactly as it was applied, ` +
    `or delete ${name} if it holds no schema a new database needs (as the starter's 0001_app_data.sql placeholder does).${applied}`
  );
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
    workerFirstAssets: profile.bindings.assets === true,
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

const tokenWithheldSchema = z.object({ code: z.literal('cloudflare_token_withheld'), error: z.string() });

export async function resolveFreshCloudflareAccessToken(
  env: {
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT?: string;
    CONTROL_PLANE_SECRET?: string;
    CLOUDCHEF_USER_ID?: string;
    CLOUDCHEF_CONNECTION_ID?: string;
    CLOUDCHEF_CONNECTION_GENERATION?: string;
  },
  request: typeof fetch = fetch,
  forceRefresh = false,
): Promise<string> {
  if (
    env.CLOUDCHEF_CONTROL_PLANE_ENDPOINT !== CLOUDCHEF_CONTROL_PLANE_ENDPOINT ||
    !env.CONTROL_PLANE_SECRET ||
    !env.CLOUDCHEF_USER_ID ||
    !env.CLOUDCHEF_CONNECTION_ID
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const connectionGeneration = Number(env.CLOUDCHEF_CONNECTION_GENERATION);
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const response = await request(`${CLOUDCHEF_CONTROL_PLANE_ENDPOINT}/api/cloudflare/runtime-credential`, {
    method: 'POST',
    // Who it is rides in headers, so the control plane checks the secret before reading the body.
    headers: runtimeRequestHeaders(
      { CLOUDCHEF_CONTROL_PLANE_ENDPOINT, CONTROL_PLANE_SECRET: env.CONTROL_PLANE_SECRET },
      { userId: env.CLOUDCHEF_USER_ID, connectionId: env.CLOUDCHEF_CONNECTION_ID, connectionGeneration },
    ),
    body: JSON.stringify({ forceRefresh }),
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
  // Said plainly: the member works on the organization's GitHub projects only, so drafts can't deploy.
  const withheld = tokenWithheldSchema.safeParse(body);
  if (response.status === 403 && withheld.success) {
    throw new Error(withheld.data.error);
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
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT?: string;
    CONTROL_PLANE_SECRET?: string;
    CLOUDCHEF_USER_ID?: string;
    CLOUDCHEF_CONNECTION_ID?: string;
    CLOUDCHEF_CONNECTION_GENERATION?: string;
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
  const connectionGeneration = Number(runtimeEnv.CLOUDCHEF_CONNECTION_GENERATION);
  if (
    runtimeEnv.CLOUDCHEF_USER_RUNTIME !== '1' ||
    runtimeEnv.CLOUDCHEF_USER_ID !== args.userId ||
    runtimeEnv.CLOUDCHEF_CONNECTION_ID !== args.connectionId ||
    !Number.isSafeInteger(connectionGeneration) ||
    connectionGeneration < 1 ||
    !runtimeEnv.CLOUDFLARE_ACCOUNT_ID ||
    runtimeEnv.CLOUDCHEF_CONTROL_PLANE_ENDPOINT !== CLOUDCHEF_CONTROL_PLANE_ENDPOINT ||
    !runtimeEnv.CONTROL_PLANE_SECRET ||
    !runtimeEnv.PROJECT_WORKSPACE
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  return {
    runtimeEnv,
    connectionGeneration,
    request: args.request ?? fetch,
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

function requireResourceName(deployment: Deployment, logicalName: PublicationBindings['worker']): string {
  const name = deploymentPlanResourceName(deployment.plan, 'worker', logicalName);
  if (!name) {
    throw new Error('Approved deployment plan has an invalid worker resource.');
  }
  return name;
}

function workersDevUrl(workerName: string, workersSubdomain: string): string {
  return `https://${workerName}.${workersSubdomain}.workers.dev`;
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
