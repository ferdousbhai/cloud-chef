import {
  createOrReplayDeploymentPlanForUser,
  deployForUser,
  previewForUser,
  terminalizeInterruptedDeploymentForUser,
} from '~/server-handlers/deployments';
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

type BuilderPreviewValidationWorkspace = Pick<
  BuilderWorkspaceApi,
  'checkpoint' | 'hasSuccessfulValidation' | 'validate'
>;

export type BuilderDeploymentState = {
  status: 'ready' | 'deploying' | 'succeeded' | 'failed';
  workspaceRevision?: number;
  revision?: string;
  id?: string;
  productionUrl?: string | null;
  error?: string | null;
};

export async function validatedDeploymentCheckpoint(
  workspace: Pick<BuilderWorkspaceApi, 'checkpoint' | 'hasSuccessfulValidation'>,
): Promise<BuilderWorkspaceCheckpoint | null> {
  const snapshot = await workspace.checkpoint();
  return (await workspace.hasSuccessfulValidation(snapshot.revision)) ? snapshot : null;
}

/** Validate the immutable checkpoint a manual preview request accepted before publishing it. */
export async function validatePreviewCheckpointForBuilder(args: {
  workspace: BuilderPreviewValidationWorkspace;
  requestedSnapshot: BuilderWorkspaceCheckpoint;
  toolCallId: string;
  abortSignal?: AbortSignal;
  onStage?: WorkspaceValidationStageReporter;
}): Promise<BuilderWorkspaceCheckpoint> {
  args.abortSignal?.throwIfAborted();
  const current = await args.workspace.checkpoint();
  if (!sameCheckpoint(current, args.requestedSnapshot)) {
    throw new Error('The project changed after the preview was requested. Build the current revision instead.');
  }

  if (!(await args.workspace.hasSuccessfulValidation(current.revision))) {
    const validationRequest: Parameters<BuilderWorkspaceApi['validate']>[0] = {
      toolCallId: args.toolCallId,
      input: { source: 'preview' },
    };
    if (args.onStage) {
      validationRequest.onStage = args.onStage;
    }
    if (args.abortSignal) {
      validationRequest.abortSignal = args.abortSignal;
    }
    const validation = await args.workspace.validate(validationRequest);
    if (!validation.ok) {
      throw new Error(`Preview validation failed: ${validation.summary}`);
    }
  }

  args.abortSignal?.throwIfAborted();
  const validated = await validatedDeploymentCheckpoint(args.workspace);
  if (!validated || !sameCheckpoint(validated, args.requestedSnapshot)) {
    throw new Error('The project changed while the preview was being validated. Build the current revision instead.');
  }
  return validated;
}

export async function terminalizeInterruptedDeploymentForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: Pick<BuilderWorkspaceApi, 'projectId'>;
  toolCallId: string;
  validatedRevision: string;
}): Promise<BuilderDeploymentState> {
  const deploymentId = await publicationDeploymentId(args.workspace.projectId, args.toolCallId, args.validatedRevision);
  const deployment = await terminalizeInterruptedDeploymentForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
  });
  return deployment
    ? {
        id: deployment.id,
        status:
          deployment.status === 'succeeded' ? 'succeeded' : deployment.status === 'failed' ? 'failed' : 'deploying',
        productionUrl: deployment.productionUrl,
        error: deployment.error?.message ?? null,
      }
    : {
        status: 'failed',
        error: 'Deployment was interrupted before execution started.',
      };
}

/** Deploy the exact durably validated revision as one idempotent server operation. */
export async function deployValidatedRevisionForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  validatedRevision: string;
  /** Called once the plan exists, so the caller can follow the stages it is about to record. */
  onPlanned?: (deploymentId: string) => void;
}): Promise<BuilderDeploymentState> {
  const deploymentId = await planValidatedRevision({ ...args, publication: 'Deployment' });
  args.onPlanned?.(deploymentId);
  const deployment = await deployForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
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
 * tool-call identity is what makes the preview an unpromoted version of that exact deployment
 * rather than a second publication with resources of its own.
 */
export async function previewValidatedRevisionForBuilder(args: {
  context: BuilderDeploymentContext;
  workspace: BuilderDeploymentWorkspace;
  toolCallId: string;
  previewId: string;
  validatedRevision: string;
  /** Called once the plan exists, so the caller can follow the stages it is about to record. */
  onPlanned?: (deploymentId: string) => void;
}) {
  const deploymentId = await planValidatedRevision({ ...args, publication: 'Preview' });
  args.onPlanned?.(deploymentId);
  return previewForUser({
    env: args.context.env,
    userId: args.context.userId,
    deploymentId,
    previewId: args.previewId,
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
    throw new Error('The durable project changed after validation. Run validation again.');
  }
  if (!(await args.workspace.hasSuccessfulValidation(snapshot.revision))) {
    throw new Error(`${args.publication} requires full validation for this exact revision.`);
  }
  const source = await args.workspace.prepareDeployment(snapshot.revision);
  const deploymentId = await publicationDeploymentId(args.workspace.projectId, args.toolCallId, snapshot.revision);
  await createOrReplayDeploymentPlanForUser({
    env: args.context.env,
    userId: args.context.userId,
    chatId: args.context.chatInitialId,
    deploymentId,
    projectId: args.workspace.projectId,
    revision: source.revision,
    workspaceRevision: source.workspaceRevision,
    project: source.project,
  });
  return deploymentId;
}

function publicationDeploymentId(projectId: string, toolCallId: string, revision: string): Promise<string> {
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
