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
import { parseWorkspaceReference, type WorkspaceReference } from './workspace-reference';
import { validatePreparedDeploymentArtifact, type PreparedDeploymentArtifact } from './deployment-artifact';
import type { DeploymentProjectProfile } from './deployment-project-profile';
import { D1MigrationChangedError, UserCloudflareAccountApi, type ManagedWorkerVersionArgs } from './user-account-api';
import {
  resolveUserWorkspaceCloudflareAccessToken,
  runtimeCredentialBrokerConfigured,
} from './user-workspace-cloudflare-credential';
import {
  runtimeConnectionIdentity,
  type RuntimeConnectionEnv,
  type RuntimeConnectionIdentity,
} from './cloudflare-api-runtime-identity';

type UserOwnedDeploymentArgs = {
  env: Env;
  deploymentId: string;
  userId: string;
  connectionId: string;
  executionGeneration: number;
  /**
   * Stops the publication at its next step while stopping is still clean: before migrations run and
   * the version is uploaded. Past that point it finishes, since stopping would leave production half
   * changed. A stop rejects with the signal's reason, and only a stop does: a failure past that point
   * rejects with its own error, aborted signal or not.
   */
  abortSignal?: AbortSignal;
};

type ProjectWorkspaceStub = ReturnType<Env['PROJECT_WORKSPACE']['get']>;
/** The Durable Object class the Agent capability exports, and the only one a CloudChef app has. */
const APP_AGENT_CLASS_NAME = 'AppAgent';
/** How much of an applied migration's SQL a refusal quotes; the failure it records keeps its last 4,000 characters. */
const MIGRATION_SQL_QUOTE_LIMIT = 2_000;
/** How many times the success write is tried once production serves the version, which nothing may record as failed. */
const SUCCESS_WRITE_ATTEMPTS = 3;
const SUCCESS_WRITE_RETRY_DELAY_MS = 200;
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

/** One of the plan's provider resources: the binding it is recorded under, and the name the plan gives it. */
type PlannedResource<Binding extends string> = { binding: Binding; name: string } | null;

/** Which of the plan's provider resources this publication needs, before any of them exist. */
type PublicationResourcePlan = {
  d1: PlannedResource<PublicationBindings['app']>;
  agentD1: PlannedResource<PublicationBindings['agentSecurity']>;
  r2: PlannedResource<PublicationBindings['storage']>;
  kv: PlannedResource<PublicationBindings['cache']>;
};

type PublicationResources = {
  d1: { id: string; name: string } | null;
  agentD1: { id: string; name: string } | null;
  r2: { id: string; name: string } | null;
  kv: { id: string; name: string } | null;
};

export async function terminalizeInterruptedUserOwnedDeployment(args: UserOwnedDeploymentArgs): Promise<Deployment> {
  const deployment = await requireDeployment(args.env.DB, args.deploymentId);
  requireExecutionIdentity(deployment, args, 'recovery');
  const reference = requireWorkspaceReference(deployment);
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
    const { connectionGeneration } = requireUserOwnedRuntimeContext(args);
    let deployment = await requireDeployment(args.env.DB, args.deploymentId);
    requireExecutionIdentity(deployment, args, 'deployment');
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
    const accountApi = await createUserAccountApi(args.env);
    const reference = requireApprovedWorkspaceReference(deployment, 'deployment');
    const workspace = args.env.PROJECT_WORKSPACE.get(args.env.PROJECT_WORKSPACE.idFromName(reference.projectId));
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
      executionGeneration: args.executionGeneration,
      deployment,
      reference,
      workerName,
      profile,
      resources,
    });

    await workspace.assertDeploymentSession({ sessionId: session.sessionId });
    // The last point at which stopping leaves production as it was.
    abortSignal?.throwIfAborted();
    await activity(args, 40, 'Applying database migrations');
    await applyProductionMigrations(accountApi, resources, artifact);
    providerChangesPossible = true;
    await activity(args, 50, 'Uploading assets and publishing Worker');
    const published = await accountApi.deployManagedWorker(
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
      accountApi.configureManagedWorkerSchedule(workerName, profile.bindings.appAgent),
    );
    await followUps.run('turning on its workers.dev address', () => accountApi.enableWorkerSubdomain(workerName));
    await followUps.run("recording the app's Worker", () =>
      recordResource(args.env.DB, deployment.id, 'worker', PRODUCTION_BINDINGS.worker, workerName),
    );
    const workersSubdomain = await followUps.run("reading the account's workers.dev subdomain", () =>
      accountApi.getWorkersSubdomain(),
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
  const { connectionGeneration } = requireUserOwnedRuntimeContext(args);
  const deployment = await requireDeployment(args.env.DB, args.deploymentId);
  requireExecutionIdentity(deployment, args, 'preview', connectionGeneration);
  const reference = requireApprovedWorkspaceReference(deployment, 'preview');
  const workspace = args.env.PROJECT_WORKSPACE.get(args.env.PROJECT_WORKSPACE.idFromName(reference.projectId));
  const workerName = requireResourceName(deployment, PREVIEW_BINDINGS.worker);
  const versionReceipt = await findDeploymentResource(
    args.env.DB,
    deployment.id,
    'worker_version',
    `preview:${args.previewId}`,
  );
  const accountApi = await createUserAccountApi(args.env);
  if (versionReceipt) {
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
    const resourcePlan = publicationResourcePlan(deployment.plan, PREVIEW_BINDINGS);
    const provisioned = await ensurePublicationResources({
      db: args.env.DB,
      deployment,
      accountApi,
      resourcePlan,
    });
    abortSignal?.throwIfAborted();
    await activity(args, 2, 'Cloudflare preview resources ready');

    const profile = deployment.plan.project;
    const artifact = await prepareValidatedArtifact({
      workspace,
      sessionId: session.sessionId,
      executionGeneration: args.executionGeneration,
      deployment,
      reference,
      workerName,
      profile,
      resources: provisioned,
    });
    await workspace.assertDeploymentSession({ sessionId: session.sessionId });
    abortSignal?.throwIfAborted();

    await activity(args, 3, 'Applying preview database migrations');
    // The artifact's bytes do not depend on which database it binds, so one started over binds as well.
    const resources = await applyPreviewMigrations({
      db: args.env.DB,
      deploymentId: deployment.id,
      accountApi,
      resources: provisioned,
      resourcePlan,
      artifact,
    });
    abortSignal?.throwIfAborted();
    await activity(args, 4, 'Uploading assets and publishing the preview Worker');
    if (!profile.bindings.appAgent && (await hasAppAgentObjects(accountApi, workerName))) {
      // Unlike production's, the preview's Agent data is only what previews wrote, and deleting the
      // Worker deletes its Durable Objects with it, so the preview Worker starts over without them.
      await accountApi.deleteManagedWorker(workerName);
    }
    const published = await accountApi.deployManagedWorker(
      managedWorkerVersionArgs({ workerName, profile, reference, artifact, resources }),
    );
    await accountApi.configureManagedWorkerSchedule(workerName, profile.bindings.appAgent);
    await accountApi.enableWorkerSubdomain(workerName);
    await recordResource(args.env.DB, deployment.id, 'worker', PREVIEW_BINDINGS.worker, workerName);
    await recordResource(
      args.env.DB,
      deployment.id,
      'worker_version',
      `preview:${args.previewId}`,
      published.workerVersionId,
    );
    const url = workersDevUrl(workerName, await accountApi.getWorkersSubdomain());
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
  const planned = <Binding extends string>(type: 'd1' | 'r2' | 'kv', binding: Binding): PlannedResource<Binding> => {
    const name = deploymentPlanResourceName(plan, type, binding);
    return name ? { binding, name } : null;
  };
  return {
    d1: planned('d1', bindings.app),
    agentD1: planned('d1', bindings.agentSecurity),
    r2: planned('r2', bindings.storage),
    kv: planned('kv', bindings.cache),
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
    resources.d1 = await accountApi.ensureD1Database(resourcePlan.d1.name);
    await recordResource(db, deployment.id, 'd1', resourcePlan.d1.binding, resources.d1.id);
  }
  if (resourcePlan.agentD1) {
    resources.agentD1 = await accountApi.ensureD1Database(resourcePlan.agentD1.name);
    await recordResource(db, deployment.id, 'd1', resourcePlan.agentD1.binding, resources.agentD1.id);
  }
  if (resourcePlan.r2) {
    resources.r2 = await accountApi.ensureR2Bucket(resourcePlan.r2.name);
    await recordResource(db, deployment.id, 'r2', resourcePlan.r2.binding, resources.r2.id);
  }
  if (resourcePlan.kv) {
    resources.kv = await accountApi.ensureKvNamespace(resourcePlan.kv.name);
    await recordResource(db, deployment.id, 'kv', resourcePlan.kv.binding, resources.kv.id);
  }
  return resources;
}

async function prepareValidatedArtifact(args: {
  workspace: ProjectWorkspaceStub;
  sessionId: string;
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
    d1:
      resources.d1 && resourcePlan.d1
        ? await apply(resources.d1, resourcePlan.d1.binding, artifact.migrations.DB)
        : null,
    agentD1:
      resources.agentD1 && resourcePlan.agentD1
        ? await apply(resources.agentD1, resourcePlan.agentD1.binding, artifact.migrations.AGENT_SECURITY_DB)
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

/**
 * The account API as this runtime's connection, with a token from the credential broker; a token that
 * expires during a long publication is refreshed when Cloudflare refuses it.
 */
export async function createUserAccountApi(
  env: RuntimeConnectionEnv & Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>,
): Promise<UserCloudflareAccountApi> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  const accessToken = await resolveUserWorkspaceCloudflareAccessToken(env, identity);
  return new UserCloudflareAccountApi(identity.accountId, accessToken, () =>
    resolveUserWorkspaceCloudflareAccessToken(env, identity, { forceRefresh: true }),
  );
}

/**
 * The statuses a record may be in for each execution of it, and what a record that no longer matches
 * is refused as: recovery settles an interrupted one, a deployment claims an approved one, and a
 * preview publishes any that is not running.
 */
const EXECUTIONS = {
  recovery: {
    statuses: ['provisioning', 'deploying'],
    refusal: 'Deployment no longer matches the interrupted user-owned execution.',
  },
  deployment: { statuses: ['approved'], refusal: 'Deployment no longer matches the approved user-owned execution.' },
  preview: {
    statuses: ['approved', 'succeeded', 'failed'],
    refusal: 'Preview no longer matches the approved user-owned execution.',
  },
} as const satisfies Record<string, { statuses: readonly DeploymentStatus[]; refusal: string }>;

/** The record is this execution's, in a status it runs from, with a plan this release makes. */
function requireExecutionIdentity(
  deployment: Deployment,
  args: UserOwnedDeploymentArgs,
  execution: keyof typeof EXECUTIONS,
  /** The connection generation the record must be planned under, when the execution checks it itself. */
  connectionGeneration?: number,
): void {
  const { statuses, refusal }: { statuses: readonly DeploymentStatus[]; refusal: string } = EXECUTIONS[execution];
  if (
    deployment.userId !== args.userId ||
    deployment.connectionId !== args.connectionId ||
    (connectionGeneration !== undefined && deployment.connectionGeneration !== connectionGeneration) ||
    deployment.executionGeneration !== args.executionGeneration ||
    !statuses.includes(deployment.status) ||
    !isCurrentDeploymentPlan(deployment.plan)
  ) {
    throw new Error(refusal);
  }
}

/** This runtime's connection, when it is the execution's and the runtime can publish with it. */
function requireUserOwnedRuntimeContext(args: UserOwnedDeploymentArgs): RuntimeConnectionIdentity {
  const identity = runtimeConnectionIdentity(args.env);
  if (
    !identity ||
    identity.userId !== args.userId ||
    identity.connectionId !== args.connectionId ||
    !runtimeCredentialBrokerConfigured(args.env) ||
    !args.env.PROJECT_WORKSPACE
  ) {
    throw new Error('Cloudflare connection is unavailable.');
  }
  return identity;
}

function requireWorkspaceReference(deployment: Deployment): WorkspaceReference {
  const reference = parseWorkspaceReference(deployment.workspaceReference);
  if (!reference) {
    throw new Error('The approved user-owned workspace reference is invalid.');
  }
  return reference;
}

function requireApprovedWorkspaceReference(deployment: Deployment, publication: 'deployment' | 'preview') {
  const reference = requireWorkspaceReference(deployment);
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
