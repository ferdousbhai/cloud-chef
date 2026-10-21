import {
  createOrReplayDeploymentPlanForUser,
  deployForUser,
  previewForUser,
  terminalizeInterruptedDeploymentForUser,
} from '~/server-handlers/deployments';
import type { DeploymentStatus } from '~/lib/.server/cloudflare/deployment-repository';
import type {
  BuilderWorkspaceApi,
  BuilderWorkspaceCheckpoint,
  WorkspaceValidationStageReporter,
} from './builder-workspace-api';

type BuilderDeploymentContext = {
  env: Env;
  userId: string;
  chatInitialId: string;
};

type BuilderDeploymentWorkspace = Pick<
  BuilderWorkspaceApi,
  'projectId' | 'checkpoint' | 'hasSuccessfulValidation' | 'prepareDeployment'
>;

type BuilderBuildWorkspace = Pick<BuilderWorkspaceApi, 'checkpoint' | 'hasSuccessfulValidation' | 'validate'>;

/**
 * How many times one revision may be planned. A plan goes stale only when the project's resources or
 * the Cloudflare connection change under it, which the revision's next plan settles.
 */
const MAX_PUBLICATION_PLANS = 8;

export type BuilderDeploymentState = {
  status: 'ready' | 'deploying' | 'succeeded' | 'failed';
  workspaceRevision?: number;
  revision?: string;
  id?: string;
  productionUrl?: string | null;
  error?: string | null;
};

async function validatedDeploymentCheckpoint(
  workspace: Pick<BuilderWorkspaceApi, 'checkpoint' | 'hasSuccessfulValidation'>,
): Promise<BuilderWorkspaceCheckpoint | null> {
  const snapshot = await workspace.checkpoint();
  return (await workspace.hasSuccessfulValidation(snapshot.revision)) ? snapshot : null;
}

/**
 * Build the exact checkpoint a preview or deployment was asked for, unless a validation of that
 * revision already produced its deployable artifact. The full validation is the build: it leaves the
 * artifact that preview and production publish. Nothing is published from a different revision.
 */
export async function buildCheckpointForBuilder(args: {
  workspace: BuilderBuildWorkspace;
  requestedSnapshot: BuilderWorkspaceCheckpoint;
  publication: 'preview' | 'deployment';
  toolCallId: string;
  abortSignal?: AbortSignal;
  onStage?: WorkspaceValidationStageReporter;
}): Promise<BuilderWorkspaceCheckpoint> {
  args.abortSignal?.throwIfAborted();
  const current = await args.workspace.checkpoint();
  if (!sameCheckpoint(current, args.requestedSnapshot)) {
    throw new Error(
      `The project changed after the ${args.publication} was requested. Build the current revision instead.`,
    );
  }

  if (!(await args.workspace.hasSuccessfulValidation(current.revision))) {
    const validationRequest: Parameters<BuilderWorkspaceApi['validate']>[0] = {
      toolCallId: args.toolCallId,
      input: { source: args.publication },
    };
    if (args.onStage) {
      validationRequest.onStage = args.onStage;
    }
    if (args.abortSignal) {
      validationRequest.abortSignal = args.abortSignal;
    }
    const validation = await args.workspace.validate(validationRequest);
    if (!validation.ok) {
      throw new Error(`The build failed: ${validation.summary}`);
    }
  }

  args.abortSignal?.throwIfAborted();
  const built = await validatedDeploymentCheckpoint(args.workspace);
  if (!built || !sameCheckpoint(built, args.requestedSnapshot)) {
    throw new Error(
      `The project changed while the ${args.publication} was being built. Build the current revision instead.`,
    );
  }
  return built;
}

export async function terminalizeInterruptedDeploymentForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: Pick<BuilderWorkspaceApi, 'projectId'>;
  toolCallId: string;
  validatedRevision: string;
}): Promise<BuilderDeploymentState> {
  const identity = [args.workspace.projectId, args.toolCallId, args.validatedRevision] as const;
  const terminalize = async (deploymentId: string) =>
    terminalizeInterruptedDeploymentForUser({ env: args.context.env, userId: args.context.userId, deploymentId });
  // Each plan of the revision is terminalized, since any one of them left active would hold the
  // project's deployments forever; the latest is the one that ran. A deployment the runtime was
  // upgraded under keeps its earlier identity.
  let deployment: Awaited<ReturnType<typeof terminalize>> = null;
  for (let generation = 0; generation < MAX_PUBLICATION_PLANS; generation += 1) {
    const planned = await terminalize(await publicationDeploymentId(...identity, generation));
    if (!planned) {
      break;
    }
    deployment = planned;
  }
  deployment ??= await terminalize(await previousPublicationDeploymentId(...identity));
  return deployment
    ? {
        id: deployment.id,
        status: builderDeploymentStatus(deployment.status),
        productionUrl: deployment.productionUrl,
        error: deployment.error?.message ?? null,
      }
    : {
        status: 'failed',
        error: 'Deployment was interrupted before execution started.',
      };
}

/**
 * Only a deployment that was claimed is still running. One a preview planned and nothing claimed
 * (`approved`) is ready to run, so whoever asked runs it rather than waiting for it to settle.
 */
function builderDeploymentStatus(status: DeploymentStatus): BuilderDeploymentState['status'] {
  if (status === 'approved') {
    return 'ready';
  }
  return status === 'provisioning' ? 'deploying' : status;
}

/** Deploy the exact durably validated revision as one idempotent server operation. */
export async function deployValidatedRevisionForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  validatedRevision: string;
  /** Called once the plan exists, so the caller can follow the stages it is about to record. */
  onPlanned?: (deploymentId: string) => void;
  /** Honored until the deployment starts changing production; see `executeUserOwnedDeployment`. */
  abortSignal?: AbortSignal;
}): Promise<BuilderDeploymentState> {
  args.abortSignal?.throwIfAborted();
  const deploymentId = await planValidatedRevision({ ...args, publication: 'Deployment' });
  args.onPlanned?.(deploymentId);
  const deployment = await deployForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
    abortSignal: args.abortSignal,
  });
  return {
    id: deployment.id,
    status: deployment.status === 'succeeded' ? 'succeeded' : 'deploying',
    productionUrl: deployment.productionUrl,
    error: deployment.error?.message ?? null,
  };
}

/**
 * Preview the same validated revision under the same deployment plan. Passing the deployment's own
 * tool-call identity is what publishes the preview to the preview resources that exact deployment's
 * plan names, the project's, rather than as a second publication with a plan of its own.
 */
export async function previewValidatedRevisionForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  previewId: string;
  validatedRevision: string;
  /** Called once the plan exists, so the caller can follow the stages it is about to record. */
  onPlanned?: (deploymentId: string) => void;
  abortSignal?: AbortSignal;
}) {
  args.abortSignal?.throwIfAborted();
  const deploymentId = await planValidatedRevision({ ...args, publication: 'Preview' });
  args.onPlanned?.(deploymentId);
  return previewForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
    previewId: args.previewId,
    abortSignal: args.abortSignal,
  });
}

/** Create or replay the one deployment plan for this exact revision and return its identity. */
async function planValidatedRevision(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  validatedRevision: string;
  publication: 'Deployment' | 'Preview';
}): Promise<string> {
  const snapshot = await args.workspace.checkpoint();
  if (snapshot.revision !== args.validatedRevision) {
    throw new Error('The project changed after it was built. Build the current revision instead.');
  }
  if (!(await args.workspace.hasSuccessfulValidation(snapshot.revision))) {
    throw new Error(`${args.publication} has no build of this exact revision.`);
  }
  const source = await args.workspace.prepareDeployment(snapshot.revision);
  // A plan stored under one id that the revision would no longer get is never replayed: the revision is
  // planned again under the next.
  for (let generation = 0; generation < MAX_PUBLICATION_PLANS; generation += 1) {
    const deploymentId = await publicationDeploymentId(
      args.workspace.projectId,
      args.toolCallId,
      snapshot.revision,
      generation,
    );
    const planned = await createOrReplayDeploymentPlanForUser({
      env: args.context.env,
      userId: args.context.userId,
      chatId: args.context.chatInitialId,
      deploymentId,
      projectId: args.workspace.projectId,
      revision: source.revision,
      workspaceRevision: source.workspaceRevision,
      project: source.project,
    });
    if (planned) {
      return deploymentId;
    }
  }
  throw new Error(
    `${args.publication} of this revision was planned too many times. Change the project and publish again.`,
  );
}

/**
 * The deployment record of one revision's publication: its identity and idempotency key, never the
 * name of anything in the account, since every revision deploys onto the project's resources. It is
 * derived apart from the identity a publication had when each deployment named its own resources, so
 * a plan made then is never replayed for a revision published now. Each later generation is the same
 * revision planned again, once the plan of the one before went stale.
 */
function publicationDeploymentId(
  projectId: string,
  toolCallId: string,
  revision: string,
  generation: number,
): Promise<string> {
  const publication = `project-resources:${projectId}:${toolCallId}:${revision}`;
  return deterministicDeploymentId(generation === 0 ? publication : `${publication}:${generation}`);
}

/** The identity the same publication had before, still the one an interrupted record of it has. */
function previousPublicationDeploymentId(projectId: string, toolCallId: string, revision: string): Promise<string> {
  return deterministicDeploymentId(`deployment:${projectId}:${toolCallId}:${revision}`);
}

function sameCheckpoint(left: BuilderWorkspaceCheckpoint, right: BuilderWorkspaceCheckpoint): boolean {
  return left.workspaceRevision === right.workspaceRevision && left.revision === right.revision;
}

async function deterministicDeploymentId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`deployment:${value}`)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
