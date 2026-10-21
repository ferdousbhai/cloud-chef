import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
  type OnChatMessageOptions,
} from '@cloudflare/ai-chat';
import { callable, type Connection, type FiberRecoveryContext, type FiberRecoveryResult } from 'agents';
import { canApplyConversationCompaction, conversationCompactionKey } from '~/lib/compaction';
import { createChatResponseFromBody, type ChatRequestBody } from '~/lib/.server/chat';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import {
  completeBuilderTurn,
  createBuilderTurn,
  createRecoveryTurn,
  exhaustedBuilderTurnResult,
  type BuilderTurnState,
  type BuilderTurnStatus,
} from './builder-turn-state';
import { DurableObjectContextCompactionRepository } from '~/lib/.server/llm/context-compaction-store';
import { compactContext } from '~/lib/.server/llm/context-compaction';
import { chatTurnContextSchema, type ChatTurnContext } from 'cloudchef-agent/turn-context';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import type { UIMessage } from 'ai';
import {
  buildCheckpointForBuilder,
  deployValidatedRevisionForBuilder,
  previewValidatedRevisionForBuilder,
  terminalizeInterruptedDeploymentForBuilder,
  type BuilderDeploymentState,
} from './builder-deployment-command';
import {
  publicationProgress,
  type BuilderPublicationLane,
  type BuilderPublicationState,
} from './builder-publication-progress';
import { latestDeploymentActivity } from '~/lib/.server/cloudflare/deployment-repository';
import {
  automaticDeploymentRetrySchema,
  nextAutomaticDeploymentRetry,
  PublicationSupersededError,
  type AutomaticDeploymentRetry,
  type DeploymentFailure,
} from './builder-publication-retry';
import { isRetryableDurableObjectError } from '~/lib/cloudflare/durable-object-rpc.server';
import { generateConversationTitle, generateProjectTitle } from '~/lib/.server/llm/workers-ai-title';
import { markChatStarted } from '~/lib/cloudflare/data/chat-repository.server';
import {
  setGeneratedProjectDescription,
  setGeneratedSubchatDescription,
  setHeuristicProjectDescriptionIfMissing,
  setHeuristicSubchatDescriptionIfMissing,
} from '~/lib/cloudflare/data/chat-service.server';
import { getToolInvocation, messageText, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import {
  transcriptCheckpointSchema,
  transcriptCheckpointsEqual,
  transcriptMessagesEqual,
  stripTranscriptBaseMetadata,
  advanceTranscriptCheckpoint,
  TRANSCRIPT_BASE_METADATA_KEY,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import { createWorkersAiSessionAffinity } from '~/lib/.server/llm/workers-ai-prompt-cache';
import {
  boundBuilderMessageForPersistence,
  builderTranscriptBindingsEqual,
  loadBuilderTranscriptBinding,
  loadChatOrgProject,
  requireBuilderRequestScope,
  requireBuilderTranscriptIdentity,
  type BuilderTranscriptBinding,
} from './builder-request-policy';
import { initializeBuilderAgentSchema } from './builder-agent-schema';
import {
  BuilderRuntimeActivity,
  isBuilderAgentBusy,
  RuntimeUpgradeWaitExceededError,
} from './builder-runtime-activity';
import { rethrowAgentRejection } from './builder-agent-rejection';
import {
  BuilderAgentIdentityMismatchError,
  BuilderAgentIdentityRepository,
  builderAgentIdentitiesEqual,
  type BuilderAgentDurableIdentity,
} from './builder-agent-identity';
import type {
  BuilderWorkspaceApi,
  BuilderWorkspaceCheckpoint,
  WorkspaceApplyChangesRequest,
  WorkspaceSyncPageRequest,
} from './builder-workspace-api';
import { UserWorkspaceRuntimeClient } from '~/lib/.server/cloudflare/user-workspace-runtime-client';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from './builder-workspace-types';
import { builderTemplateSeedId, loadBuilderTemplate } from './builder-template';
import { parentBuilderWorkspaceSeedId, seedBuilderWorkspace } from './builder-workspace-seed';
import {
  linkedWorkspaceChanges,
  newLinkedBranchKey,
  packDraftSnapshot,
  seedLinkedWorkspace,
} from './linked-project-workspace';
import {
  LINKED_BUILD_WATCH_MS,
  WORKERS_BUILDS_APPEAR_MS,
  linkedBuildSettledResult,
  linkedBuildStartedResult,
  linkedBuildUnfollowedResult,
  linkedBuildWatchSchema,
  watchLinkedBuild,
  withLinkedBuildResult,
  type LinkedBuildWatch,
} from './linked-project-build';
import {
  commitLinkedProject,
  linkedBuildStatus,
  linkedSiteOrigins,
  requestProductionReview,
  type ProductionRequestOutcome,
  streamLinkedProjectSnapshot,
  type LinkedSnapshotLine,
} from '~/lib/.server/cloudflare/linked-project-client';
import type { LinkedProjectModelToolContext } from '~/lib/.server/llm/linked-project-model-tools';
import { fetchLinkedSitePage, type LinkedSiteFetchInput } from '~/lib/.server/llm/linked-site-fetch';
import { BUILDER_TURN_WALL_CLOCK_MS } from '~/lib/.server/llm/builder-turn-limits';
import { deriveProvisionalTitle, shouldGenerateConversationTitle } from '~/lib/title-generation';
import {
  failedBuilderPreviewState,
  idleBuilderPreviewState,
  previewStateForWorkspace,
  type BuilderPreviewState,
} from './builder-preview-types';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { waitForCancellationBeforeDeadline } from './builder-cancellation';
import { PiSteeringQueue } from '~/lib/.server/llm/pi-steering';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS, MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import { z } from 'zod';
import { toolFailure, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import {
  BuilderCloudflareExecutionRepository,
  CLOUDFLARE_EXECUTION_RISK_NOTE,
  containsCredentialishCloudflareContent,
  publicExecutionState,
  type CloudflareExecutionBinding,
  type CloudflareExecutionRecord,
} from './builder-cloudflare-execution';
import {
  cloudflareApiRequestIsRead,
  CloudflareApiRequestRejectedError,
  normalizeCloudflareApiRequest,
  type CloudflareApiRequest,
  type CloudflareApiRequestInput,
  type CloudflareExecutionDecisionResult,
  type CloudflareExecutionPublicState,
  type CloudflareExecutionSafeOutcome,
  type CloudflareExecutionStatus,
  type CloudflareRequestFinalResult,
  type CloudflareRequestImmediateResult,
  type CloudflareRequestProposal,
} from 'cloudchef-agent/cloudflare-api';
import {
  cloudflareApiWriteEnabled,
  readCloudflareApiRuntimeAdmission,
  type CloudflareApiRuntimeAdmission,
  type CloudflareApiRuntimeIdentity,
  runtimeIdentity,
} from '~/lib/.server/cloudflare/cloudflare-api-runtime-controls';
import { CloudflareApiClient, type CloudflareApiOutcome } from '~/lib/.server/cloudflare/cloudflare-api-client';
import {
  confirmUserWorkspaceAccess,
  modelRequestAccess,
  readAccountModelSettings,
  reportUserWorkspaceModelUsage,
  resolveUserWorkspaceCloudflareAccessToken,
} from '~/lib/.server/cloudflare/user-workspace-cloudflare-credential';
import { workersAiGatewayLogging, type WorkersAiGatewayLogging } from '~/lib/.server/llm/workers-ai-gateway';
import { turnUsage, type ModelTurnUsage } from '~/lib/.server/llm/workers-ai-telemetry';
import type { Usage } from '@earendil-works/pi-ai';
import { requireBuilderModel, requireBuilderReasoningLevel } from '~/lib/.server/llm/workers-ai-model-catalog';
import type {
  CloudflareApiModelToolContext,
  ModelToolExecutionOptions,
} from '~/lib/.server/llm/cloudflare-api-model-tools';

const logger = createScopedLogger('BuilderAgent');

/**
 * The tool-call identity every publication of one validated revision shares. Deployment, its
 * recovery, and its previews resolve to the same deterministic deployment plan because they name
 * the same checkpoint here.
 */
function deploymentToolCallId(workspaceRevision: number, revision: string): string {
  return `deploy-command:${workspaceRevision}:${revision}`;
}

const CONTEXT_COMPACTION_FIBER = 'background:context_compaction';
const PREVIEW_PUBLICATION_FIBER = 'background:builder_preview';
const DEPLOYMENT_FIBER = 'background:builder_deployment';
const DEPLOYMENT_INTERRUPTED_MESSAGE = 'Deployment was interrupted. Retry to reconcile the exact revision.';
/**
 * How long a new turn waits for the automatic publication it stopped to let go of the workspace. A
 * publication stops at its next step, or finishes its last API calls once it has started changing
 * production; a turn change that still meets it waits a while longer in the runtime client.
 */
const PUBLICATION_STOP_WAIT_MS = 30_000;
const TITLE_GENERATION_FIBER = 'background:title_generation';
const CLOUDFLARE_EXECUTION_FIBER = 'background:cloudflare_execution';
const LINKED_BUILD_FIBER = 'background:linked_build';
/** A cancelled turn settles its transcript a moment after it stops: a watched publish missing that long is gone. */
const LINKED_BUILD_MISSING_GRACE_MS = 30_000;
const LINKED_BUILD_LANDING_POLL_MS = 2_000;
const TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS = 4_000;
/**
 * How often a running publication re-reads the step it last recorded. Publication steps take tens
 * of seconds each, so this is a heartbeat against one indexed row, not a poll for a result.
 */
const PUBLICATION_ACTIVITY_INTERVAL_MS = 2_000;
const CHAT_CANCELLATION_SETTLE_TIMEOUT_MS = 4.5 * 60 * 1000;
/**
 * How long a turn waits for a workspace upgrade to finish before it gives up with a message to send
 * again. An upgrade's window lapses five minutes after its last renewal, but one that keeps renewing it
 * must not hold a turn indefinitely.
 */
const TURN_UPGRADE_WAIT_MS = 3 * 60_000;
/**
 * How long an archived conversation waits for a publish to GitHub already under way before it reports
 * that it has not settled: the commit call's own timeout (two minutes), and a little for what follows it.
 */
const LINKED_PUBLISH_SETTLE_MS = 2.5 * 60_000;
/** A copy of another workspace starts over when that one changes meanwhile; it changing this often is a fault. */
const MAX_WORKSPACE_COPY_RESTARTS = 5;
const ARCHIVED_CONVERSATION_MESSAGE = 'This conversation continues in a newer one. Open the project to keep working.';
const DELETED_CONVERSATION_MESSAGE = 'This conversation was deleted.';

/** Fiber metadata survives a Durable Object restart, so every job is re-parsed before it is resumed. */
const previewPublicationJobSchema = z.object({
  previewId: z.string().min(1),
  workspaceRevision: z.number().int().min(0),
  snapshotRevision: z.string().min(1),
  requestedAt: z.number().int().positive(),
  // Manual "Build preview" requests must not promote to the public production URL. Only the
  // end-of-turn pipeline (publishRevision) opts into the deployment behind the preview.
  autoDeploy: z.boolean().default(true),
});
type PreviewPublicationJob = z.infer<typeof previewPublicationJobSchema>;

const deploymentJobSchema = z.object({
  workspaceRevision: z.number().int().min(0),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}) satisfies z.ZodType<BuilderWorkspaceCheckpoint>;
type DeploymentJob = z.infer<typeof deploymentJobSchema>;
/** Kept beside the job in a deployment fiber's metadata: whether a turn started it, and how many retries preceded it. */
const deploymentRunSchema = z.object({
  automatic: z.boolean().default(false),
  attempt: z.number().int().min(0).default(0),
});
type DeploymentRun = z.infer<typeof deploymentRunSchema>;

/**
 * The publication commands, the agent's boundary with the deployment executor and the user's
 * account. The BuilderAgent harness replaces them, as it replaces the ProjectWorkspace.
 */
const builderPublisher = {
  preview: previewValidatedRevisionForBuilder,
  deploy: deployValidatedRevisionForBuilder,
  terminalize: terminalizeInterruptedDeploymentForBuilder,
};

/** A publication this agent instance is running: a new turn stops the automatic ones and waits for them. */
type RunningPublication = { automatic: boolean; controller: AbortController; settled: Promise<void> };

/** Owner identifiers reach this Durable Object over RPC, so they are re-checked at every entry point. */
const transcriptOwnerIdSchema = z.string().min(1).max(512);

/** Context compaction fibers carry only the message they were asked to compact through. */
const contextCompactionJobSchema = z.object({ throughMessageId: z.string().min(1) });

const cloudflareExecutionDecisionSchema = z.object({ executionId: z.string().uuid() }).strict();
const cloudflareExecutionFiberSchema = z
  .object({ executionId: z.string().uuid(), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
type CloudflareExecutionFiberJob = z.infer<typeof cloudflareExecutionFiberSchema>;

/** A message may carry the transcript checkpoint its sender was working from. */
const transcriptBaseMetadataSchema = z.object({
  [TRANSCRIPT_BASE_METADATA_KEY]: transcriptCheckpointSchema.nullable(),
});

/** Steering text arrives over the agent connection while a turn is already running. */
const steeringRequestSchema = z.object({ text: z.string() });

const titleGenerationJobSchema = z.object({
  chatInitialId: z.string().min(1),
  firstPrompt: z.boolean(),
  prompt: z.string().min(1).max(TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS),
  promptGeneration: z.number().int().min(1),
  subchatIndex: z.number().int().min(0),
});
type TitleGenerationJob = z.infer<typeof titleGenerationJobSchema>;

export type BuilderAgentState = {
  activeTurn?: BuilderTurnState | null;
  generatedSubchatTitle?: {
    subchatIndex: number;
    title: string;
    updatedAt: string;
  } | null;
  lastCompletedTurn?: BuilderTurnState | null;
  transcript?: TranscriptCheckpoint | null;
  preview?: BuilderPreviewState | null;
  validationProgress?: {
    toolCallId: string;
    stage: BuilderValidationStage;
  } | null;
  deployment?: BuilderDeploymentState | null;
  /** The revision production last promoted, kept so a publication that never finished is redone. */
  productionRevision?: string | null;
  /**
   * A turn changed this CloudChef app and production has not caught up yet. Set as the turn settles
   * and cleared only once production serves the current revision, so a cancelled, failed, or
   * restart-interrupted publication is redone at the next turn's end or the agent's next start.
   */
  publicationPending?: boolean;
  /**
   * The revision whose automatic publication last failed (its preview or its deployment). Waking the
   * agent does not publish it again, since it would only fail the same way; the next turn's end does.
   */
  failedPublicationRevision?: string | null;
  /** The step the running preview or deployment publication last recorded, while it is running. */
  publication?: BuilderPublicationState | null;
  /**
   * A turn is waiting for an upgrade of the workspace runtime to finish before it starts, for at most
   * a few minutes. The browser shows that the workspace is upgrading.
   */
  upgradeWaiting?: boolean;
  contextCompactionRequestedTurnId?: string | null;
  cloudflareExecutions?: CloudflareExecutionPublicState[];
  /** The organization GitHub project this workspace works on, once it's prepared; null for a CloudChef app. */
  linkedProject?: BuilderLinkedProjectSummary | null;
};

/** What the browser shows of a GitHub project: which repository, and the branch its pipeline deploys. */
/** `archived`: a newer conversation on the project took over from this one, which is kept only to read. */
export type BuilderLinkedProjectSummary = { repository: string; defaultBranch: string; archived?: boolean };

/** Durable transcript as the agent currently holds it, returned after a cancel or an explicit reload. */
type BuilderTranscriptSnapshot = {
  checkpoint: TranscriptCheckpoint | null;
  messages: NonNullable<ChatRequestBody['messages']>;
};

/** Payload the connected client sends to steer a running turn. */
export type BuilderSteeringInput = {
  text: string;
  turnContext?: ChatTurnContext;
};

type BuilderAgentProps = {
  ownerId: string;
  userId: string;
};

export class BuilderAgent extends AIChatAgent<Env, BuilderAgentState, BuilderAgentProps> {
  static override options = {
    sendIdentityOnConnect: false,
  };

  initialState: BuilderAgentState = {
    activeTurn: null,
    generatedSubchatTitle: null,
    lastCompletedTurn: null,
    transcript: null,
    preview: idleBuilderPreviewState(),
    validationProgress: null,
    deployment: null,
    productionRevision: null,
    publicationPending: false,
    failedPublicationRevision: null,
    publication: null,
    upgradeWaiting: false,
    contextCompactionRequestedTurnId: null,
    cloudflareExecutions: [],
    linkedProject: null,
  };

  override chatRecovery = {
    terminalMessage: 'The builder was interrupted. Please send your message again.',
    onExhausted: (context: ChatRecoveryExhaustedContext) => {
      const activeTurn = this.state.activeTurn;
      if (!activeTurn) {
        return;
      }
      const result = exhaustedBuilderTurnResult(activeTurn, context);
      if (result) {
        this.finishTurn(activeTurn, result);
      }
    },
  };

  private readonly contextCompaction = new DurableObjectContextCompactionRepository(this);
  private readonly identityRepository: BuilderAgentIdentityRepository;
  private readonly cloudflareExecutions: BuilderCloudflareExecutionRepository;
  private readonly workspace: BuilderWorkspaceApi;
  private ownerId: string | null = null;
  private userId: string | null = null;
  private transcriptBinding: BuilderTranscriptBinding | null = null;
  private activeSteering: { turnId: string; queue: PiSteeringQueue } | null = null;
  private readonly publisher = builderPublisher;
  private readonly runningPublications = new Set<RunningPublication>();
  /**
   * Advanced each time a new turn stops the automatic publications. Automatic publication work notes
   * it before it starts and gives up once it changed, so nothing a stopped publication had in flight
   * (waiting to be admitted, or for its fiber to start) starts after the stop.
   */
  private publicationEpoch = 0;
  /** Chat requests between stopping the automatic publications and recording their turn as active. */
  private startingTurns = 0;
  /** Publishes to GitHub under way: an archived conversation waits for them before its successor copies it. */
  private readonly runningLinkedPublishes = new Set<Promise<CloudChefToolResult>>();
  /** The seed of a new workspace under way, which every caller needing the workspace seeded shares. */
  private workspaceSeed: Promise<BuilderWorkspaceState> | null = null;
  /** Set once the GC outbox deletes this project: nothing may start publishing it again. */
  private destroying = false;
  /** Tells the control plane, through the runtime, when a redeploy would cut this agent's work off. */
  private readonly runtimeActivity: BuilderRuntimeActivity;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeBuilderAgentSchema(ctx);
    this.identityRepository = new BuilderAgentIdentityRepository(ctx.storage);
    this.cloudflareExecutions = new BuilderCloudflareExecutionRepository(ctx.storage);
    this.workspace = new UserWorkspaceRuntimeClient(env, ctx.id.toString(), () => this.userId);
    this.runtimeActivity = new BuilderRuntimeActivity({
      db: env.DB,
      agentName: () => this.name,
    });
  }

  override onStateChanged(state: BuilderAgentState | undefined): void {
    void this.runtimeActivity.observe(isBuilderAgentBusy(state));
  }

  async onStart(props?: BuilderAgentProps) {
    if (props) {
      await this.initializeIdentity(props);
    } else {
      await this.hydrateDurableIdentity({ required: false, reason: 'agent_start' });
    }
    this.refreshCloudflareExecutionState();
    if (this.state.upgradeWaiting) {
      // The turn that waited stopped with the instance before it started.
      this.setState({ ...this.state, upgradeWaiting: false });
    }
    // A publication a turn asked for may not have reached production before this instance stopped.
    if (this.state.publicationPending && this.userId) {
      this.ctx.waitUntil(
        this.resumeUnfinishedPublication().catch(() => logger.warn('Unable to resume the unfinished publication')),
      );
    }
  }

  override onError(...args: [connection: Connection, cause: unknown] | [cause: unknown]): void {
    rethrowAgentRejection(args.at(-1));
    if (args.length === 2) {
      super.onError(args[0], args[1]);
    } else {
      super.onError(args[0]);
    }
  }

  /**
   * Accept durable deletion without making the caller wait for the
   * abort-shaped `destroy()` RPC. This is intentionally not decorated with
   * `@callable`: it is an internal Durable Object RPC used only by the D1 GC
   * outbox.
   */
  async scheduleDestroyForGc(ownerId: string): Promise<void> {
    await this.initializeGcIdentity(ownerId);
    this.destroying = true;
    for (const publication of this.runningPublications) {
      publication.controller.abort(new Error('Project deletion'));
    }
    // Every background job that would publish or watch this project stops with it.
    const live = await this.listFibers({ status: ['pending', 'running', 'interrupted'] }).catch(() => []);
    for (const fiber of live) {
      if (
        fiber.name === PREVIEW_PUBLICATION_FIBER ||
        fiber.name === DEPLOYMENT_FIBER ||
        fiber.name === LINKED_BUILD_FIBER
      ) {
        await this.cancelFiber(fiber.fiberId, 'Project deletion').catch(() => undefined);
      }
    }
    await this.workspace.deleteProject();
    await this._cf_scheduleDestroy();
  }

  private async initializeGcIdentity(ownerId: string): Promise<void> {
    if (!transcriptOwnerIdSchema.safeParse(ownerId).success) {
      throw new Response('Invalid transcript owner', { status: 400 });
    }
    if (this.ownerId && this.ownerId !== ownerId) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const owned = await this.env.DB.prepare(
      `SELECT 1 AS found
       FROM chat_transcripts AS transcripts
       INNER JOIN chats ON chats.id = transcripts.chat_id
       WHERE transcripts.agent_name = ? AND chats.creator_id = ?
       LIMIT 1`,
    )
      .bind(this.name, ownerId)
      .first<{ found: number }>();
    if (!owned) {
      throw new Response('Agent not found.', { status: 404 });
    }
    this.ownerId = ownerId;
    this.userId = ownerId;
  }

  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    await this.hydrateDurableIdentity({ required: true, reason: 'chat_recovery', incidentId: ctx.incidentId });
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    const lastTurn = this.state.lastCompletedTurn;
    if (
      !this.state.activeTurn &&
      lastTurn?.status === 'aborted' &&
      (lastTurn.requestId === ctx.requestId || lastTurn.requestId === ctx.recoveryRootRequestId)
    ) {
      logger.info('Skipping recovery for a durably cancelled CloudChef chat turn', {
        incidentId: ctx.incidentId,
      });
      return { persist: true, continue: false };
    }
    const nextTurn = createRecoveryTurn(ctx, this.state.activeTurn);
    this.setState({
      ...this.state,
      activeTurn: nextTurn,
    });
    logger.warn('Recovering interrupted CloudChef chat turn', {
      incidentId: nextTurn.recovery?.incidentId,
      recoveryKind: ctx.recoveryKind,
      attempt: ctx.attempt,
      hasPartialOutput: ctx.partialText.length > 0,
    });

    return {};
  }

  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    await this.hydrateDurableIdentity({
      required: true,
      reason: 'fiber_recovery',
      incidentId: ctx.id,
    });
    if (ctx.name === TITLE_GENERATION_FIBER) {
      const job = titleGenerationJobSchema.safeParse(ctx.metadata).data;
      if (!job || !this.userId) {
        return { status: 'error', error: 'missing title generation recovery data' };
      }
      const credentials = await getUserWorkersAiCredentials(this.env, this.userId);
      // Asked again: the person may have turned logging off since the turn that started this.
      const access = await modelRequestAccess(this.env).catch(() => null);
      await this.generateTitlesForPrompt({
        ...job,
        accountCredentials: credentials,
        gatewayLogging: workersAiGatewayLogging(access?.allowed === true && access.contentLogging),
      });
      return { status: 'completed', snapshot: ctx.snapshot };
    }
    if (ctx.name === PREVIEW_PUBLICATION_FIBER) {
      const job = previewPublicationJobSchema.safeParse(ctx.metadata).data;
      if (!job) {
        return { status: 'error', error: 'missing preview publication recovery data' };
      }
      await this.runPreviewPublication(job);
      return { status: 'completed', snapshot: ctx.snapshot };
    }
    if (ctx.name === DEPLOYMENT_FIBER) {
      const job = deploymentJobSchema.safeParse(ctx.metadata).data;
      if (!job || !this.userId || !this.transcriptBinding) {
        return { status: 'error', error: 'missing deployment recovery data' };
      }
      const run = deploymentRunSchema.safeParse(ctx.metadata ?? {}).data ?? { automatic: false, attempt: 0 };
      const error = new Error(DEPLOYMENT_INTERRUPTED_MESSAGE);
      let terminalized: BuilderDeploymentState;
      try {
        terminalized = await this.runtimeActivity.run(() => this.retry(() => this.terminalizeDeployment(job)));
      } catch {
        logger.error('Unable to terminalize the interrupted deployment');
        const pending = new Error('Interrupted deployment recovery is pending. Retry to continue.');
        this.failDeployment(job, pending);
        await this.scheduleAutomaticDeploymentRetry(job, run, { message: pending.message, retryable: false });
        return { status: 'error', error: 'Interrupted deployment recovery did not settle safely.' };
      }
      if (terminalized.status === 'succeeded') {
        // It finished in the user's account before this instance stopped: production serves it.
        await this.recordDeploymentSucceeded(job, terminalized);
        return { status: 'completed', snapshot: ctx.snapshot };
      }
      this.failDeployment(job, error);
      await this.scheduleAutomaticDeploymentRetry(job, run, { message: error.message, retryable: false });
      return { status: 'error', error: error.message };
    }
    if (ctx.name === LINKED_BUILD_FIBER) {
      const watch = linkedBuildWatchSchema.safeParse(ctx.metadata).data;
      if (!watch) {
        return { status: 'error', error: 'missing linked build recovery data' };
      }
      await this.runtimeActivity.run(() => this.keepAliveWhile(() => this.runLinkedBuildWatch(watch)));
      return { status: 'completed', snapshot: ctx.snapshot };
    }
    if (ctx.name === CLOUDFLARE_EXECUTION_FIBER) {
      const job = cloudflareExecutionFiberSchema.safeParse(ctx.metadata).data;
      if (!job) {
        return { status: 'error', error: 'missing Cloudflare execution recovery data' };
      }
      const execution = this.cloudflareExecutions.recoverIndeterminate(job.executionId, job.proposalSha256);
      this.refreshCloudflareExecutionState();
      await this.persistCloudflareExecutionResult(execution);
      return {
        status: 'error',
        error: 'The approved Cloudflare execution was interrupted and will not be replayed.',
      };
    }
    if (ctx.name !== CONTEXT_COMPACTION_FIBER) {
      return super.onFiberRecovered(ctx);
    }
    const compaction = contextCompactionJobSchema.safeParse(ctx.metadata);
    if (!compaction.success || !this.userId) {
      return { status: 'error', error: 'missing context compaction recovery data' };
    }
    await this.runContextCompaction(compaction.data.throughMessageId);
    return { status: 'completed', snapshot: ctx.snapshot };
  }

  override async onChatMessage(
    _onFinish?: Parameters<AIChatAgent['onChatMessage']>[0],
    options?: OnChatMessageOptions,
  ) {
    const durableIdentity = await this.hydrateDurableIdentity({ required: true, reason: 'chat_message' });
    if (!durableIdentity) {
      this.rejectIdentity('chat_message_missing', undefined, 401);
    }
    const body = options?.body ?? {};
    const messages = this.messages;
    // A conversation a newer one took over is kept to read: working here would edit an old copy of the
    // project and publish it over the newer one's work.
    if ((await loadChatOrgProject(this.env.DB, { agentName: this.name, ownerId: durableIdentity.ownerId })).archived) {
      throw new Response(ARCHIVED_CONVERSATION_MESSAGE, { status: 409 });
    }
    const { chatInitialId, subchatIndex, transcript, modelId, reasoningLevel } = requireBuilderRequestScope(
      body,
      durableIdentity.transcript,
    );
    const accountCredentials = await getUserWorkersAiCredentials(this.env, durableIdentity.userId);
    const { model, gatewayKeyAlias, gatewayKeyRevision } = await requireBuilderModel(
      accountCredentials.binding,
      modelId,
      async () => (await readAccountModelSettings(this.env)).gatewayKeys,
    );
    const chosenReasoningLevel = requireBuilderReasoningLevel(model, reasoningLevel);
    // Refused before anything is stopped or recorded: a turn that never starts must not hold anything.
    const requestedTurnContext = parseTurnContext(body.turnContext);
    // From the stop until the turn is recorded active, no automatic publication may start: this turn's
    // end publishes.
    this.startingTurns += 1;
    let turn: BuilderTurnState;
    let started = false;
    try {
      if (!options?.continuation) {
        // The person is talking to the builder again: the publication of the last turn must not hold the
        // workspace this turn edits. It publishes again, with this turn's changes, when this turn ends.
        await this.stopAutomaticPublications();
        await markChatStarted(this.env.DB, {
          sessionId: durableIdentity.ownerId,
          chatId: chatInitialId,
          agentName: transcript.agentName,
        });
      }
      await this.advanceTranscriptCheckpoint(transcript);
      turn = createBuilderTurn(options?.requestId);
      this.setState({
        ...this.state,
        activeTurn: turn,
      });
      started = true;
    } finally {
      this.startingTurns -= 1;
      if (!started) {
        // It stopped the automatic publications and failed before it began: nothing ends to publish them.
        this.publishAfterInterruptedTurn();
      }
    }
    const turnContext = withPublicationFailure(requestedTurnContext, this.publicationFailure());
    const userMessages = messages.filter((message: { role?: string }) => message.role === 'user');
    const firstUserMessage = !options?.continuation && userMessages.length === 1;
    const latestPrompt = !options?.continuation ? userMessages.at(-1) : undefined;
    const latestPromptText = latestPrompt ? messageText(latestPrompt) : '';
    const shouldGenerateTitle = shouldGenerateConversationTitle(latestPromptText, userMessages.length);
    console.info({
      event: 'builder_chat_turn_started',
      continuation: options?.continuation === true,
      firstUserMessage,
    });
    const steering = new PiSteeringQueue();
    this.activeSteering = { turnId: turn.id, queue: steering };
    const settleSteering = () => {
      if (this.activeSteering?.turnId === turn.id) {
        this.activeSteering = null;
      }
    };

    try {
      // Before any model work: a Worker upgrade that found this workspace idle a moment ago lands first.
      // A Stop calls the wait off, and an upgrade that keeps its window open too long fails the turn.
      await this.runtimeActivity
        .admit({
          signal: options?.abortSignal,
          maxWaitMs: TURN_UPGRADE_WAIT_MS,
          onWaiting: (waiting) => this.setUpgradeWaiting(waiting),
        })
        .catch((error: Error) => {
          throw error instanceof RuntimeUpgradeWaitExceededError ? new Response(error.message, { status: 503 }) : error;
        });
      // Again now that the turn is visible: a newer conversation that took over meanwhile either saw this
      // turn and stopped it, or archived this one before this read.
      await this.refuseIfClosed();
      const { contentLogging } = await this.requireModelAccess();
      // The browser prepares the workspace before it sends, but nothing else seeds a new one.
      await this.initializeWorkspace(durableIdentity.transcript);
      const cloudflareApi = await this.createCloudflareApiToolContext(durableIdentity.transcript);
      const linkedProject = await this.createLinkedProjectToolContext();
      if (shouldGenerateTitle) {
        await this.scheduleTitleGeneration(
          {
            chatInitialId,
            firstPrompt: firstUserMessage,
            prompt: latestPromptText.slice(0, TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS),
            promptGeneration: userMessages.length,
            subchatIndex,
          },
          accountCredentials,
          workersAiGatewayLogging(contentLogging),
        );
      }
      const compactionPending = await this.hasPendingContextCompaction();
      return await createChatResponseFromBody({
        abortSignal: options?.abortSignal,
        firstUserMessage,
        turnContext,
        accountCredentials,
        sessionAffinity: await createWorkersAiSessionAffinity(transcript, modelId),
        // When the person allows logging, the turn's requests are found in the account's AI Gateway logs
        // by chat (its URL id) and member; otherwise they are neither logged nor labelled.
        gatewayLogging: workersAiGatewayLogging(contentLogging, {
          chat: chatInitialId,
          user: durableIdentity.userId,
          agent: transcript.agentName,
        }),
        gatewayKeyAlias,
        gatewayKeyRevision,
        workspace: this.workspace,
        cloudflareApi,
        linkedProject,
        onValidationStage: (toolCallId, stage) => this.setValidationProgress(toolCallId, stage),
        runWithKeepAlive: (operation) => this.keepAliveWhile(operation),
        steering,
        onSettled: (report) => {
          settleSteering();
          // A GitHub project publishes through its own pipeline, when the agent publishes to it.
          if (report.changedProject && !linkedProject && !this.state.publicationPending) {
            this.setState({ ...this.state, publicationPending: true });
          }
        },
        onModelUsage: (usage) => this.reportModelUsage(usage),
        compaction: {
          current: this.contextCompaction.getCompaction(),
          pending: compactionPending,
          save: (compaction) => this.contextCompaction.saveCompaction(compaction),
          schedule: async () => {
            const throughMessageId = messages.at(-1)?.id;
            if (throughMessageId) {
              await this.scheduleContextCompaction(throughMessageId, messages.length);
            }
          },
          requestDurableCompaction: () => {
            if (this.state.activeTurn?.id === turn.id && this.state.contextCompactionRequestedTurnId !== turn.id) {
              this.setState({
                ...this.state,
                contextCompactionRequestedTurnId: turn.id,
              });
            }
          },
        },
        body: { messages, modelId },
        model,
        reasoningLevel: chosenReasoningLevel,
      });
    } catch (error) {
      steering.close();
      settleSteering();
      // A Stop has already finished it as cancelled, which its recovery must still see, and publishes
      // what this turn stopped.
      if (this.state.activeTurn?.id === turn.id) {
        this.finishTurn(turn, {
          status: 'error',
        });
        this.publishAfterInterruptedTurn();
      }
      throw error;
    }
  }

  private setUpgradeWaiting(waiting: boolean): void {
    if (Boolean(this.state.upgradeWaiting) !== waiting) {
      this.setState({ ...this.state, upgradeWaiting: waiting });
    }
  }

  private async scheduleContextCompaction(throughMessageId: string, revision: number): Promise<void> {
    if (await this.hasPendingContextCompaction()) {
      return;
    }
    await this.startFiber(
      CONTEXT_COMPACTION_FIBER,
      async (fiber) => {
        fiber.stash({ throughMessageId, version: 1 });
        await this.runContextCompaction(throughMessageId);
      },
      {
        idempotencyKey: conversationCompactionKey({
          scope: this.name,
          throughId: throughMessageId,
          revision,
        }),
        metadata: { throughMessageId },
      },
    );
  }

  private async runContextCompaction(throughMessageId: string): Promise<void> {
    const currentMessages = this.messages;
    const throughIndex = currentMessages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) {
      return;
    }
    const sourceMessages = currentMessages.slice(0, throughIndex + 1);
    const expected = this.contextCompaction.getCompaction();
    const next = compactContext({
      messages: sourceMessages,
      current: expected,
    });
    if (!next) {
      return;
    }
    const latestIds = this.messages.map((message) => message.id);
    if (
      !canApplyConversationCompaction({
        expectedFromId: next.fromMessageId,
        expectedThroughId: next.toMessageId,
        currentMessageIds: latestIds,
        currentThroughId: this.contextCompaction.getCompaction()?.toMessageId,
      })
    ) {
      return;
    }
    this.contextCompaction.saveCompactionIfCurrent(next, expected);
  }

  private async hasPendingContextCompaction(): Promise<boolean> {
    const fibers = await this.listFibers({
      name: CONTEXT_COMPACTION_FIBER,
      status: ['pending', 'running', 'interrupted'],
      limit: 1,
    });
    return fibers.length > 0;
  }

  protected override async onChatResponse(result: ChatResponseResult) {
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    const currentTurn = this.state.activeTurn;
    if (!currentTurn) {
      return;
    }

    const status: BuilderTurnStatus =
      result.status === 'completed' ? 'completed' : result.status === 'aborted' ? 'aborted' : 'error';
    const compactAfterTurn = this.state.contextCompactionRequestedTurnId === currentTurn.id;
    this.finishTurn(currentTurn, {
      requestId: result.requestId,
      status,
    });
    if (compactAfterTurn) {
      this.setState({ ...this.state, contextCompactionRequestedTurnId: null });
    }
    // A handoff accepted before an abort/error still belongs to the persisted transcript.
    if (compactAfterTurn && this.userId) {
      const throughMessageId = this.messages.at(-1)?.id;
      if (throughMessageId) {
        try {
          await this.scheduleContextCompaction(throughMessageId, this.messages.length);
        } catch {
          logger.warn('Unable to queue post-turn context rollover');
        }
      }
    }
    const validatedSnapshot = await this.refreshDeploymentReadiness();
    // A turn that changed a CloudChef app, or one before it whose publication never reached production,
    // publishes it however the turn ended: the preview builds the exact revision (unless the model
    // already validated it) and production follows. A GitHub project previews and deploys through its
    // own pipeline, when the agent publishes to it.
    if (this.state.publicationPending || (status === 'completed' && validatedSnapshot)) {
      await this.publishLatestRevision(validatedSnapshot);
    }
  }

  @callable()
  async steerActiveTurn(input: BuilderSteeringInput): Promise<{ accepted: true }> {
    await this.hydrateDurableIdentity({ required: true, reason: 'steer_active_turn' });
    const steering = steeringRequestSchema.safeParse(input);
    if (!steering.success) {
      throw new Response('Invalid steering message', { status: 400 });
    }
    const text = steering.data.text.trim();
    if (!text || text.length > MAX_USER_MESSAGE_CHARACTERS) {
      throw new Response('Invalid steering message', { status: 400 });
    }
    const active = this.activeSteering;
    if (!active || this.state.activeTurn?.id !== active.turnId) {
      throw new Response('The builder is not currently running.', { status: 409 });
    }
    await this.refuseIfClosed();

    const message: UIMessage = {
      id: `steering-${crypto.randomUUID()}`,
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    const reservation = active.queue.reserve(message, parseTurnContext(input.turnContext));
    if (!reservation) {
      throw new Response('The builder turn has already finished.', { status: 409 });
    }
    try {
      await this.persistMessages([...this.messages, message]);
      if (this.state.transcript) {
        await this.advanceTranscriptCheckpoint(this.state.transcript);
      }
      reservation.commit();
      return { accepted: true };
    } catch (error) {
      reservation.reject(error);
      throw error;
    }
  }

  @callable()
  async approveCloudflareExecution(input: { executionId: string }): Promise<CloudflareExecutionDecisionResult> {
    const parsed = cloudflareExecutionDecisionSchema.safeParse(input);
    if (!parsed.success) {
      throw new Response('Invalid Cloudflare execution decision.', { status: 400 });
    }
    await this.waitForCloudflareDecisionBoundary();
    const binding = await this.requireCurrentCloudflareExecutionBinding('approve_cloudflare_execution');
    await this.refuseIfClosed();
    const proposal = await this.cloudflareExecutions.verify(parsed.data.executionId, binding);
    if (
      proposal.status === 'rejected' ||
      proposal.status === 'expired' ||
      proposal.status === 'failed' ||
      proposal.status === 'indeterminate'
    ) {
      throw new Response('This Cloudflare execution can no longer be approved.', { status: 409 });
    }
    const job: CloudflareExecutionFiberJob = {
      executionId: proposal.executionId,
      proposalSha256: proposal.proposalSha256,
    };
    await this.runtimeActivity.admit();
    const fiber = await this.startFiber(
      CLOUDFLARE_EXECUTION_FIBER,
      async (context) => {
        context.stash(job);
        await this.runtimeActivity.run(() => this.runApprovedCloudflareExecution(job, binding));
      },
      {
        idempotencyKey: `cloudflare-execution:${proposal.executionId}`,
        metadata: job,
        waitForCompletion: true,
      },
    );
    const execution = this.cloudflareExecutions.get(proposal.executionId);
    if (!execution) {
      throw new Error('The Cloudflare execution disappeared after its durable fiber completed.');
    }
    this.refreshCloudflareExecutionState();
    return {
      execution: publicExecutionState(execution),
      resumeTurn: fiber.accepted && execution.status !== 'rejected' && execution.status !== 'expired',
    };
  }

  @callable()
  async rejectCloudflareExecution(input: { executionId: string }): Promise<CloudflareExecutionDecisionResult> {
    const parsed = cloudflareExecutionDecisionSchema.safeParse(input);
    if (!parsed.success) {
      throw new Response('Invalid Cloudflare execution decision.', { status: 400 });
    }
    await this.waitForCloudflareDecisionBoundary();
    const binding = await this.requireCurrentCloudflareExecutionBinding('reject_cloudflare_execution');
    const { record, transitioned } = await this.cloudflareExecutions.reject(parsed.data.executionId, binding);
    this.refreshCloudflareExecutionState();
    await this.persistCloudflareExecutionResult(record);
    return { execution: publicExecutionState(record), resumeTurn: transitioned };
  }

  @callable()
  // The `agents` `call()` client surface only admits JSON-serializable returns, and a transcript
  // message may carry a `Date`. The caller re-parses this payload in `settleBuilderStop`.
  async cancelActiveTurn(): Promise<unknown> {
    const deadline = Date.now() + CHAT_CANCELLATION_SETTLE_TIMEOUT_MS;
    const activeTurn = this.state.activeTurn;
    const validationCancellation = this.workspace.cancelActiveValidation();
    this.abortAllRequests(new DOMException('Cancelled by the project owner', 'AbortError'));
    if (activeTurn) {
      this.finishTurn(activeTurn, {
        status: 'aborted',
      });
    }
    await waitForCancellationBeforeDeadline(validationCancellation, deadline);
    const remainingSettleTime = Math.max(0, deadline - Date.now());
    const settled = await this.waitUntilStable({
      timeout: remainingSettleTime,
      pendingInteraction: () => false,
    });
    if (!settled) {
      throw new Error('The cancelled builder turn did not settle before the cancellation timeout.');
    }
    if (activeTurn) {
      // Its end found no turn to finish, so nothing redid the publication it stopped.
      this.publishAfterInterruptedTurn();
    }
    const checkpoint = this.state.transcript ? await this.advanceTranscriptCheckpoint(this.state.transcript) : null;
    return {
      checkpoint,
      messages: this.messages,
    };
  }

  /**
   * A newer conversation on this GitHub project has taken over (this chat is archived): stop the turn
   * running here and return once nothing more can change this workspace, so the copy the newer one takes
   * next is final. Saves, steering, approvals and publishing are already refused here. Its build watch
   * keeps running: it only reads GitHub and fills in this transcript's publish result.
   *
   * An internal Durable Object RPC, not `@callable`: the data API calls it when the new conversation
   * starts, and the new conversation's agent before it copies this workspace.
   */
  async settleForSuccessor(ownerId: string): Promise<void> {
    if (!transcriptOwnerIdSchema.safeParse(ownerId).success) {
      throw new Response('Invalid transcript owner', { status: 400 });
    }
    const identity = await this.hydrateDurableIdentity({ required: false, reason: 'settle_for_successor' });
    if (!identity) {
      // Never started, so nothing runs here.
      return;
    }
    if (identity.ownerId !== ownerId) {
      throw new Response('Agent not found.', { status: 404 });
    }
    if (!(await loadChatOrgProject(this.env.DB, { agentName: this.name, ownerId })).archived) {
      throw new Response('This conversation is still the current one.', { status: 409 });
    }
    this.showLinkedProject(this.state.linkedProject ? { ...this.state.linkedProject, archived: true } : null);
    if (this.state.activeTurn) {
      await this.cancelActiveTurn();
    } else {
      const settled = await this.waitUntilStable({
        timeout: CHAT_CANCELLATION_SETTLE_TIMEOUT_MS,
        pendingInteraction: () => false,
      });
      if (!settled) {
        throw new Error('The earlier conversation did not settle in time.');
      }
    }
    // A publish whose commit was already on its way runs to the end whatever the Stop: its commit moves
    // this workspace's base, which the successor copies.
    if (!(await this.waitForLinkedPublishes(LINKED_PUBLISH_SETTLE_MS))) {
      throw new Error('The earlier conversation did not settle in time.');
    }
  }

  /** Whether every publish to GitHub under way settled within `timeoutMs`. */
  private async waitForLinkedPublishes(timeoutMs: number): Promise<boolean> {
    if (this.runningLinkedPublishes.size === 0) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.allSettled(this.runningLinkedPublishes).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return settled;
  }

  /**
   * A conversation a newer one took over is kept to read, and a deleted one's agent lives on for a while,
   * its turn too: nothing may change the project of either or publish it.
   */
  private async refuseIfClosed(): Promise<void> {
    const closed = await this.closedConversationMessage();
    if (closed) {
      throw new Response(closed, { status: 409 });
    }
  }

  /** Why this conversation may no longer change its project, or null while it may. */
  private async closedConversationMessage(): Promise<string | null> {
    const ownerId =
      this.ownerId ?? (await this.hydrateDurableIdentity({ required: true, reason: 'archive_check' }))?.ownerId;
    if (!ownerId) {
      return null;
    }
    const { archived, deleted } = await loadChatOrgProject(this.env.DB, { agentName: this.name, ownerId });
    if (deleted) {
      return DELETED_CONVERSATION_MESSAGE;
    }
    return archived ? ARCHIVED_CONVERSATION_MESSAGE : null;
  }

  /**
   * Asks the organization's admins to make this draft a real project: approved, it becomes a GitHub
   * repository that deploys through its own pipeline.
   */
  @callable()
  async requestProduction(input: { title: string; note: string }): Promise<{ outcome: ProductionRequestOutcome }> {
    const durableIdentity = await this.hydrateDurableIdentity({ required: true, reason: 'request_production' });
    const identity = runtimeIdentity(this.env);
    if (this.env.CLOUDCHEF_SHARED_ACCOUNT !== '1' || !identity || !durableIdentity) {
      throw new Error("Production requests are for drafts in a team's account.");
    }
    if (await this.workspace.linkedProject()) {
      throw new Error('This project is already on GitHub: ask the agent to publish it.');
    }
    const checkpoint = await this.workspace.checkpoint();
    const title = input.title.trim().slice(0, 80);
    if (!title) {
      throw new Error('Name the app for your admin.');
    }
    const { snapshot, files } = await packDraftSnapshot(this.workspace);
    // The chat is the draft: sent again from it, the request is replaced rather than repeated.
    const { outcome } = await requestProductionReview(this.env, identity, {
      draftId: durableIdentity.transcript.chatInitialId,
      draftRevision: checkpoint.revision,
      title,
      note: input.note.trim().slice(0, 1_000),
      previewUrl: this.state.deployment?.productionUrl ?? this.currentPreviewState().published?.url ?? null,
      snapshot,
      files,
    });
    return { outcome };
  }

  /** The organization GitHub project this workspace works on, or null for a CloudChef app. */
  @callable()
  getLinkedProject(): Promise<BuilderWorkspaceLinkedProject | null> {
    return this.workspace.linkedProject();
  }

  /** Tells the browser whether this is a GitHub project, so it never offers what only a CloudChef app has. */
  private async publishLinkedProjectState(): Promise<void> {
    const linked = await this.workspace.linkedProject();
    const archived =
      linked !== null &&
      this.userId !== null &&
      (await loadChatOrgProject(this.env.DB, { agentName: this.name, ownerId: this.userId })).archived;
    this.showLinkedProject(
      linked ? { repository: linked.repository, defaultBranch: linked.defaultBranch, archived } : null,
    );
  }

  private showLinkedProject(next: BuilderLinkedProjectSummary | null): void {
    const current = this.state.linkedProject ?? null;
    if (
      current?.repository === next?.repository &&
      current?.defaultBranch === next?.defaultBranch &&
      (current?.archived ?? false) === (next?.archived ?? false)
    ) {
      return;
    }
    this.setState({ ...this.state, linkedProject: next });
  }

  /** Names the repository to the browser as soon as its download starts, not minutes later when it's seeded. */
  private async *announceLinkedProject(lines: AsyncIterable<LinkedSnapshotLine>): AsyncGenerator<LinkedSnapshotLine> {
    for await (const line of lines) {
      if ('commit' in line) {
        this.showLinkedProject({ repository: line.repository, defaultBranch: line.defaultBranch });
      }
      yield line;
    }
  }

  @callable()
  getWorkspaceState(): Promise<BuilderWorkspaceState> {
    return this.workspace.refresh();
  }

  @callable()
  async prepareWorkspace(): Promise<BuilderWorkspaceState> {
    if (!this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const state = await this.initializeWorkspace(this.transcriptBinding);
    this.updatePreviewForWorkspace(state.revision);
    await this.publishLinkedProjectState();
    // Not awaited. The browser blocks its send gate on this call, and the point of warming is to
    // overlap the container's cold start with the user composing their first message — awaiting it
    // here would just move the wait rather than remove it. `warmContainer` never rejects.
    this.ctx.waitUntil(this.workspace.warmContainer());
    await this.refreshDeploymentReadiness();
    return state;
  }

  @callable()
  getWorkspaceSyncPage(request: WorkspaceSyncPageRequest): Promise<BuilderWorkspaceSyncPage> {
    return this.workspace.getSyncPage(request);
  }

  @callable()
  async applyWorkspaceClientChanges(request: WorkspaceApplyChangesRequest): Promise<BuilderWorkspaceApplyResult> {
    await this.refuseIfClosed();
    const result = await this.workspace.applyClientChanges(request);
    if (result.ok && result.changedPaths.length > 0) {
      this.setState({
        ...this.state,
        deployment: null,
      });
    }
    this.updatePreviewForWorkspace(result.state.revision);
    return result;
  }

  @callable()
  getPreviewState(): BuilderPreviewState {
    return this.currentPreviewState();
  }

  @callable()
  async deployValidatedRevision(): Promise<BuilderDeploymentState> {
    await this.hydrateDurableIdentity({ required: true, reason: 'deploy_validated_revision' });
    if (await this.workspace.linkedProject()) {
      throw new Error('This project deploys through GitHub: ask the agent to publish it.');
    }
    // The deployment builds the revision first when nothing has validated it yet.
    const snapshot = await this.workspace.checkpoint();
    const current = this.state.deployment;
    const retry = current?.revision === snapshot.revision && current.status === 'failed';
    if (retry) {
      const settled = await this.terminalizeDeployment(snapshot);
      if (settled.status === 'succeeded') {
        // It finished in the user's account after all: production already serves it.
        await this.recordDeploymentSucceeded(snapshot, settled);
        return this.state.deployment ?? { ...settled, ...snapshot };
      }
    }
    await this.scheduleDeployment(snapshot, { retry, run: { automatic: false, attempt: 0 } });
    return this.state.deployment ?? { status: 'deploying', ...snapshot };
  }

  @callable()
  requestPreview(): Promise<BuilderPreviewState> {
    return this.requestPreviewInternal({ autoDeploy: false });
  }

  @callable()
  async cancelPreview(): Promise<BuilderPreviewState> {
    const preview = this.currentPreviewState();
    if (!preview.pendingId || (preview.status !== 'queued' && preview.status !== 'building')) {
      return preview;
    }
    const next: BuilderPreviewState = {
      ...preview,
      status: 'cancelled',
      pendingId: null,
      error: null,
    };
    this.setPreviewState(next);
    await this.cancelFiberByKey(this.previewFiberKey(preview.pendingId), 'Cancelled by the project owner');
    return next;
  }

  @callable()
  async getTranscriptSnapshot(identityValue: TranscriptIdentity): Promise<BuilderTranscriptSnapshot> {
    const checkpoint = await this.getTranscriptCheckpoint(identityValue);
    return {
      checkpoint,
      messages: this.messages,
    };
  }

  /**
   * Internal Worker RPC used by the authenticated transcript reload endpoint.
   * Direct namespace RPCs do not carry Agent connection props, so initialize
   * the same owner-scoped context before reading the durable transcript.
   */
  async getTranscriptSnapshotForOwner(
    identityValue: TranscriptIdentity,
    ownerId: string,
  ): ReturnType<BuilderAgent['getTranscriptSnapshot']> {
    if (!transcriptOwnerIdSchema.safeParse(ownerId).success) {
      throw new Response('Invalid transcript owner', { status: 400 });
    }
    await this.initializeIdentity({ ownerId, userId: ownerId });
    return this.getTranscriptSnapshot(identityValue);
  }

  @callable()
  async getTranscriptCheckpoint(identityValue: TranscriptIdentity): Promise<TranscriptCheckpoint | null> {
    const identity = requireBuilderTranscriptIdentity(identityValue, this.transcriptBinding);
    if (this.messages.length > 0) {
      return this.advanceTranscriptCheckpoint(identity);
    }
    return this.state.transcript ?? null;
  }

  protected override sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    const sanitized = stripTranscriptBaseMetadata(message);
    if (sanitized === message) {
      // No transcript checkpoint rode along with this message, so there is nothing to reconcile.
      return boundBuilderMessageForPersistence(message);
    }
    const existing = this.messages.find((candidate) => candidate.id === message.id);
    if (existing && transcriptMessagesEqual(existing, message)) {
      return boundBuilderMessageForPersistence(sanitized);
    }
    const parsed = transcriptBaseMetadataSchema.safeParse(message.metadata);
    if (
      !parsed.success ||
      !transcriptCheckpointsEqual(this.state.transcript ?? null, parsed.data[TRANSCRIPT_BASE_METADATA_KEY])
    ) {
      throw new Error('This transcript changed in another session. Reload the latest messages before sending.');
    }
    return boundBuilderMessageForPersistence(sanitized);
  }

  private async initializeIdentity(props: BuilderAgentProps): Promise<void> {
    if (!transcriptOwnerIdSchema.safeParse(props.ownerId).success || props.userId !== props.ownerId) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const transcriptBinding = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: props.ownerId,
    });
    if (!transcriptBinding) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const identity: BuilderAgentDurableIdentity = {
      ownerId: props.ownerId,
      userId: props.userId,
      transcript: transcriptBinding,
    };
    try {
      this.identityRepository.claim(identity);
    } catch (error) {
      if (error instanceof BuilderAgentIdentityMismatchError) {
        this.rejectIdentity('connection_identity_mismatch');
      }
      throw error;
    }
    // Only the identity: `onStart` runs this inside the SDK's startup lock, which Cloudflare resets after 30
    // seconds, and a seed can take minutes. `prepareWorkspace` and a turn seed the workspace outside it.
    this.applyIdentity(identity);
  }

  private async hydrateDurableIdentity(args: {
    required: boolean;
    reason: string;
    incidentId?: string;
  }): Promise<BuilderAgentDurableIdentity | null> {
    const stored = this.identityRepository.get();
    if (!stored) {
      if (args.required) {
        this.rejectIdentity(`${args.reason}_missing`, args.incidentId, 401);
      }
      return null;
    }
    const activeTranscript = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: stored.ownerId,
    });
    if (
      !activeTranscript ||
      !builderAgentIdentitiesEqual(stored, {
        ownerId: stored.ownerId,
        userId: stored.userId,
        transcript: activeTranscript,
      })
    ) {
      // Throwing here for a non-required hydration makes `onStart` throw, and the SDK rethrows that
      // from every native RPC entry point — including `_cf_scheduleDestroy`. A soft-deleted chat has
      // no active transcript by definition, so the GC sweep could never condemn its Durable Object:
      // it retried forever, re-running the project deletion each round. Startup leaves the identity
      // unset instead; every operational entry point hydrates with `required: true`.
      if (args.required) {
        this.rejectIdentity(`${args.reason}_stale`, args.incidentId);
      }
      return null;
    }
    this.applyIdentity(stored);
    return stored;
  }

  private applyIdentity(identity: BuilderAgentDurableIdentity): void {
    if (
      (this.ownerId && this.ownerId !== identity.ownerId) ||
      (this.userId && this.userId !== identity.userId) ||
      (this.transcriptBinding &&
        !builderAgentIdentitiesEqual(
          {
            ownerId: this.ownerId ?? identity.ownerId,
            userId: this.userId ?? identity.userId,
            transcript: this.transcriptBinding,
          },
          identity,
        ))
    ) {
      this.rejectIdentity('memory_identity_mismatch');
    }
    this.ownerId = identity.ownerId;
    this.userId = identity.userId;
    this.transcriptBinding = identity.transcript;
  }

  private rejectIdentity(reason: string, incidentId: string = crypto.randomUUID(), status = 404): never {
    logger.error('Rejected BuilderAgent durable identity', {
      incidentId,
      reason,
    });
    throw new Response(status === 401 ? 'Agent authentication is required.' : 'Agent not found.', { status });
  }

  private async advanceTranscriptCheckpoint(identity: TranscriptIdentity): Promise<TranscriptCheckpoint> {
    const previous = this.state.transcript;
    const checkpoint = await advanceTranscriptCheckpoint(previous ?? null, identity, this.messages);
    if (checkpoint === previous) {
      return previous;
    }
    this.setState({ ...this.state, transcript: checkpoint });
    return checkpoint;
  }

  private async scheduleTitleGeneration(
    job: TitleGenerationJob,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
    gatewayLogging: WorkersAiGatewayLogging,
  ): Promise<void> {
    await this.startFiber(
      TITLE_GENERATION_FIBER,
      async (fiber) => {
        fiber.stash({ ...job, version: 1 });
        await this.generateTitlesForPrompt({ ...job, accountCredentials, gatewayLogging });
      },
      {
        idempotencyKey: `${TITLE_GENERATION_FIBER}:${job.subchatIndex}:${job.promptGeneration}`,
        metadata: job,
      },
    );
  }

  private async generateTitlesForPrompt(
    args: TitleGenerationJob & {
      accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>;
      gatewayLogging: WorkersAiGatewayLogging;
    },
  ): Promise<void> {
    const ownerId = this.ownerId;
    if (!ownerId) {
      return;
    }

    // Start model work before persistence so the background request leaves the
    // critical chat path as soon as the first prompt is accepted.
    // Naming the chat is model use too, counted toward an organization member's usage.
    const countUsage = (usage: Usage) => this.reportModelUsage(turnUsage(usage));
    const conversationTitlePromise = generateConversationTitle(
      args.prompt,
      args.accountCredentials,
      args.gatewayLogging,
      countUsage,
    );
    const projectTitlePromise =
      args.firstPrompt && args.subchatIndex === 0
        ? generateProjectTitle(args.prompt, args.accountCredentials, args.gatewayLogging, countUsage)
        : null;
    const provisionalTitle = args.firstPrompt ? deriveProvisionalTitle(args.prompt) : null;

    if (provisionalTitle) {
      try {
        const [savedHeuristicProject, savedHeuristicSubchat] = await Promise.all([
          args.subchatIndex === 0
            ? setHeuristicProjectDescriptionIfMissing(this.env.DB, {
                sessionId: ownerId,
                id: args.chatInitialId,
                description: provisionalTitle,
              })
            : Promise.resolve(false),
          setHeuristicSubchatDescriptionIfMissing(this.env.DB, {
            sessionId: ownerId,
            id: args.chatInitialId,
            subchatIndex: args.subchatIndex,
            description: provisionalTitle,
            promptGeneration: args.promptGeneration,
          }),
        ]);
        if (savedHeuristicSubchat) {
          const updatedAt = new Date().toISOString();
          this.setState({
            ...this.state,
            generatedSubchatTitle: { subchatIndex: args.subchatIndex, title: provisionalTitle, updatedAt },
          });
        }
        logger.info('Saved heuristic titles for first prompt', {
          savedHeuristicProject,
          savedHeuristicSubchat,
        });
      } catch {
        logger.warn('Heuristic title save failed; continuing generated title work');
      }
    }

    const [conversationResult, projectResult] = await Promise.allSettled([
      conversationTitlePromise,
      projectTitlePromise ?? Promise.resolve(null),
    ]);

    if (conversationResult.status === 'fulfilled' && conversationResult.value) {
      try {
        const savedSubchatTitle = await setGeneratedSubchatDescription(this.env.DB, {
          sessionId: ownerId,
          id: args.chatInitialId,
          subchatIndex: args.subchatIndex,
          description: conversationResult.value,
          promptGeneration: args.promptGeneration,
        });
        if (savedSubchatTitle) {
          const updatedAt = new Date().toISOString();
          this.setState({
            ...this.state,
            generatedSubchatTitle: { subchatIndex: args.subchatIndex, title: conversationResult.value, updatedAt },
          });
        }
      } catch {
        logger.warn('Generated conversation title could not be saved');
      }
    } else if (conversationResult.status === 'rejected') {
      logger.warn('Conversation title generation failed; keeping the current title');
    }

    if (projectResult.status === 'fulfilled' && projectResult.value) {
      try {
        await setGeneratedProjectDescription(this.env.DB, {
          sessionId: ownerId,
          id: args.chatInitialId,
          description: projectResult.value,
        });
      } catch {
        logger.warn('Generated project title could not be saved');
      }
    } else if (projectResult.status === 'rejected') {
      logger.warn('Project title generation failed; keeping the first-prompt title');
    }
  }

  /**
   * The workspace, seeded first when it is new. One seed at a time: callers arriving while it runs wait for
   * it, rather than finding it `seeding` and going on with a workspace that holds only part of the project.
   */
  private async initializeWorkspace(binding: BuilderTranscriptBinding): Promise<BuilderWorkspaceState> {
    const current = await this.workspace.refresh();
    if (current.initialized) {
      return current;
    }
    // Seeding writes the whole project into the workspace: a redeploy partway would leave it half seeded.
    this.workspaceSeed ??= this.runtimeActivity
      .run(() => this.seedNewWorkspace(binding))
      .finally(() => {
        this.workspaceSeed = null;
      });
    return this.workspaceSeed;
  }

  private async seedNewWorkspace(binding: BuilderTranscriptBinding): Promise<BuilderWorkspaceState> {
    if (binding.parentAgentName) {
      // A subchat of a GitHub project keeps working on it, relative to the same commit: linked before its
      // seed commits, so it never exists as an ordinary draft holding the repository's code. The parent can
      // go on working too, so the subchat gets its own branch.
      const parent = await this.loadLinkedWorkspaceCopy(binding.parentAgentName);
      return seedBuilderWorkspace(
        this.workspace,
        parentBuilderWorkspaceSeedId(parent.targetRevision),
        parent.entries,
        async () => {
          if (parent.linked) {
            await this.workspace.setLinkedProject({ ...parent.linked, branchKey: newLinkedBranchKey() });
          }
        },
      );
    }
    const { orgProjectId, continuesAgentName } = this.userId
      ? await loadChatOrgProject(this.env.DB, { agentName: binding.agentName, ownerId: this.userId })
      : { orgProjectId: null, continuesAgentName: null };
    if (orgProjectId && continuesAgentName) {
      // A new conversation on the project starts from the last one's workspace, relative to the same
      // commit, so what it hadn't published yet carries over. One that never opened the project has none.
      // The last one stops first, so the copy is final; it is archived, so this one takes over its branch.
      const previousAgent: Pick<BuilderAgent, 'getLinkedProject' | 'getWorkspaceState' | 'settleForSuccessor'> =
        this.env.BuilderAgent.getByName(continuesAgentName);
      await previousAgent.settleForSuccessor(this.userId ?? '');
      const linked = (await previousAgent.getWorkspaceState()).initialized
        ? await previousAgent.getLinkedProject()
        : null;
      if (linked?.orgProjectId === orgProjectId) {
        const previous = await this.loadLinkedWorkspaceCopy(continuesAgentName);
        const continued = previous.linked?.orgProjectId === orgProjectId ? previous.linked : linked;
        return seedBuilderWorkspace(
          this.workspace,
          parentBuilderWorkspaceSeedId(previous.targetRevision),
          previous.entries,
          () =>
            this.workspace.setLinkedProject({ ...continued, branchKey: continued.branchKey ?? newLinkedBranchKey() }),
        );
      }
    }
    if (orgProjectId) {
      const identity = runtimeIdentity(this.env);
      if (!identity) {
        throw new Error('This workspace is not connected to CloudChef, so it cannot open the project.');
      }
      return seedLinkedWorkspace(
        this.workspace,
        orgProjectId,
        this.announceLinkedProject(streamLinkedProjectSnapshot(this.env, identity, orgProjectId)),
      );
    }
    const template = await loadBuilderTemplate();
    return this.seedWorkspace(builderTemplateSeedId(), template);
  }

  /** The publish tools for a workspace opened from an organization's GitHub project; none otherwise. */
  private async createLinkedProjectToolContext(): Promise<LinkedProjectModelToolContext | undefined> {
    const linked = await this.workspace.linkedProject();
    if (!linked) {
      return undefined;
    }
    return {
      repository: linked.repository,
      defaultBranch: linked.defaultBranch,
      publish: (input, options) =>
        this.trackLinkedPublish(this.keepAliveWhile(() => this.publishLinkedProject(input, options))),
      fetchSite: (input, options) => this.fetchLinkedSite(input, options),
    };
  }

  private async trackLinkedPublish(publish: Promise<CloudChefToolResult>): Promise<CloudChefToolResult> {
    this.runningLinkedPublishes.add(publish);
    try {
      return await publish;
    } finally {
      this.runningLinkedPublishes.delete(publish);
    }
  }

  /**
   * Sends the workspace to GitHub: a commit on the member's branch, merged into the default
   * branch when it should go live. It returns once the commit is there; the repository's pipeline is
   * watched in the background, and its result and preview link replace this output when it reports.
   */
  private async publishLinkedProject(
    input: { message: string; live: boolean },
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<CloudChefToolResult> {
    const linked = await this.workspace.linkedProject();
    const identity = runtimeIdentity(this.env);
    if (!linked || !identity) {
      return toolFailure("This workspace is not one of the team's GitHub projects.");
    }
    const closed = await this.closedConversationMessage();
    if (closed) {
      return toolFailure(`${closed} Nothing was sent to GitHub.`);
    }
    const { changes, manifest } = await linkedWorkspaceChanges(this.workspace, linked);
    if (changes.length === 0) {
      return toolFailure(`Nothing has changed since this workspace was opened from ${linked.repository}.`);
    }
    // The last moment a Stop or the tool's deadline can call it off. Once GitHub has the commit (and the
    // merge), there's no taking it back: everything below runs to the end, and its result is the real one
    // even if the turn ended meanwhile; the build watch then puts it in place of the stopped call's error.
    options.abortSignal?.throwIfAborted();
    const result = await commitLinkedProject(this.env, identity, {
      orgProjectId: linked.orgProjectId,
      branchKey: linked.branchKey,
      baseCommit: linked.baseCommit,
      message: input.message,
      publish: input.live,
      changes,
    });
    if (result.code === 'merge_conflict') {
      return toolFailure(
        `${result.error ?? 'The changes overlap with newer work.'} Nothing went live. The work is saved on the ` +
          `branch ${result.branch} of ${linked.repository}; an admin can merge it there.`,
        { branch: result.branch, commit: result.commit, conflict: true, defaultBranch: linked.defaultBranch },
      );
    }
    if (input.live && result.published) {
      // The commit that went live becomes the base: its tree is exactly this workspace, so later changes
      // are measured from it, and merging them keeps whatever else the default branch gained meanwhile.
      await this.workspace.setLinkedProject({ ...linked, baseCommit: result.commit, baseManifest: manifest });
    }
    const watch: LinkedBuildWatch = {
      toolCallId: options.toolCallId,
      orgProjectId: linked.orgProjectId,
      sha: input.live ? (result.published ?? result.commit) : result.commit,
      branch: result.branch,
      where: input.live ? `merged into ${linked.defaultBranch}` : `on the branch ${result.branch}`,
      live: input.live,
      startedAt: Date.now(),
      defaultBranch: linked.defaultBranch,
    };
    try {
      await this.startFiber(
        LINKED_BUILD_FIBER,
        async (fiber) => {
          fiber.stash(watch);
          await this.runtimeActivity.run(() =>
            this.keepAliveWhile(() => this.runLinkedBuildWatch(watch, fiber.signal)),
          );
        },
        { idempotencyKey: `${LINKED_BUILD_FIBER}:${this.name}:${watch.toolCallId}`, metadata: watch },
      );
    } catch {
      logger.warn('Unable to start watching the linked project build');
      return linkedBuildUnfollowedResult(watch);
    }
    return linkedBuildStartedResult(watch);
  }

  /**
   * Follows the pipeline's build of a publish's commit, then puts its result in place of that publish's
   * output. The output is saved with its turn's message when the turn ends, so the result waits for that.
   */
  private async runLinkedBuildWatch(watch: LinkedBuildWatch, signal?: AbortSignal): Promise<void> {
    const identity = runtimeIdentity(this.env);
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const build = identity
      ? await watchLinkedBuild({
          poll: async () => {
            // A call stopped after its commit shows as failed until its result lands: while the pipeline
            // builds, it at least says what is on GitHub.
            await this.landLinkedBuildOutput(watch, linkedBuildStartedResult(watch), { onlyFailed: true });
            return linkedBuildStatus(this.env, identity, watch.orgProjectId, watch.sha);
          },
          sleep,
          now: Date.now,
          deadline: watch.startedAt + LINKED_BUILD_WATCH_MS,
          workersBuildsGraceUntil: watch.startedAt + WORKERS_BUILDS_APPEAR_MS,
          signal,
        })
      : null;
    if (signal?.aborted) {
      // Stopped with the agent: recovery runs the watch again.
      return;
    }
    const output = build ? linkedBuildSettledResult(watch, build) : linkedBuildUnfollowedResult(watch);
    console.info({
      event: 'linked_build_settled',
      build: output.data?.build ?? 'none',
      buildMs: Date.now() - watch.startedAt,
    });
    const landingDeadline = watch.startedAt + LINKED_BUILD_WATCH_MS + BUILDER_TURN_WALL_CLOCK_MS;
    let missingSince: number | null = null;
    while (!signal?.aborted && Date.now() < landingDeadline) {
      if (!this.state.activeTurn) {
        if (await this.landLinkedBuildOutput(watch, output)) {
          return;
        }
        missingSince ??= Date.now();
        if (Date.now() - missingSince > LINKED_BUILD_MISSING_GRACE_MS) {
          return;
        }
      } else {
        missingSince = null;
      }
      await sleep(LINKED_BUILD_LANDING_POLL_MS);
    }
  }

  /** Puts `output` in place of a watched publish's output once no turn is running; whether it landed. */
  private async landLinkedBuildOutput(
    watch: LinkedBuildWatch,
    output: CloudChefToolResult,
    options: { onlyFailed?: boolean } = {},
  ): Promise<boolean> {
    if (this.state.activeTurn) {
      return false;
    }
    const messages = withLinkedBuildResult(this.messages, watch.toolCallId, output, options);
    if (!messages) {
      return false;
    }
    // SAFETY: these are the agent's existing AI SDK messages with only one terminal tool part of a publish
    // changed: its JSON-serializable output replaced, or a stopped call's error replaced by its real output.
    await this.persistMessages(messages as UIMessage[]);
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    return true;
  }

  /** Reads a page of the project's own live site: only addresses GitHub reports for this repository. */
  private async fetchLinkedSite(
    input: LinkedSiteFetchInput,
    options: { abortSignal?: AbortSignal },
  ): Promise<CloudChefToolResult> {
    const linked = await this.workspace.linkedProject();
    const identity = runtimeIdentity(this.env);
    if (!linked || !identity) {
      return toolFailure("This workspace is not one of the team's GitHub projects.");
    }
    return fetchLinkedSitePage(input, {
      origins: () => linkedSiteOrigins(this.env, identity, linked.orgProjectId, linked.branchKey),
      fetch: (request, init) => fetch(request, init),
      signal: options.abortSignal,
    });
  }

  /** Whether this person is now an active admin of the organization whose account this runtime uses. */
  private async isOrganizationAdmin(): Promise<boolean> {
    const identity = runtimeIdentity(this.env);
    return identity ? (await confirmUserWorkspaceAccess(this.env, identity))?.organizationAdmin === true : false;
  }

  /**
   * Each turn first asks the control plane about this person. In an organization's account, whether
   * they may still build: the model runs on the organization's Workers AI, and a paused or removed
   * member must stop at their next turn even in a workspace they already have open. Anywhere, whether
   * they let its model requests be logged with their content in the account's AI Gateway (when that
   * can't be learned, they aren't).
   */
  private async requireModelAccess(): Promise<{ contentLogging: boolean }> {
    const access = await modelRequestAccess(this.env);
    if (!access.allowed) {
      throw new Response("You no longer have access to this team's account.", { status: 403 });
    }
    return { contentLogging: access.contentLogging };
  }

  /** Each finished turn's token counts go to the control plane, which keeps them for organization admins. */
  private reportModelUsage(usage: ModelTurnUsage): void {
    const identity = runtimeIdentity(this.env);
    if (!identity) {
      return;
    }
    this.ctx.waitUntil(
      reportUserWorkspaceModelUsage(this.env, identity, usage).catch(() => {
        console.warn('Unable to report model usage to the control plane');
      }),
    );
  }

  private async createCloudflareApiToolContext(
    transcript: BuilderTranscriptBinding,
  ): Promise<CloudflareApiModelToolContext | undefined> {
    const admission = await readCloudflareApiRuntimeAdmission(this.env, () => this.isOrganizationAdmin());
    if (
      !admission?.controls.cloudflare_api ||
      !this.userId ||
      admission.identity.userId !== this.userId ||
      !this.transcriptBinding ||
      !builderTranscriptBindingsEqual(this.transcriptBinding, transcript)
    ) {
      return undefined;
    }
    const expectedIdentity = admission.identity;
    return {
      writeEnabled: cloudflareApiWriteEnabled(admission.controls),
      request: (input, options) => this.handleCloudflareRequest(input, options, expectedIdentity, transcript),
    };
  }

  private async waitForCloudflareDecisionBoundary(): Promise<void> {
    const stable = await this.waitUntilStable({ timeout: 30_000, pendingInteraction: () => false });
    if (!stable) {
      throw new Response('The builder turn has not finished storing this proposal.', { status: 409 });
    }
  }

  /** Reads are sent now. Every other method becomes a durable proposal that pauses the turn for approval. */
  private async handleCloudflareRequest(
    input: CloudflareApiRequestInput,
    options: ModelToolExecutionOptions,
    expectedIdentity: CloudflareApiRuntimeIdentity,
    transcript: BuilderTranscriptBinding,
  ): Promise<CloudflareRequestImmediateResult | CloudflareRequestProposal> {
    options.abortSignal?.throwIfAborted();
    let request: CloudflareApiRequest;
    try {
      request = normalizeCloudflareApiRequest(input, expectedIdentity.accountId);
    } catch (error) {
      if (!(error instanceof CloudflareApiRequestRejectedError)) {
        throw error;
      }
      return cloudflareRequestFailure(expectedIdentity.accountId, error.message);
    }
    const write = !cloudflareApiRequestIsRead(request);
    const admitted = admitCloudflareApiRequest(
      await readCloudflareApiRuntimeAdmission(this.env, () => this.isOrganizationAdmin()),
      expectedIdentity,
      write,
    );
    if ('rejection' in admitted) {
      return cloudflareRequestFailure(expectedIdentity.accountId, admitted.rejection);
    }
    const { admission } = admitted;
    if (!write) {
      const signal = options.abortSignal ?? new AbortController().signal;
      let outcome: CloudflareApiOutcome;
      try {
        outcome = await this.createCloudflareApiClient(admission.identity).send(request, signal);
      } catch {
        // A failed tool result lets the model report or retry instead of ending the turn.
        signal.throwIfAborted();
        return cloudflareRequestFailure(admission.identity.accountId, 'The Cloudflare credential is unavailable.');
      }
      return {
        kind: 'cloudflare_request_result',
        // Only a change can be left half-applied; an unobserved read is simply a failure to retry.
        status: outcome.status === 'indeterminate' ? 'failure' : outcome.status,
        accountId: admission.identity.accountId,
        content: outcome.content,
        requestId: outcome.requestId,
        httpStatus: outcome.httpStatus,
        truncated: outcome.truncated,
      };
    }
    if (!this.transcriptBinding || !builderTranscriptBindingsEqual(this.transcriptBinding, transcript)) {
      throw new Error('The transcript changed before the Cloudflare request proposal was stored.');
    }
    const record = await this.cloudflareExecutions.createProposal({
      toolCallId: options.toolCallId,
      binding: { ...admission.identity, transcript },
      request,
    });
    this.refreshCloudflareExecutionState();
    return {
      kind: 'cloudflare_request_proposal',
      status: 'awaiting_approval',
      executionId: record.executionId,
      toolCallId: record.toolCallId,
      accountId: record.accountId,
      request: record.request,
      proposalSha256: record.proposalSha256,
      riskNote: CLOUDFLARE_EXECUTION_RISK_NOTE,
      expiresAt: record.expiresAt,
    };
  }

  /** The approval fiber re-admits the stored change; a rejection there settles it as failed. */
  private async requireCloudflareApiWriteAdmission(expectedIdentity: CloudflareApiRuntimeIdentity): Promise<void> {
    const admitted = admitCloudflareApiRequest(
      await readCloudflareApiRuntimeAdmission(this.env, () => this.isOrganizationAdmin()),
      expectedIdentity,
      true,
    );
    if ('rejection' in admitted) {
      throw new Error(admitted.rejection);
    }
  }

  private createCloudflareApiClient(identity: CloudflareApiRuntimeIdentity): CloudflareApiClient {
    return new CloudflareApiClient({
      resolveAccessToken: (options) => resolveUserWorkspaceCloudflareAccessToken(this.env, identity, options),
    });
  }

  private async requireCurrentCloudflareExecutionBinding(reason: string): Promise<CloudflareExecutionBinding> {
    const durableIdentity = await this.hydrateDurableIdentity({ required: true, reason });
    const transcript = this.transcriptBinding;
    const admission = await readCloudflareApiRuntimeAdmission(this.env, () => this.isOrganizationAdmin());
    if (!durableIdentity || !transcript || !admission || admission.identity.userId !== durableIdentity.userId) {
      throw new Response('The Cloudflare execution identity is unavailable.', { status: 409 });
    }
    return { ...admission.identity, transcript };
  }

  private async runApprovedCloudflareExecution(
    job: CloudflareExecutionFiberJob,
    binding: CloudflareExecutionBinding,
  ): Promise<void> {
    try {
      const { record } = await this.cloudflareExecutions.approve(job.executionId, binding);
      if (record.proposalSha256 !== job.proposalSha256) {
        throw new Error('The approved Cloudflare execution digest changed.');
      }
      this.refreshCloudflareExecutionState();
      await this.requireCloudflareApiWriteAdmission(binding);
      const executing = await this.cloudflareExecutions.beginExecution(job.executionId, binding);
      if (!executing) {
        const settled = this.cloudflareExecutions.get(job.executionId);
        if (settled && isCloudflareExecutionTerminal(settled.status)) {
          await this.persistCloudflareExecutionResult(settled);
        }
        return;
      }
      this.refreshCloudflareExecutionState();
      const outcome = await this.createCloudflareApiClient(binding).send(
        executing.request,
        new AbortController().signal,
      );
      const safeOutcome = safeCloudflareExecutionOutcome(outcome);
      const status = cloudflareExecutionStatusForOutcome(outcome);
      const completed = this.cloudflareExecutions.complete(job.executionId, status, safeOutcome);
      this.refreshCloudflareExecutionState();
      await this.persistCloudflareExecutionResult(completed);
    } catch {
      const current = this.cloudflareExecutions.get(job.executionId);
      if (!current || isCloudflareExecutionTerminal(current.status)) {
        if (current) {
          await this.persistCloudflareExecutionResult(current);
        }
        return;
      }
      const failure: CloudflareExecutionSafeOutcome = {
        status: 'failure',
        summary: 'The approved Cloudflare execution could not be started safely.',
      };
      const failed =
        current.status === 'approved'
          ? this.cloudflareExecutions.failApproved(job.executionId, failure)
          : current.status === 'executing'
            ? this.cloudflareExecutions.complete(job.executionId, 'failed', failure)
            : this.cloudflareExecutions.recoverIndeterminate(job.executionId, job.proposalSha256);
      // The raw error text stays out of the log by policy (runtime-log-privacy); the durable
      // outcome record carries what happened, keyed by executionId.
      logger.warn('Cloudflare execution fiber settled without a provider success', {
        executionId: job.executionId,
      });
      this.refreshCloudflareExecutionState();
      await this.persistCloudflareExecutionResult(failed);
    }
  }

  private async persistCloudflareExecutionResult(record: CloudflareExecutionRecord): Promise<void> {
    if (!isCloudflareExecutionTerminal(record.status) || !record.outcome) {
      return;
    }
    const output: CloudflareRequestFinalResult = {
      kind: 'cloudflare_request_final_result',
      executionId: record.executionId,
      accountId: record.accountId,
      proposalSha256: record.proposalSha256,
      status: record.status,
      outcome: record.outcome,
    };
    let replaced = false;
    const messages: CloudChefMessage[] = this.messages.map((message) => ({
      ...message,
      parts: message.parts.map((part) => {
        const invocation = getToolInvocation(part);
        if (
          invocation?.toolName !== 'cloudflare_request' ||
          invocation.toolCallId !== record.toolCallId ||
          invocation.state !== 'output-available'
        ) {
          return part;
        }
        replaced = true;
        return { ...part, output };
      }),
    }));
    if (!replaced) {
      return;
    }
    // SAFETY: these are the agent's existing AI SDK messages with only one already-terminal tool
    // output replaced by another JSON-serializable output; no part discriminant or state changes.
    await this.persistMessages(messages as UIMessage[]);
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
  }

  private refreshCloudflareExecutionState(): void {
    this.cloudflareExecutions.expireAwaiting();
    const cloudflareExecutions = this.cloudflareExecutions.listRecent();
    this.setState({ ...this.state, cloudflareExecutions });
  }

  /**
   * Another workspace's files with the GitHub project it is linked to, read so they belong together: the
   * link (and its base commit) is the same before and after the files are copied, or the copy starts over.
   */
  private async loadLinkedWorkspaceCopy(agentName: string): Promise<{
    entries: BuilderWorkspaceFileInput[];
    targetRevision: number;
    linked: BuilderWorkspaceLinkedProject | null;
  }> {
    const agent: Pick<BuilderAgent, 'getLinkedProject'> = this.env.BuilderAgent.getByName(agentName);
    for (let attempt = 0; attempt <= MAX_WORKSPACE_COPY_RESTARTS; attempt += 1) {
      const before = await agent.getLinkedProject();
      const copy = await this.loadParentWorkspace(agentName);
      const after = await agent.getLinkedProject();
      if (before?.orgProjectId === after?.orgProjectId && before?.baseCommit === after?.baseCommit) {
        return { ...copy, linked: after };
      }
    }
    throw new Error('The workspace kept changing while it was being copied. Open the conversation again.');
  }

  private async loadParentWorkspace(
    parentAgentName: string,
  ): Promise<{ entries: BuilderWorkspaceFileInput[]; targetRevision: number }> {
    const parent: Pick<BuilderAgent, 'getWorkspaceState' | 'getWorkspaceSyncPage'> =
      this.env.BuilderAgent.getByName(parentAgentName);
    const parentState = await parent.getWorkspaceState();
    if (!parentState.initialized) {
      throw new Error('The parent durable project workspace is not initialized.');
    }
    const entries: BuilderWorkspaceFileInput[] = [];
    let cursor: string | undefined;
    let restarts = 0;
    while (true) {
      const request: WorkspaceSyncPageRequest = { fromRevision: 0 };
      if (cursor) {
        request.cursor = cursor;
      }
      const page = await parent.getWorkspaceSyncPage(request);
      if (page.restart) {
        restarts += 1;
        if (restarts > MAX_WORKSPACE_COPY_RESTARTS) {
          throw new Error('The workspace kept changing while it was being copied. Open the conversation again.');
        }
        entries.length = 0;
        cursor = undefined;
        continue;
      }
      for (const entry of page.entries) {
        if (entry.kind === 'write') {
          const input: BuilderWorkspaceFileInput = {
            path: entry.path,
            content: entry.content,
            encoding: entry.encoding,
          };
          if (entry.mode !== undefined) {
            input.mode = entry.mode;
          }
          entries.push(input);
        }
      }
      if (!page.nextCursor) {
        return { entries, targetRevision: page.targetRevision };
      }
      cursor = page.nextCursor;
    }
  }

  private async seedWorkspace(seedId: string, entries: BuilderWorkspaceFileInput[]): Promise<BuilderWorkspaceState> {
    return seedBuilderWorkspace(this.workspace, seedId, entries);
  }

  private async terminalizeDeployment(job: DeploymentJob): Promise<BuilderDeploymentState> {
    const userId = this.userId;
    const transcriptBinding = this.transcriptBinding;
    if (!userId || !transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    return this.publisher.terminalize({
      context: {
        env: this.env,
        userId,
        chatInitialId: transcriptBinding.chatInitialId,
      },
      workspace: this.workspace,
      toolCallId: deploymentToolCallId(job.workspaceRevision, job.revision),
      validatedRevision: job.revision,
    });
  }

  /**
   * Publish the current revision of a CloudChef app unless production already serves it. Never while
   * a turn runs: its end publishes, and a publication would hold the workspace the turn edits.
   */
  private async publishLatestRevision(
    validated: BuilderWorkspaceCheckpoint | null,
    options: { resume?: boolean; epoch?: number } = {},
  ): Promise<void> {
    const epoch = options.epoch ?? this.publicationEpoch;
    if (this.automaticPublicationStopped(epoch)) {
      return;
    }
    if (await this.workspace.linkedProject().catch(() => null)) {
      // A GitHub project publishes through its own pipeline: nothing here is waiting for production.
      if (this.state.publicationPending) {
        this.setState({ ...this.state, publicationPending: false });
      }
      return;
    }
    const snapshot = validated ?? (await this.workspace.checkpoint().catch(() => null));
    if (!snapshot || this.automaticPublicationStopped(epoch)) {
      return;
    }
    if (this.productionServes(snapshot.revision)) {
      // Recorded as a deployment records it: the next change clears a legacy deployment record that
      // may be the only evidence, and a return to this revision would then redeploy it.
      if (this.state.publicationPending || this.state.productionRevision !== snapshot.revision) {
        this.setState({ ...this.state, productionRevision: snapshot.revision, publicationPending: false });
      }
      return;
    }
    const failedBefore = this.state.failedPublicationRevision === snapshot.revision;
    if (options.resume && failedBefore) {
      // It failed to publish already and nothing has changed it since: the next turn's end tries again.
      return;
    }
    if (!this.state.publicationPending || failedBefore) {
      this.setState({ ...this.state, publicationPending: true, failedPublicationRevision: null });
    }
    await this.publishRevision(snapshot, epoch);
  }

  /**
   * Whether automatic publication work noted at `epoch` must not start: the project is being deleted, a
   * turn is running or starting (its end publishes), or a new turn stopped the automatic publications.
   */
  private automaticPublicationStopped(epoch: number): boolean {
    return (
      this.destroying || Boolean(this.state.activeTurn) || this.startingTurns > 0 || epoch !== this.publicationEpoch
    );
  }

  /** The automatic publication of `revision` failed: waking the agent does not try it again. */
  private recordFailedPublication(revision: string): void {
    if (this.state.failedPublicationRevision !== revision) {
      this.setState({ ...this.state, failedPublicationRevision: revision });
    }
  }

  /**
   * A restarted agent finishes what a turn asked for: a publication interrupted before it reached
   * production, or one whose fiber never started, runs again. One still running or awaiting its
   * recovery hook finishes on its own.
   */
  private async resumeUnfinishedPublication(): Promise<void> {
    // Noted before anything is awaited: a chat request that woke this instance stops it at once.
    const epoch = this.publicationEpoch;
    if (!this.state.publicationPending || this.automaticPublicationStopped(epoch)) {
      return;
    }
    const live = await this.listFibers({
      status: ['pending', 'running', 'interrupted'],
    });
    if (
      this.automaticPublicationStopped(epoch) ||
      live.some((fiber) => fiber.name === PREVIEW_PUBLICATION_FIBER || fiber.name === DEPLOYMENT_FIBER)
    ) {
      return;
    }
    const preview = this.currentPreviewState();
    if (preview.pendingId && (preview.status === 'queued' || preview.status === 'building')) {
      // Its fiber is gone: nothing will ever settle it, and it would hold back its replacement.
      this.setPreviewState({ ...preview, status: 'cancelled', pendingId: null, error: null });
    }
    await this.refreshDeploymentReadiness();
    await this.publishLatestRevision(null, { resume: true, epoch });
  }

  /**
   * A turn ended without its end-of-turn hook publishing (a Stop, or a failure before it streamed): the
   * publication it stopped when it began, or one still waiting for production, runs again now.
   */
  private publishAfterInterruptedTurn(): void {
    const epoch = this.publicationEpoch;
    if (!this.state.publicationPending || !this.userId || this.automaticPublicationStopped(epoch)) {
      return;
    }
    this.ctx.waitUntil(
      (async () => {
        await this.refreshDeploymentReadiness();
        await this.publishLatestRevision(null, { epoch });
      })().catch(() => logger.warn('Unable to publish after the interrupted turn')),
    );
  }

  /** Stop the automatic publications this instance is running, and give them a moment to let go of the workspace. */
  private async stopAutomaticPublications(): Promise<void> {
    this.publicationEpoch += 1;
    await this.cancelPreview();
    const stopping = [...this.runningPublications].filter((publication) => publication.automatic);
    if (stopping.length === 0) {
      return;
    }
    for (const publication of stopping) {
      publication.controller.abort(new PublicationSupersededError());
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(stopping.map((publication) => publication.settled)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PUBLICATION_STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /**
   * Run one publication where a new turn can stop it: its signal also aborts when the turn's stop does.
   * It is registered before `run` starts, so a stop while it still waits to be admitted reaches it, and
   * one already stopped (a new turn since `epoch`, or the project's deletion) starts aborted.
   */
  private async trackPublication(
    automatic: boolean,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<void>,
    epoch?: number,
  ): Promise<void> {
    const controller = new AbortController();
    let settle: () => void = () => undefined;
    const publication: RunningPublication = {
      automatic,
      controller,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    this.runningPublications.add(publication);
    if (this.destroying) {
      controller.abort(new Error('Project deletion'));
    } else if (automatic && epoch !== undefined && this.automaticPublicationStopped(epoch)) {
      controller.abort(new PublicationSupersededError());
    }
    try {
      await run(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    } finally {
      this.runningPublications.delete(publication);
      settle();
    }
  }

  /**
   * The user-visible critical path after a turn changed the app: publish the hosted preview first, then run
   * the production deployment behind it. The preview fiber schedules the deployment when it
   * settles; when no publication is pending (the preview is already serving this revision, or it
   * could not even be queued), the deployment starts directly instead of waiting on anything.
   */
  private async publishRevision(snapshot: BuilderWorkspaceCheckpoint, epoch: number): Promise<void> {
    const preview = await this.requestPreviewInternal({ snapshot, autoDeploy: true, epoch }).catch(() => {
      logger.warn('Unable to queue the preview publication');
      return null;
    });
    if (!preview?.pendingId) {
      await this.scheduleAutomaticDeployment(snapshot, 0, epoch);
    }
  }

  /** Deployment follows a settled preview publication, never blocking it — and never skipping it. */
  private async scheduleDeploymentAfterPreview(job: PreviewPublicationJob, epoch?: number): Promise<void> {
    const checkpoint = deploymentJobSchema.safeParse({
      workspaceRevision: job.workspaceRevision,
      revision: job.snapshotRevision,
    }).data;
    if (!checkpoint) {
      return;
    }
    const validated = await this.workspace.hasSuccessfulValidation(checkpoint.revision).catch(() => false);
    if (!validated) {
      return;
    }
    await this.scheduleAutomaticDeployment(checkpoint, 0, epoch);
  }

  /**
   * Production follows the turn that asked for it, unless a newer turn is running or production already
   * serves it. A failed deployment of the same revision is redone, once its record in the user's
   * account is settled.
   */
  private async scheduleAutomaticDeployment(
    job: DeploymentJob,
    attempt = 0,
    epoch = this.publicationEpoch,
  ): Promise<void> {
    if (this.automaticPublicationStopped(epoch)) {
      return;
    }
    if (this.productionServes(job.revision)) {
      // Nothing will deploy it again, so nothing else would record the publication done.
      await this.recordProductionRevision(job.revision);
      return;
    }
    let retry = attempt > 0;
    const run: DeploymentRun = { automatic: true, attempt };
    const current = this.state.deployment;
    if (current?.revision === job.revision && current.status === 'failed') {
      // Counted busy, and retried, as an interrupted deployment's recovery settles its record.
      const settled = await this.runtimeActivity
        .run(() => this.retry(() => this.terminalizeDeployment(job)))
        .catch(() => {
          logger.warn('Unable to terminalize the failed deployment');
          return null;
        });
      if (this.automaticPublicationStopped(epoch)) {
        return;
      }
      if (!settled || settled.status === 'deploying') {
        // Its record is not settled yet (or could not be read): it is asked again later, as a deployment
        // that failed for a reason that passes, and a wake leaves it for that retry or the next turn.
        this.recordFailedPublication(job.revision);
        await this.scheduleAutomaticDeploymentRetry(job, run, {
          message: 'Interrupted deployment recovery is pending.',
          retryable: true,
        });
        return;
      }
      if (settled.status === 'succeeded') {
        await this.recordDeploymentSucceeded(job, settled);
        return;
      }
      // Something else started deploying this revision, or settled it, while the record was read.
      const now = this.state.deployment;
      if (now?.revision === job.revision && now.status !== 'failed') {
        return;
      }
      retry = true;
    }
    await this.scheduleDeployment(job, { retry, run, epoch }).catch(() =>
      logger.warn('Unable to queue the automatic deployment'),
    );
  }

  /**
   * Start the deployment fiber for `job`. An automatic one (`epoch` set) gives up, without a word, when a
   * new turn stopped the automatic publications meanwhile; any refuses once the project is being deleted.
   */
  private async scheduleDeployment(
    job: DeploymentJob,
    options: { retry?: boolean; run: DeploymentRun; epoch?: number },
  ): Promise<void> {
    const { run, epoch } = options;
    const inFlight = () => {
      const current = this.state.deployment;
      return !options.retry && current?.revision === job.revision && current.status !== 'ready';
    };
    const refused = () => {
      if (this.destroying) {
        throw new Response('This project is being deleted.', { status: 409 });
      }
      return inFlight() || (epoch !== undefined && this.automaticPublicationStopped(epoch));
    };
    if (refused()) {
      return;
    }
    await this.runtimeActivity.admit();
    // Admission can wait out an upgrade: whatever changed meanwhile decides again.
    if (refused()) {
      return;
    }
    this.setState({
      ...this.state,
      deployment: { status: 'deploying', ...job },
    });
    try {
      // No per-revision fiber key: it would hand back a settled fiber without running it.
      await this.startFiber(
        DEPLOYMENT_FIBER,
        async (fiber) => {
          fiber.stash(job);
          await this.trackPublication(
            run.automatic,
            fiber.signal,
            async (signal) => {
              try {
                // Counted busy while it runs, whatever later rewrites the deployment record. A stop while
                // it still waits for an upgrade window calls it off before it starts.
                // A deployment that fails throws: the executor never returns a failed one.
                await this.runtimeActivity.run(() => this.runDeployment(job, signal), { signal });
              } catch (error) {
                if (signal.aborted && error === signal.reason) {
                  // Stopped before it changed production: not a failure, and the latest revision
                  // publishes when the turn that stopped it ends. One stopped past that point fails
                  // with its own error, and is a failure like any other.
                  this.setDeploymentResult(job, null);
                  return;
                }
                this.failDeployment(job, error);
                if (run.automatic) {
                  this.recordFailedPublication(job.revision);
                }
                await this.scheduleAutomaticDeploymentRetry(job, run, {
                  message: deploymentErrorMessage(error),
                  retryable: isRetryableDurableObjectError(error),
                });
                throw error;
              }
            },
            epoch,
          );
        },
        { metadata: { ...job, ...run } },
      );
    } catch (error) {
      this.failDeployment(job, error);
      throw error;
    }
  }

  /** Retry an automatic deployment that failed for a reason that may pass, with backoff. */
  private async scheduleAutomaticDeploymentRetry(
    job: DeploymentJob,
    run: DeploymentRun,
    failure: DeploymentFailure,
  ): Promise<void> {
    const next =
      run.automatic && !this.destroying
        ? nextAutomaticDeploymentRetry({ ...job, attempt: run.attempt }, failure)
        : null;
    if (!next) {
      return;
    }
    await this.schedule(next.delaySeconds, 'retryAutomaticDeployment', next.retry, { idempotent: true }).catch(() =>
      logger.warn('Unable to schedule the automatic deployment retry'),
    );
  }

  /**
   * A scheduled retry of an automatic deployment. It runs only while the failed revision is still the
   * one to publish and nothing else is publishing it; a turn running now publishes when it ends.
   */
  async retryAutomaticDeployment(payload: AutomaticDeploymentRetry): Promise<void> {
    const retry = automaticDeploymentRetrySchema.safeParse(payload).data;
    if (!retry) {
      return;
    }
    await this.hydrateDurableIdentity({ required: false, reason: 'automatic_deployment_retry' });
    if (!this.userId || !this.transcriptBinding || !this.state.publicationPending) {
      return;
    }
    const job: DeploymentJob = { workspaceRevision: retry.workspaceRevision, revision: retry.revision };
    const snapshot = await this.workspace.checkpoint().catch(() => null);
    const current = this.state.deployment;
    if (
      snapshot?.revision !== job.revision ||
      snapshot.workspaceRevision !== job.workspaceRevision ||
      (current?.revision === job.revision && current.status === 'deploying') ||
      (await this.workspace.linkedProject().catch(() => null))
    ) {
      return;
    }
    await this.scheduleAutomaticDeployment(job, retry.attempt);
  }

  /** Interrupted fibers count: their recovery hook, not the readiness check, settles them. */
  private async deploymentFiberRunning(revision: string): Promise<boolean> {
    const live = await this.listFibers({ name: DEPLOYMENT_FIBER, status: ['pending', 'running', 'interrupted'] });
    return live.some((fiber) => deploymentJobSchema.safeParse(fiber.metadata).data?.revision === revision);
  }

  private async runDeployment(job: DeploymentJob, abortSignal: AbortSignal): Promise<BuilderDeploymentState> {
    const userId = this.userId;
    const transcriptBinding = this.transcriptBinding;
    if (!userId || !transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const startedAt = Date.now();
    // Validation changes nothing in production: however a stop cuts it short, it is a stop.
    await this.buildCheckpoint(
      job,
      'deployment',
      `${deploymentToolCallId(job.workspaceRevision, job.revision)}:validation`,
      abortSignal,
    ).catch((error) => {
      throw abortSignal.aborted ? abortSignal.reason : error;
    });
    const deployment = await this.withPublicationActivity('deployment', (onPlanned) =>
      this.keepAliveWhile(() =>
        this.publisher.deploy({
          context: {
            env: this.env,
            userId,
            chatInitialId: transcriptBinding.chatInitialId,
          },
          workspace: this.workspace,
          toolCallId: deploymentToolCallId(job.workspaceRevision, job.revision),
          validatedRevision: job.revision,
          onPlanned,
          abortSignal,
        }),
      ),
    );
    const revisionBoundDeployment = { ...deployment, ...job };
    if (deployment.status === 'succeeded') {
      await this.recordDeploymentSucceeded(job, deployment);
    } else {
      this.setDeploymentResult(job, revisionBoundDeployment);
    }
    console.info({
      event: 'builder_deployment_settled',
      status: revisionBoundDeployment.status,
      durationMs: Date.now() - startedAt,
    });
    return revisionBoundDeployment;
  }

  /** The deployment of `job` succeeded, as it ran or as its record in the user's account says. */
  private async recordDeploymentSucceeded(job: DeploymentJob, deployment: BuilderDeploymentState): Promise<void> {
    this.setDeploymentResult(job, { ...deployment, ...job });
    await this.recordProductionRevision(job.revision);
  }

  /**
   * Whether production serves `revision`. An agent last deployed before production's revision was
   * recorded knows it only from its succeeded deployment record.
   */
  private productionServes(revision: string): boolean {
    const deployment = this.state.deployment;
    return (
      revision === this.state.productionRevision ||
      (deployment?.status === 'succeeded' && deployment.revision === revision)
    );
  }

  /** Production serves this revision now; the publication a turn asked for is done once it is the current one. */
  private async recordProductionRevision(revision: string): Promise<void> {
    const current = await this.workspace.checkpoint().catch(() => null);
    this.setState({
      ...this.state,
      productionRevision: revision,
      publicationPending: current?.revision === revision ? false : this.state.publicationPending,
    });
  }

  private failDeployment(job: DeploymentJob, error: unknown): BuilderDeploymentState {
    const deployment = { status: 'failed' as const, ...job, error: deploymentErrorMessage(error) };
    this.setDeploymentResult(job, deployment);
    return deployment;
  }

  private setDeploymentResult(job: DeploymentJob, deployment: BuilderDeploymentState | null): void {
    if (this.state.deployment?.revision !== job.revision) {
      return;
    }
    this.setState({ ...this.state, deployment });
  }

  /** The last automatic preview or deployment failure of a CloudChef app, for the model to act on. */
  private publicationFailure(): string | null {
    const preview = this.state.preview;
    if (preview?.status === 'failed' && preview.error) {
      return `the hosted preview of the latest changes failed. ${preview.error}`;
    }
    const deployment = this.state.deployment;
    if (deployment?.status === 'failed' && deployment.error) {
      return `the production deployment of the latest changes failed. ${deployment.error}`;
    }
    return null;
  }

  /** Builds the exact checkpoint a publication was asked for, showing the build's stages while it runs. */
  private async buildCheckpoint(
    snapshot: BuilderWorkspaceCheckpoint,
    publication: 'preview' | 'deployment',
    toolCallId: string,
    abortSignal?: AbortSignal,
  ): Promise<BuilderWorkspaceCheckpoint> {
    const needsBuild = !(await this.workspace.hasSuccessfulValidation(snapshot.revision));
    if (needsBuild) {
      this.setValidationProgress(toolCallId, 'computer validation');
    }
    try {
      const request: Parameters<typeof buildCheckpointForBuilder>[0] = {
        workspace: this.workspace,
        requestedSnapshot: { workspaceRevision: snapshot.workspaceRevision, revision: snapshot.revision },
        publication,
        toolCallId,
        onStage: (stage) => this.setValidationProgress(toolCallId, stage),
      };
      if (abortSignal) {
        request.abortSignal = abortSignal;
      }
      return await this.keepAliveWhile(() => buildCheckpointForBuilder(request));
    } finally {
      if (needsBuild) {
        this.setValidationProgress(toolCallId, null);
      }
    }
  }

  /**
   * Queue a preview publication. An automatic one (`epoch` set) gives up, leaving the preview as it is,
   * when a new turn stopped the automatic publications meanwhile; none starts once the project is being
   * deleted.
   */
  private async requestPreviewInternal(
    options: { snapshot?: BuilderWorkspaceCheckpoint; autoDeploy?: boolean; epoch?: number } = {},
  ): Promise<BuilderPreviewState> {
    if (!this.ownerId || !this.userId || !this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    this.refuseIfDestroying();
    const workspace = await this.initializeWorkspace(this.transcriptBinding);
    if (await this.workspace.linkedProject()) {
      throw new Error('This project previews through GitHub: ask the agent for a preview of your branch.');
    }
    const current = this.currentPreviewState();
    const snapshot = options.snapshot ?? (await this.workspace.checkpoint());
    const publishing = current.status === 'queued' || current.status === 'building';
    if (publishing && current.workspaceRevision === workspace.revision) {
      return current;
    }
    if (current.status === 'ready' && current.published?.snapshotRevision === snapshot.revision) {
      return current;
    }
    const stopped = () => options.epoch !== undefined && this.automaticPublicationStopped(options.epoch);
    if (stopped()) {
      // A stale automatic publication never cancels the preview that replaced it.
      return current;
    }

    await this.runtimeActivity.admit();
    // Admission can wait out an upgrade: whatever changed meanwhile decides again.
    this.refuseIfDestroying();
    if (stopped()) {
      return this.currentPreviewState();
    }
    const replaced = this.currentPreviewState();
    if (replaced.pendingId && (replaced.status === 'queued' || replaced.status === 'building')) {
      await this.cancelPreview();
    }
    const previewId = crypto.randomUUID();
    const job: PreviewPublicationJob = {
      previewId,
      workspaceRevision: snapshot.workspaceRevision,
      snapshotRevision: snapshot.revision,
      requestedAt: Date.now(),
      autoDeploy: options.autoDeploy ?? false,
    };
    this.setPreviewState({
      status: 'queued',
      pendingId: previewId,
      workspaceRevision: snapshot.workspaceRevision,
      stale: snapshot.workspaceRevision !== workspace.revision,
      error: null,
      // The version already serving stays visible until its replacement publishes.
      published: this.currentPreviewState().published,
    });
    try {
      await this.startFiber(
        PREVIEW_PUBLICATION_FIBER,
        async (fiber) => {
          fiber.stash(job);
          await this.runPreviewPublication(job, fiber.signal, options.epoch);
        },
        {
          idempotencyKey: this.previewFiberKey(previewId),
          metadata: job,
        },
      );
    } catch (error) {
      await this.failPreviewPublication(
        job,
        error instanceof Error ? error.message : 'The durable preview job could not be started.',
      );
      throw error;
    }
    return this.currentPreviewState();
  }

  private refuseIfDestroying(): void {
    if (this.destroying) {
      throw new Response('This project is being deleted.', { status: 409 });
    }
  }

  private runPreviewPublication(job: PreviewPublicationJob, fiberSignal?: AbortSignal, epoch?: number): Promise<void> {
    // A new turn stops every preview, a manual one included, as it always has.
    return this.trackPublication(
      true,
      fiberSignal,
      async (abortSignal) => {
        try {
          // Counted busy while it runs: cancelling marks the preview cancelled at once, while the build
          // it aborts can still be finishing. A stop while it still waits for an upgrade window calls it
          // off before it starts.
          await this.runtimeActivity.run(() => this.publishPreview(job, abortSignal, epoch), { signal: abortSignal });
        } catch (error) {
          if (!abortSignal.aborted) {
            throw error;
          }
          if (this.isCurrentPreviewJob(job.previewId)) {
            this.setPreviewState({ ...this.currentPreviewState(), status: 'cancelled', pendingId: null, error: null });
          }
        }
      },
      epoch,
    );
  }

  private async publishPreview(job: PreviewPublicationJob, abortSignal: AbortSignal, epoch?: number): Promise<void> {
    if (!this.isCurrentPreviewJob(job.previewId)) {
      // Recovered after it published but before production was scheduled behind it.
      const preview = this.currentPreviewState();
      if (
        !abortSignal.aborted &&
        preview.status === 'ready' &&
        preview.published?.snapshotRevision === job.snapshotRevision
      ) {
        await this.schedulePipelineDeploymentAfterPreview(job, epoch);
      }
      return;
    }
    try {
      this.setPreviewState({
        ...this.currentPreviewState(),
        status: 'building',
      });
      const userId = this.userId;
      const transcriptBinding = this.transcriptBinding;
      if (!userId || !transcriptBinding) {
        throw new Response('Agent authentication is required.', { status: 401 });
      }
      const validatedSnapshot = await this.buildCheckpoint(
        { workspaceRevision: job.workspaceRevision, revision: job.snapshotRevision },
        'preview',
        `preview:${job.previewId}:validation`,
        abortSignal,
      );
      abortSignal.throwIfAborted();
      if (!this.isCurrentPreviewJob(job.previewId)) {
        return;
      }
      const success = await this.withPublicationActivity('preview', (onPlanned) =>
        this.keepAliveWhile(() =>
          this.publisher.preview({
            context: {
              env: this.env,
              userId,
              chatInitialId: transcriptBinding.chatInitialId,
            },
            workspace: this.workspace,
            toolCallId: deploymentToolCallId(job.workspaceRevision, job.snapshotRevision),
            previewId: job.previewId,
            validatedRevision: validatedSnapshot.revision,
            onPlanned,
            abortSignal,
          }),
        ),
      );
      if (abortSignal.aborted || !this.isCurrentPreviewJob(job.previewId)) {
        return;
      }
      const currentSnapshot = await this.workspace.checkpoint();
      this.setPreviewState({
        status: 'ready',
        pendingId: null,
        workspaceRevision: job.workspaceRevision,
        stale: currentSnapshot.revision !== job.snapshotRevision,
        error: null,
        published: success,
      });
      console.info({
        event: 'builder_preview_published',
        publicationMs: Date.now() - job.requestedAt,
      });
      await this.schedulePipelineDeploymentAfterPreview(job, epoch);
    } catch (error) {
      // A cancelled or superseded preview is not a failure, and never deploys production.
      if (abortSignal.aborted || !this.isCurrentPreviewJob(job.previewId)) {
        return;
      }
      await this.failPreviewPublication(
        job,
        (error instanceof Error ? error.message : 'The Workers preview publication failed.').slice(-4_000),
      );
      if (job.autoDeploy || this.state.publicationPending) {
        this.recordFailedPublication(job.snapshotRevision);
      }
      await this.schedulePipelineDeploymentAfterPreview(job, epoch);
    }
  }

  /**
   * Deployment follows a settled pipeline preview, or any preview of a revision a turn asked to publish
   * — never a manual "Build preview" alone, which must not promote to the public production URL. A
   * failed preview still deploys behind the pipeline so one broken preview never costs the user the
   * production deployment.
   */
  private async schedulePipelineDeploymentAfterPreview(job: PreviewPublicationJob, epoch?: number): Promise<void> {
    if (job.autoDeploy || this.state.publicationPending) {
      await this.scheduleDeploymentAfterPreview(job, epoch);
    }
  }

  private async failPreviewPublication(job: PreviewPublicationJob, error: string): Promise<void> {
    if (!this.isCurrentPreviewJob(job.previewId)) {
      return;
    }
    const refreshed = await this.workspace.refresh().catch(() => {
      logger.warn('Unable to refresh workspace revision for preview failure');
      return null;
    });
    // A restarted agent's client may hold no state at all, and the refresh just failed; the job's
    // revision is then the last one known, and the failure is still recorded.
    const revision = refreshed?.revision ?? this.cachedWorkspaceRevision() ?? job.workspaceRevision;
    this.setPreviewState(failedBuilderPreviewState(this.currentPreviewState(), revision, error));
  }

  private cachedWorkspaceRevision(): number | null {
    try {
      return this.workspace.getState().revision;
    } catch {
      return null;
    }
  }

  private previewFiberKey(previewId: string): string {
    return `builder-preview:${this.name}:${previewId}`;
  }

  private isCurrentPreviewJob(previewId: string): boolean {
    return this.currentPreviewState().pendingId === previewId;
  }

  private currentPreviewState(): BuilderPreviewState {
    return this.state.preview ?? idleBuilderPreviewState();
  }

  private updatePreviewForWorkspace(revision: number): void {
    this.setPreviewState(previewStateForWorkspace(this.currentPreviewState(), revision));
  }

  private setPreviewState(preview: BuilderPreviewState): void {
    this.setState({ ...this.state, preview });
  }

  private async refreshDeploymentReadiness(): Promise<BuilderWorkspaceCheckpoint | null> {
    // A GitHub project deploys through its repository's pipeline: CloudChef's deployment record stays empty.
    if (await this.workspace.linkedProject().catch(() => null)) {
      if (this.state.deployment) {
        this.setState({ ...this.state, deployment: null });
      }
      return null;
    }
    const snapshot = await this.workspace.checkpoint().catch(() => undefined);
    const validated =
      snapshot && (await this.workspace.hasSuccessfulValidation(snapshot.revision).catch(() => undefined));
    if (!snapshot || validated === undefined) {
      // An unreadable workspace says nothing about the deployment, so keep the recorded one.
      logger.warn('Unable to refresh deployment readiness');
      return null;
    }
    const currentDeployment = this.state.deployment;
    // A deployment of the current revision is kept even before its build has finished.
    let deployment =
      currentDeployment?.revision === snapshot.revision
        ? currentDeployment
        : validated
          ? { status: 'ready' as const, ...snapshot }
          : null;
    // A deploying record with no fiber working on its revision is orphaned: nothing would ever settle it.
    if (deployment?.status === 'deploying' && !(await this.deploymentFiberRunning(snapshot.revision))) {
      deployment = { ...deployment, status: 'failed', error: DEPLOYMENT_INTERRUPTED_MESSAGE };
    }
    this.setState({
      ...this.state,
      deployment,
    });
    return validated ? snapshot : null;
  }

  /**
   * Publishing takes minutes of Cloudflare work the user cannot see. Both the deployment executor
   * and the workspace runtime record each step they enter as durable activity, so following those
   * rows while the publication runs turns the wait into the list of things actually happening.
   * The read is one indexed row per interval — a heartbeat, not a busy loop — and it always stops
   * with the publication that started it.
   */
  private async withPublicationActivity<T>(
    lane: BuilderPublicationLane,
    run: (onPlanned: (deploymentId: string) => void) => Promise<T>,
  ): Promise<T> {
    let deploymentId: string | null = null;
    let running = true;
    let stopFollowing: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stopFollowing = resolve;
    });
    const follow = async () => {
      while (running) {
        await Promise.race([scheduler.wait(PUBLICATION_ACTIVITY_INTERVAL_MS), stopped]);
        const id = deploymentId;
        if (!running || !id) {
          continue;
        }
        const latest = await latestDeploymentActivity(this.env.DB, id).catch(() => null);
        const progress = latest ? publicationProgress(lane, [latest]) : null;
        if (running && progress && progress.updatedAt !== this.state.publication?.updatedAt) {
          this.setState({ ...this.state, publication: progress });
        }
      }
    };
    const followed = follow();
    try {
      return await run((id) => {
        deploymentId = id;
      });
    } finally {
      running = false;
      stopFollowing();
      await followed.catch(() => undefined);
      if (this.state.publication?.lane === lane) {
        this.setState({ ...this.state, publication: null });
      }
    }
  }

  private setValidationProgress(toolCallId: string, stage: BuilderValidationStage | null): void {
    if (stage === null && this.state.validationProgress?.toolCallId !== toolCallId) {
      return;
    }
    this.setState({
      ...this.state,
      validationProgress: stage ? { toolCallId, stage } : null,
    });
  }

  private finishTurn(turn: BuilderTurnState, result: { status: BuilderTurnStatus; requestId?: string }) {
    const finishedTurn = completeBuilderTurn(turn, result);
    this.setState({
      ...this.state,
      activeTurn: null,
      lastCompletedTurn: finishedTurn,
      validationProgress: null,
    });
  }
}

const MAX_PUBLICATION_FAILURE_CHARACTERS = 4_000;

/** Tells the model, in the next turn's workspace context, that the last automatic publication failed. */
function withPublicationFailure(
  turnContext: ChatTurnContext | undefined,
  failure: string | null,
): ChatTurnContext | undefined {
  if (!failure) {
    return turnContext;
  }
  const note = `CloudChef publication status: ${failure.slice(-MAX_PUBLICATION_FAILURE_CHARACTERS)}`;
  const content = turnContext?.content ? `${note}\n\n${turnContext.content}` : note;
  return { version: 1, content: content.slice(0, MAX_EPHEMERAL_CONTEXT_CHARACTERS) };
}

function parseTurnContext(value: unknown): ChatTurnContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = chatTurnContextSchema.safeParse(value);
  if (!result.success) {
    throw new Response('Invalid turn context', { status: 400 });
  }
  return result.data;
}

function deploymentErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Deployment failed.';
}

/**
 * Admit one request only while the switches allow it and the connection is still the one the turn
 * started with; otherwise say why, for the model to report.
 */
function admitCloudflareApiRequest(
  admission: CloudflareApiRuntimeAdmission | null,
  expectedIdentity: CloudflareApiRuntimeIdentity,
  write: boolean,
): { admission: CloudflareApiRuntimeAdmission } | { rejection: string } {
  if (
    !admission ||
    !cloudflareRuntimeIdentitiesEqual(admission.identity, expectedIdentity) ||
    !admission.controls.cloudflare_api
  ) {
    return { rejection: 'Cloudflare API requests are disabled or the authenticated connection changed.' };
  }
  if (write && !cloudflareApiWriteEnabled(admission.controls)) {
    return { rejection: 'Cloudflare account changes are disabled for this workspace. Only GET requests can run.' };
  }
  return { admission };
}

function cloudflareRuntimeIdentitiesEqual(
  left: CloudflareApiRuntimeIdentity,
  right: CloudflareApiRuntimeIdentity,
): boolean {
  return (
    left.userId === right.userId &&
    left.accountId === right.accountId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.oauthScopeGrantStatus === right.oauthScopeGrantStatus
  );
}

function cloudflareRequestFailure(accountId: string, content: string): CloudflareRequestImmediateResult {
  return {
    kind: 'cloudflare_request_result',
    status: 'failure',
    accountId,
    content,
    requestId: null,
    httpStatus: null,
    truncated: false,
  };
}

function safeCloudflareExecutionOutcome(outcome: CloudflareApiOutcome): CloudflareExecutionSafeOutcome {
  const metadata = { requestId: outcome.requestId, httpStatus: outcome.httpStatus, truncated: outcome.truncated };
  if (outcome.status === 'success') {
    if (containsCredentialishCloudflareContent(outcome.content)) {
      return {
        status: 'success',
        summary: 'Cloudflare applied the approved request, but sensitive-looking response content was withheld.',
        ...metadata,
        sensitiveContentWithheld: true,
      };
    }
    return {
      status: 'success',
      summary: 'Cloudflare applied the approved request.',
      content: outcome.content,
      ...metadata,
    };
  }
  return { status: outcome.status, summary: outcome.content, ...metadata };
}

function cloudflareExecutionStatusForOutcome(
  outcome: CloudflareApiOutcome,
): Extract<CloudflareExecutionStatus, 'succeeded' | 'failed' | 'indeterminate'> {
  return outcome.status === 'success' ? 'succeeded' : outcome.status === 'indeterminate' ? 'indeterminate' : 'failed';
}

function isCloudflareExecutionTerminal(
  status: CloudflareExecutionStatus,
): status is Exclude<CloudflareExecutionStatus, 'awaiting_approval' | 'approved' | 'executing'> {
  return (
    status === 'rejected' ||
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'indeterminate' ||
    status === 'expired'
  );
}
