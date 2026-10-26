import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
  type OnChatMessageOptions,
} from '@cloudflare/ai-chat';
import { callable, type Connection, type FiberRecoveryContext, type FiberRecoveryResult } from 'agents';
import { conversationCompactionKey } from '~/lib/compaction';
import { abortableSleep } from '~/lib/abortable-sleep';
import { piAgentRunner } from '~/lib/.server/llm/pi-agent-runner';
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
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import {
  buildCheckpointForBuilder,
  deployValidatedRevisionForBuilder,
  settleDeploymentForBuilder,
  terminalizeInterruptedDeploymentForBuilder,
  type BuilderDeploymentContext,
  type BuilderDeploymentState,
} from './builder-deployment-command';
import { publicationProgress, type BuilderPublicationState } from './builder-publication-progress';
import {
  DeploymentConcurrencyLimitError,
  findActiveProjectDeployment,
  latestDeploymentActivity,
} from '~/lib/.server/cloudflare/deployment-repository';
import {
  automaticDeploymentRetrySchema,
  nextAutomaticDeploymentRetry,
  PublicationSupersededError,
  type AutomaticDeploymentRetry,
  type DeploymentFailure,
} from './builder-publication-retry';
import { isRetryableDurableObjectError } from '~/lib/cloudflare/durable-object-rpc.server';
import { generateModelTitle } from '~/lib/.server/llm/workers-ai-title';
import { markChatStarted } from '~/lib/cloudflare/data/chat-repository.server';
import {
  setGeneratedProjectDescription,
  setGeneratedSubchatDescription,
  setHeuristicProjectDescriptionIfMissing,
  setHeuristicSubchatDescriptionIfMissing,
} from '~/lib/cloudflare/data/chat-service.server';
import { messageText, replaceToolCallPart, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import {
  transcriptCheckpointSchema,
  transcriptCheckpointsEqual,
  transcriptMessagesEqual,
  stripTranscriptBaseMetadata,
  advanceTranscriptCheckpoint,
  TRANSCRIPT_BASE_METADATA_KEY,
  transcriptChatInitialId,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import { createWorkersAiSessionAffinity } from '~/lib/.server/llm/workers-ai-prompt-cache';
import {
  boundBuilderMessageForPersistence,
  builderTranscriptBindingsEqual,
  loadBuilderTranscriptBinding,
  loadConversationScope,
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
} from '@cloudchef/user-workspace-runtime/protocol';
import { builderTemplateSeedId, loadBuilderTemplate } from './builder-template';
import { seedBuilderWorkspace, WorkspaceSeedError, type WorkspaceSeedFailure } from './builder-workspace-seed';
import {
  isExcludedProjectPath,
  linkedCommitTree,
  linkedWorkspaceChanges,
  memberBranch,
  revertChanges,
  seedLinkedWorkspace,
  workspaceCommitFiles,
} from './linked-project-workspace';
import { LINKED_BUILD_WATCH_MS } from '~/lib/common/linked-publish';
import {
  LINKED_HELD_BACK_LIMIT,
  linkedBuildSettledResult,
  linkedBuildStartedResult,
  linkedBuildStatus,
  linkedBuildUnfollowedResult,
  linkedBuildWatchSchema,
  linkedHeldBackNote,
  watchLinkedBuild,
  withLinkedBuildResult,
  type LinkedBuildWatch,
} from './linked-project-build';
import {
  ensureProjectRepository,
  openProject,
  ProjectAccessError,
  ProjectRefusalError,
  ProjectUnavailableError,
  projectBuildStatus,
  projectSiteOrigins,
  commitAuthor,
  requestProductionReview,
  type OpenedProject,
  type ProductionRequestOutcome,
} from '~/lib/.server/cloudflare/linked-project-client';
import {
  MAIN_BRANCH,
  nativeProjectRepo,
  ProjectRepositories,
  ProjectRepositoryError,
  workspaceFileMode,
} from '~/lib/.server/cloudflare/project-repository';
import { ZERO_OID } from '~/lib/.server/cloudflare/repository-wire';
import { WORK_DIR } from 'cloudchef-agent/constants';
import { bytesToBase64 } from '~/lib/hex-digest';
import type { LinkedProjectModelToolContext } from '~/lib/.server/llm/linked-project-model-tools';
import type { AppProjectModelToolContext } from '~/lib/.server/llm/app-project-model-tools';
import { BUILDER_TURN_WALL_CLOCK_MS } from '~/lib/.server/llm/builder-turn-limits';
import { deriveProvisionalTitle, shouldGenerateConversationTitle, type TitleSubject } from '~/lib/title-generation';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { PiSteeringQueue } from '~/lib/.server/llm/pi-steering';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS, MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import { z } from 'zod';
import type { DeploymentExecution } from '~/server-handlers/deployments';
import { toolFailure, toolSuccess, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import {
  BuilderCloudflareExecutionRepository,
  CLOUDFLARE_EXECUTION_RISK_NOTE,
  containsCredentialishCloudflareContent,
  isCloudflareExecutionTerminal,
  publicExecutionState,
  sameCloudflareConnectionIdentity,
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
  readCloudflareApiRuntimeIdentity,
  type RuntimeConnectionIdentity,
  runtimeConnectionIdentity,
} from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
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
 * The tool-call identity every publication of one validated revision shares. Deployment and its
 * recovery resolve to the same deterministic deployment plan because they name the same checkpoint here.
 */
function deploymentToolCallId(workspaceRevision: number, revision: string): string {
  return `deploy-command:${workspaceRevision}:${revision}`;
}

const CONTEXT_COMPACTION_FIBER = 'background:context_compaction';
const DEPLOYMENT_FIBER = 'background:builder_deployment';
const DEPLOYMENT_INTERRUPTED_MESSAGE = 'Deployment was interrupted. Retry to reconcile the exact revision.';
/**
 * How long a deployment of another revision holding the project's deployment slot must have shown no
 * sign of work before a deployment it refuses settles it. No fiber here runs it, but one started
 * through the runtime's deployment route runs outside this agent, and records each step it enters.
 */
const BLOCKING_DEPLOYMENT_STALE_MS = 15 * 60_000;
/** How long after a deployment fiber threw its record is settled, once that fiber has ended. */
const DEPLOYMENT_RECORD_SETTLE_DELAY_SECONDS = 5;
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
 * How long a closed conversation waits for a publish to the repository already under way before it reports
 * that it has not settled: the commit call's own timeout (two minutes), and a little for what follows it.
 */
const LINKED_PUBLISH_SETTLE_MS = 2.5 * 60_000;
const CLOSED_CONVERSATION_MESSAGE = 'A newer chat continues this project. Open the newest chat to keep working.';
const DELETED_CONVERSATION_MESSAGE = 'This conversation was deleted.';

/** Fiber metadata survives a Durable Object restart, so every job is re-parsed before it is resumed. */
const deploymentJobSchema = z.object({
  workspaceRevision: z.number().int().min(0),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}) satisfies z.ZodType<BuilderWorkspaceCheckpoint>;
type DeploymentJob = z.infer<typeof deploymentJobSchema>;
/** A deployment job's execution that threw, kept for settling exactly its record a few seconds later. */
const deploymentRecordSettleSchema = deploymentJobSchema.extend({
  deploymentId: z.string().min(1),
  executionGeneration: z.number().int().min(0),
}) satisfies z.ZodType<DeploymentJob & DeploymentExecution>;
type DeploymentRecordSettle = z.infer<typeof deploymentRecordSettleSchema>;
/** Kept beside the job in a deployment fiber's metadata: whether a turn started it, and how many retries preceded it. */
const deploymentRunSchema = z.object({
  automatic: z.boolean(),
  attempt: z.number().int().min(0),
});
type DeploymentRun = z.infer<typeof deploymentRunSchema>;
const revertRequestSchema = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * The publication commands, the agent's boundary with the deployment executor and the user's
 * account. The BuilderAgent harness replaces them, as it replaces the ProjectWorkspace.
 */
const builderPublisher = {
  deploy: deployValidatedRevisionForBuilder,
  terminalize: terminalizeInterruptedDeploymentForBuilder,
  settle: settleDeploymentForBuilder,
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
  validationProgress?: {
    toolCallId: string;
    stage: BuilderValidationStage;
  } | null;
  deployment?: BuilderDeploymentState | null;
  /** The revision production last promoted, kept so a publication that never finished is redone. */
  productionRevision?: string | null;
  /** The address production serves at, as its last deployment recorded it: the app's one site. */
  productionUrl?: string | null;
  /**
   * A turn changed this CloudChef app and production has not caught up yet. Set as the turn settles
   * and cleared only once production serves the current revision, so a cancelled, failed, or
   * restart-interrupted publication is redone at the next turn's end or the agent's next start.
   */
  publicationPending?: boolean;
  /**
   * The revision whose automatic publication last failed. Waking the
   * agent does not publish it again, since it would only fail the same way; the next turn's end does.
   */
  failedPublicationRevision?: string | null;
  /** The step the running deployment last recorded, while it is running. */
  publication?: BuilderPublicationState | null;
  /**
   * A turn is waiting for an upgrade of the workspace runtime to finish before it starts, for at most
   * a few minutes. The browser shows that the workspace is upgrading.
   */
  upgradeWaiting?: boolean;
  contextCompactionRequestedTurnId?: string | null;
  cloudflareExecutions?: CloudflareExecutionPublicState[];
  /** The team project this workspace works on, once it's prepared; null for a CloudChef app. */
  linkedProject?: BuilderLinkedProjectSummary | null;
  /**
   * A newer conversation in the chat continues the project, so this one is kept to read: only the newest
   * conversation changes the project.
   */
  conversationClosed?: boolean;
};

/**
 * What the browser shows of a team project: its name (`repository`), its repository (`repo`), and the
 * branch Workers Builds deploys.
 */
export type BuilderLinkedProjectSummary = {
  repository: string;
  repo?: string;
  defaultBranch: string;
};

/**
 * What a conversation hands the newer one that continues its project: where production stands and
 * where it serves, and whether a publication is still owed. The newer conversation publishes from then on.
 */
type BuilderPublicationHandover = Pick<
  BuilderAgentState,
  'deployment' | 'productionRevision' | 'productionUrl' | 'publicationPending' | 'failedPublicationRevision'
>;

/** Durable transcript as the agent currently holds it, returned after a cancel or an explicit reload. */
type BuilderTranscriptSnapshot = {
  checkpoint: TranscriptCheckpoint | null;
  messages: CloudChefMessage[];
};

/** Payload the connected client sends to steer a running turn. */
export type BuilderSteeringInput = {
  text: string;
  turnContext?: ChatTurnContext;
};

/** The person the request is from, who owns the chat. */
type BuilderAgentProps = { userId: string };

export class BuilderAgent extends AIChatAgent<Env, BuilderAgentState, BuilderAgentProps> {
  static override options = {
    sendIdentityOnConnect: false,
  };

  initialState: BuilderAgentState = {
    activeTurn: null,
    generatedSubchatTitle: null,
    lastCompletedTurn: null,
    transcript: null,
    validationProgress: null,
    deployment: null,
    productionRevision: null,
    productionUrl: null,
    publicationPending: false,
    failedPublicationRevision: null,
    publication: null,
    upgradeWaiting: false,
    contextCompactionRequestedTurnId: null,
    cloudflareExecutions: [],
    linkedProject: null,
    conversationClosed: false,
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
  private userId: string | null = null;
  private transcriptBinding: BuilderTranscriptBinding | null = null;
  private activeSteering: { turnId: string; queue: PiSteeringQueue } | null = null;
  private readonly publisher = builderPublisher;
  /** The account's project repositories (Artifacts); the BuilderAgent harness replaces it with a fake. */
  private readonly repositories = (): ProjectRepositories => new ProjectRepositories(this.env.ARTIFACTS);
  private readonly runningPublications = new Set<RunningPublication>();
  /**
   * Advanced each time a new turn stops the automatic publications. Automatic publication work notes
   * it before it starts and gives up once it changed, so nothing a stopped publication had in flight
   * (waiting to be admitted, or for its fiber to start) starts after the stop.
   */
  private publicationEpoch = 0;
  /** Chat requests between stopping the automatic publications and recording their turn as active. */
  private startingTurns = 0;
  /** Publishes to the project's repository under way: a closed conversation waits for them before the newer one starts. */
  private readonly runningLinkedPublishes = new Set<Promise<CloudChefToolResult>>();
  /** Editor saves under way, from before their closed check: a closed conversation waits for them too. */
  private readonly runningSaves = new Set<Promise<BuilderWorkspaceApplyResult>>();
  /** The seed of a new workspace under way, which every caller needing the workspace seeded shares. */
  private workspaceSeed: Promise<BuilderWorkspaceState> | null = null;
  /** Set once the GC outbox deletes this project: nothing may start publishing it again. */
  private destroying = false;
  /** Set once a newer conversation took the project over from this one, which publishes from then on. */
  private closed = false;
  /** Tells the control plane, through the runtime, when a redeploy would cut this agent's work off. */
  private readonly runtimeActivity: BuilderRuntimeActivity;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeBuilderAgentSchema(ctx);
    this.identityRepository = new BuilderAgentIdentityRepository(ctx.storage);
    this.cloudflareExecutions = new BuilderCloudflareExecutionRepository(ctx.storage);
    this.workspace = new UserWorkspaceRuntimeClient(
      env,
      () => this.workspaceProjectId(),
      () => this.userId,
    );
    this.runtimeActivity = new BuilderRuntimeActivity({
      db: env.DB,
      agentName: () => this.name,
    });
  }

  /**
   * The chat's one project, which every conversation in it works on: the workspace (and so the Worker and
   * resources named after it) is keyed on the chat, by the id of its first conversation's agent.
   */
  private workspaceProjectId(): string {
    const chatInitialId = this.transcriptBinding?.chatInitialId ?? transcriptChatInitialId(this.name);
    return this.env.BuilderAgent.idFromName(chatInitialId).toString();
  }

  override onStateChanged(state: BuilderAgentState | undefined): void {
    void this.runtimeActivity.observe(isBuilderAgentBusy(state));
  }

  async onStart(props?: BuilderAgentProps) {
    if (props) {
      await this.initializeIdentity(props);
    } else {
      await this.hydrateDurableIdentity();
    }
    this.refreshCloudflareExecutionState();
    if (this.state.upgradeWaiting) {
      // The turn that waited stopped with the instance before it started.
      this.setState({ ...this.state, upgradeWaiting: false });
    }
    // A publication a turn asked for may not have reached production before this instance stopped. Once a
    // newer conversation took the project over, it is that one's to finish.
    if (this.state.publicationPending && this.userId && !this.state.conversationClosed) {
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
      if (fiber.name === DEPLOYMENT_FIBER || fiber.name === LINKED_BUILD_FIBER) {
        await this.cancelFiber(fiber.fiberId, 'Project deletion').catch(() => undefined);
      }
    }
    // The chat's conversations share its workspace, and all of them are collected with the chat: the first
    // conversation's agent deletes it, once.
    if (transcriptChatInitialId(this.name) === this.name) {
      await this.workspace.deleteProject();
    }
    await this._cf_scheduleDestroy();
  }

  private async initializeGcIdentity(ownerId: string): Promise<void> {
    if (!transcriptOwnerIdSchema.safeParse(ownerId).success) {
      throw new Response('Invalid transcript owner', { status: 400 });
    }
    if (this.userId && this.userId !== ownerId) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const owned = await this.env.DB.prepare(
      `SELECT 1 AS found
       FROM chat_transcripts AS transcripts
       INNER JOIN chats ON chats.id = transcripts.chat_id
       WHERE transcripts.agent_name = ? AND chats.creator_id = ? AND chats.is_deleted = 1
       LIMIT 1`,
    )
      .bind(this.name, ownerId)
      .first<{ found: number }>();
    // Only a deleted chat's agent: one revived since its sweep read the outbox keeps its project.
    if (!owned) {
      throw new Response('Agent not found.', { status: 404 });
    }
    this.userId = ownerId;
  }

  override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    await this.requireDurableIdentity('chat_recovery', ctx.incidentId);
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
    const lastTurn = this.state.lastCompletedTurn;
    if (
      !this.state.activeTurn &&
      lastTurn?.status === 'aborted' &&
      (lastTurn.requestId === ctx.requestId || lastTurn.requestId === ctx.recoveryRootRequestId)
    ) {
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
    await this.requireDurableIdentity('fiber_recovery', ctx.id);
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
      return { status: 'completed' };
    }
    if (ctx.name === DEPLOYMENT_FIBER) {
      const job = deploymentJobSchema.safeParse(ctx.metadata).data;
      const run = deploymentRunSchema.safeParse(ctx.metadata).data;
      if (!job || !run || !this.userId || !this.transcriptBinding) {
        return { status: 'error', error: 'missing deployment recovery data' };
      }
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
        return { status: 'completed' };
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
      return { status: 'completed' };
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
    return { status: 'completed' };
  }

  override async onChatMessage(
    _onFinish?: Parameters<AIChatAgent['onChatMessage']>[0],
    options?: OnChatMessageOptions,
  ) {
    const durableIdentity = await this.requireDurableIdentity('chat_message');
    const body = options?.body ?? {};
    const messages = this.messages;
    // A conversation a newer one took over is kept to read: only the newest one changes the project.
    if ((await loadConversationScope(this.env.DB, { agentName: this.name, ownerId: durableIdentity.userId })).closed) {
      throw new Response(CLOSED_CONVERSATION_MESSAGE, { status: 409 });
    }
    const { chatInitialId, subchatIndex, transcript, modelId, reasoningLevel } = requireBuilderRequestScope(
      body,
      durableIdentity.transcript,
    );
    const accountCredentials = await getUserWorkersAiCredentials(this.env, durableIdentity.userId);
    const { model, gatewayKeyAlias, gatewayKeyRevision } = await requireBuilderModel(
      accountCredentials.binding,
      modelId,
      () => readAccountModelSettings(this.env),
    );
    const chosenReasoningLevel = requireBuilderReasoningLevel(model, reasoningLevel);
    // Refused before anything is stopped or recorded: a turn that never starts must not hold anything.
    const requestedTurnContext = parseTurnContext(body.turnContext);
    const siteNote = this.linkedSiteNote();
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
          sessionId: durableIdentity.userId,
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
    const publicationFailure = this.publicationFailure();
    const turnContext = withNotes(requestedTurnContext, [
      publicationFailure &&
        `CloudChef publication status: ${publicationFailure.slice(-MAX_PUBLICATION_FAILURE_CHARACTERS)}`,
      await siteNote,
    ]);
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
      // turn and stopped it, or closed this one before this read.
      await this.refuseIfClosed();
      const { contentLogging } = await this.requireModelAccess();
      // The browser prepares the workspace before it sends, but nothing else seeds a new one.
      await this.initializeWorkspace(durableIdentity.transcript);
      await this.nameGitRepository(chatInitialId);
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
      const stream = await piAgentRunner({
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
        appProject: linkedProject ? undefined : this.appProjectToolContext(),
        onValidationStage: (toolCallId, stage) => this.setValidationProgress(toolCallId, stage),
        pushResult: (toolCallId) => this.gitPushResult(toolCallId),
        runWithKeepAlive: (operation) => this.keepAliveWhile(operation),
        steering,
        onSettled: (report) => {
          settleSteering();
          // A team project publishes through Workers Builds, when the agent publishes to it.
          if (report.changedProject && !linkedProject && !this.state.publicationPending) {
            this.setState({ ...this.state, publicationPending: true });
          }
        },
        onModelUsage: (usage) => this.reportModelUsage(usage),
        compaction: {
          current: this.contextCompaction.getCompaction(),
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
        messages,
        model,
        reasoningLevel: chosenReasoningLevel,
      });
      return createUIMessageStreamResponse({ stream });
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
      async () => {
        this.runContextCompaction(throughMessageId);
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

  private runContextCompaction(throughMessageId: string): void {
    const throughIndex = this.messages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) {
      return;
    }
    const next = compactContext({
      messages: this.messages.slice(0, throughIndex + 1),
      current: this.contextCompaction.getCompaction(),
    });
    if (next) {
      this.contextCompaction.saveCompaction(next);
    }
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
    // A rollover requested before an abort/error still belongs to the persisted transcript.
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
    // publishes it however the turn ended: the deployment builds the exact revision (unless the model
    // already validated it) and publishes it to production. A team project previews and deploys through
    // Workers Builds, when the agent publishes to it.
    if (this.state.publicationPending || (status === 'completed' && validatedSnapshot)) {
      await this.publishLatestRevision(validatedSnapshot);
    }
  }

  @callable()
  async steerActiveTurn(input: BuilderSteeringInput): Promise<{ accepted: true }> {
    await this.requireDurableIdentity('steer_active_turn');
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
      async () => {
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
    await validationCancellation;
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
   * A newer conversation in this chat has taken the project over (this one is closed): stop the turn and
   * the automatic publications running here, and return once nothing more can change the workspace, with
   * what the newer conversation needs to go on publishing. Saves, steering, approvals and publishing are
   * already refused here. A team project's build watch keeps running: it only reads the build's status and
   * fills in this transcript's publish result.
   *
   * An internal Durable Object RPC, not `@callable`: the data API calls it when the new conversation starts.
   */
  async settleForSuccessor(ownerId: string): Promise<BuilderPublicationHandover | null> {
    if (!transcriptOwnerIdSchema.safeParse(ownerId).success) {
      throw new Response('Invalid transcript owner', { status: 400 });
    }
    const identity = await this.hydrateDurableIdentity();
    if (!identity) {
      // Never started, so nothing runs or was published here.
      return null;
    }
    if (identity.userId !== ownerId) {
      throw new Response('Agent not found.', { status: 404 });
    }
    if (!(await loadConversationScope(this.env.DB, { agentName: this.name, ownerId })).closed) {
      throw new Response('This conversation is still the newest one.', { status: 409 });
    }
    this.closed = true;
    if (!this.state.conversationClosed) {
      this.setState({ ...this.state, conversationClosed: true });
    }
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
    await this.stopAutomaticPublications();
    // A publish whose commit was already on its way runs to the end whatever the Stop, and so does a save
    // that found this conversation current: reported saved, it must be in the workspace before the newer
    // conversation works on it.
    if (!(await this.waitForWorkspaceWrites(LINKED_PUBLISH_SETTLE_MS))) {
      throw new Error('The earlier conversation did not settle in time.');
    }
    const handover: BuilderPublicationHandover = {
      deployment:
        this.state.deployment?.status === 'succeeded' || this.state.deployment?.status === 'failed'
          ? this.state.deployment
          : null,
      productionRevision: this.state.productionRevision ?? null,
      productionUrl: this.state.productionUrl ?? null,
      publicationPending: this.state.publicationPending ?? false,
      failedPublicationRevision: this.state.failedPublicationRevision ?? null,
    };
    // Owed by the newer conversation now: a restart here must not publish it again.
    if (this.state.publicationPending) {
      this.setState({ ...this.state, publicationPending: false });
    }
    return handover;
  }

  /**
   * Takes over the publication state `settleForSuccessor` handed over from the conversation this one
   * continues, and publishes what that one still owed. A conversation that has publication state of its own
   * keeps it.
   *
   * An internal Durable Object RPC, not `@callable`: the data API calls it when this conversation starts.
   */
  async continuePublication(ownerId: string, handover: BuilderPublicationHandover): Promise<void> {
    await this.initializeIdentity({ userId: ownerId });
    if (this.state.productionRevision || this.state.deployment || this.state.publicationPending) {
      return;
    }
    this.setState({ ...this.state, ...handover });
    if (handover.publicationPending) {
      this.ctx.waitUntil(
        this.resumeUnfinishedPublication().catch(() => logger.warn('Unable to resume the unfinished publication')),
      );
    }
  }

  /** Whether every publish to the repository and editor save under way settled within `timeoutMs`. */
  private async waitForWorkspaceWrites(timeoutMs: number): Promise<boolean> {
    return settledWithin([...this.runningLinkedPublishes, ...this.runningSaves], timeoutMs);
  }

  /**
   * A conversation a newer one took over is kept to read, and a deleted chat's agent lives on for a while,
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
    const ownerId = this.userId ?? (await this.requireDurableIdentity('closed_check')).userId;
    const { closed, deleted } = await loadConversationScope(this.env.DB, { agentName: this.name, ownerId });
    if (deleted) {
      return DELETED_CONVERSATION_MESSAGE;
    }
    return closed ? CLOSED_CONVERSATION_MESSAGE : null;
  }

  /**
   * Asks the team's admins to make this draft a real project: the draft is committed to main of its own
   * repository first, and approved, that repository becomes the project, which Workers Builds deploys.
   */
  @callable()
  async requestProduction(input: { title: string; note: string }): Promise<{ outcome: ProductionRequestOutcome }> {
    const durableIdentity = await this.requireDurableIdentity('request_production');
    const identity = runtimeConnectionIdentity(this.env);
    if (this.env.CLOUDCHEF_SHARED_ACCOUNT !== '1' || !identity) {
      throw new Error("Only a team's drafts can be sent to become team projects.");
    }
    if (await this.workspace.linkedProject()) {
      throw new Error("This is already one of the team's projects: ask the agent to publish it.");
    }
    await this.refuseIfClosed();
    const checkpoint = await this.workspace.checkpoint();
    const title = input.title.trim().slice(0, 80);
    if (!title) {
      throw new Error('Name the app for your admin.');
    }
    const commit = await this.commitWorkspaceToHistory({
      revision: checkpoint.revision,
      message: `${title}\n\nCloudChef-Revision: ${checkpoint.revision}`,
    });
    if (!commit) {
      throw new Error('The draft kept changing while it was being saved. Try again.');
    }
    // The chat is the draft: sent again from it, the request is replaced rather than repeated.
    const { outcome } = await requestProductionReview(this.env, identity, {
      draftId: durableIdentity.transcript.chatInitialId,
      draftRevision: checkpoint.revision,
      title,
      note: input.note.trim().slice(0, 1_000),
      previewUrl: this.state.productionUrl ?? this.state.deployment?.productionUrl ?? null,
      repo: nativeProjectRepo(durableIdentity.transcript.chatInitialId),
      commit: commit.hash,
    });
    return { outcome };
  }

  /**
   * Makes the workspace hold exactly the files of `commit` in the project's history, as one change set
   * through the same compare-and-swap path as an editor save: files the commit lacks are deleted, except
   * what no commit holds (installed and built output, local secrets, ignored files). Refused while a turn
   * runs. A CloudChef app commits the result to main as a revert, then publishes it as after any turn; a
   * team project's revert is published by the agent like any other change.
   */
  @callable()
  async revertToCommit(commit: string): Promise<BuilderWorkspaceApplyResult> {
    const durableIdentity = await this.requireDurableIdentity('revert_to_commit');
    const parsed = revertRequestSchema.safeParse(commit);
    if (!parsed.success) {
      throw new Response('Invalid commit.', { status: 400 });
    }
    if (this.state.activeTurn || this.startingTurns > 0) {
      throw new Response('Stop the agent before restoring a version.', { status: 409 });
    }
    await this.refuseIfClosed();
    const linked = await this.workspace.linkedProject();
    let repo = nativeProjectRepo(durableIdentity.transcript.chatInitialId);
    if (linked) {
      const identity = runtimeConnectionIdentity(this.env);
      const project = identity ? await openProject(this.env, identity, linked.orgProjectId) : null;
      if (!project?.repo || project.role !== 'edit') {
        throw new Response('You can view this project but not change it.', { status: 403 });
      }
      repo = project.repo;
    }
    const { files } = await this.repositories().readFilesAt(repo, parsed.data, (path) => !isExcludedProjectPath(path));
    const { baseRevision, changes } = await revertChanges(this.workspace, files);
    const result = await this.applyWorkspaceClientChanges({ baseRevision, changes });
    if (!result.ok) {
      throw new Response('The project changed while this version was being restored. Try again.', { status: 409 });
    }
    if (!linked && result.changedPaths.length > 0) {
      const checkpoint = await this.workspace.checkpoint();
      await this.commitWorkspaceToHistory({
        revision: checkpoint.revision,
        message: `Restore version ${parsed.data.slice(0, 7)}\n\nCloudChef-Revision: ${checkpoint.revision}`,
      }).catch(() => logger.warn('Unable to commit the revert to the project history'));
      this.setState({ ...this.state, publicationPending: true });
      this.ctx.waitUntil(
        this.publishLatestRevision(null).catch(() => logger.warn('Unable to publish the reverted revision')),
      );
    }
    return result;
  }

  /** The team project this workspace works on, or null for a CloudChef app. */
  getLinkedProject(): Promise<BuilderWorkspaceLinkedProject | null> {
    return this.workspace.linkedProject();
  }

  /**
   * Tells the browser whether this is a team project, so it never offers what only a CloudChef app has, and
   * whether a newer conversation continues the project, so it offers nothing here that would change it.
   */
  private async publishWorkspaceSummary(): Promise<void> {
    const linked = await this.workspace.linkedProject();
    this.showLinkedProject(
      linked
        ? { repository: linked.name ?? linked.repository, repo: linked.repository, defaultBranch: linked.defaultBranch }
        : null,
    );
    const closed =
      this.userId !== null &&
      (await loadConversationScope(this.env.DB, { agentName: this.name, ownerId: this.userId })).closed;
    if ((this.state.conversationClosed ?? false) !== closed) {
      this.setState({ ...this.state, conversationClosed: closed });
    }
  }

  private showLinkedProject(next: BuilderLinkedProjectSummary | null): void {
    const current = this.state.linkedProject ?? null;
    if (
      current?.repository === next?.repository &&
      current?.repo === next?.repo &&
      current?.defaultBranch === next?.defaultBranch
    ) {
      return;
    }
    this.setState({ ...this.state, linkedProject: next });
  }

  @callable()
  getWorkspaceState(): Promise<BuilderWorkspaceState> {
    return this.workspace.refresh();
  }

  /**
   * The workspace, seeded first when it is new. A seed that failed (a team project's import refused, say)
   * is answered as a failure for the browser to show: thrown, the browser would take it for a lost
   * connection and keep reconnecting.
   */
  @callable()
  async prepareWorkspace(): Promise<BuilderWorkspaceState | WorkspaceSeedFailure> {
    if (!this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    let state: BuilderWorkspaceState;
    try {
      state = await this.initializeWorkspace(this.transcriptBinding);
    } catch (error) {
      if (error instanceof WorkspaceSeedError) {
        logger.warn('The new workspace could not be seeded');
        return { initialized: false, failure: error.message };
      }
      throw error;
    }
    await this.publishWorkspaceSummary();
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
    const save = this.applyClientChanges(request);
    this.runningSaves.add(save);
    try {
      return await save;
    } finally {
      this.runningSaves.delete(save);
    }
  }

  private async applyClientChanges(request: WorkspaceApplyChangesRequest): Promise<BuilderWorkspaceApplyResult> {
    await this.refuseIfClosed();
    const result = await this.workspace.applyClientChanges(request);
    if (result.ok && result.changedPaths.length > 0) {
      this.setState({
        ...this.state,
        deployment: null,
      });
    }
    return result;
  }

  @callable()
  async deployValidatedRevision(): Promise<BuilderDeploymentState> {
    await this.requireDurableIdentity('deploy_validated_revision');
    await this.refuseIfClosed();
    if (await this.workspace.linkedProject()) {
      throw new Error('Ask the agent to publish this project.');
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
    await this.initializeIdentity({ userId: ownerId });
    return this.getTranscriptSnapshot(identityValue);
  }

  private async getTranscriptCheckpoint(identityValue: TranscriptIdentity): Promise<TranscriptCheckpoint | null> {
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
    if (!transcriptOwnerIdSchema.safeParse(props.userId).success) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const transcriptBinding = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: props.userId,
    });
    if (!transcriptBinding) {
      throw new Response('Agent not found.', { status: 404 });
    }
    const identity: BuilderAgentDurableIdentity = { userId: props.userId, transcript: transcriptBinding };
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

  /** The stored identity, applied, or null when none is stored or it no longer names the active transcript. */
  private async hydrateDurableIdentity(): Promise<BuilderAgentDurableIdentity | null> {
    const stored = await this.readDurableIdentity();
    return stored === 'missing' || stored === 'stale' ? null : stored;
  }

  /** The stored identity, applied; a missing or stale one rejects the request. */
  private async requireDurableIdentity(reason: string, incidentId?: string): Promise<BuilderAgentDurableIdentity> {
    const stored = await this.readDurableIdentity();
    if (stored === 'missing') {
      this.rejectIdentity(`${reason}_missing`, incidentId, 401);
    }
    if (stored === 'stale') {
      this.rejectIdentity(`${reason}_stale`, incidentId);
    }
    return stored;
  }

  private async readDurableIdentity(): Promise<BuilderAgentDurableIdentity | 'missing' | 'stale'> {
    const stored = this.identityRepository.get();
    if (!stored) {
      return 'missing';
    }
    const activeTranscript = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: stored.userId,
    });
    if (
      !activeTranscript ||
      !builderAgentIdentitiesEqual(stored, { userId: stored.userId, transcript: activeTranscript })
    ) {
      // Rejecting here for a non-required hydration makes `onStart` throw, and the SDK rethrows that
      // from every native RPC entry point — including `_cf_scheduleDestroy`. A soft-deleted chat has
      // no active transcript by definition, so the GC sweep could never condemn its Durable Object:
      // it retried forever, re-running the project deletion each round. Startup leaves the identity
      // unset instead; every operational entry point requires it.
      return 'stale';
    }
    this.applyIdentity(stored);
    return stored;
  }

  private applyIdentity(identity: BuilderAgentDurableIdentity): void {
    if (
      (this.userId && this.userId !== identity.userId) ||
      (this.transcriptBinding &&
        !builderAgentIdentitiesEqual({ userId: identity.userId, transcript: this.transcriptBinding }, identity))
    ) {
      this.rejectIdentity('memory_identity_mismatch');
    }
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
      async () => {
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
    const ownerId = this.userId;
    if (!ownerId) {
      return;
    }

    // Start model work before persistence so the background request leaves the
    // critical chat path as soon as the first prompt is accepted.
    // Naming the chat is model use too, counted toward an organization member's usage.
    const countUsage = (usage: Usage) => this.reportModelUsage(turnUsage(usage));
    const generateTitle = (subject: TitleSubject) =>
      generateModelTitle(args.prompt, subject, args.accountCredentials, args.gatewayLogging, countUsage);
    const conversationTitlePromise = generateTitle('conversation');
    const projectTitlePromise = args.firstPrompt && args.subchatIndex === 0 ? generateTitle('project') : null;
    const provisionalTitle = args.firstPrompt ? deriveProvisionalTitle(args.prompt) : null;

    if (provisionalTitle) {
      try {
        const [, savedHeuristicSubchat] = await Promise.all([
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
      .run(() =>
        this.seedNewWorkspace(binding).catch((error: Error) => {
          throw isSeedRefusal(error) ? new WorkspaceSeedError(error) : error;
        }),
      )
      .finally(() => {
        this.workspaceSeed = null;
      });
    return this.workspaceSeed;
  }

  private async seedNewWorkspace(binding: BuilderTranscriptBinding): Promise<BuilderWorkspaceState> {
    const { orgProjectId } = this.userId
      ? await loadConversationScope(this.env.DB, { agentName: binding.agentName, ownerId: this.userId })
      : { orgProjectId: null };
    if (orgProjectId) {
      const identity = runtimeConnectionIdentity(this.env);
      if (!identity) {
        throw new ProjectRefusalError('This workspace is not connected to CloudChef, so it cannot open the project.');
      }
      const project = await openProject(this.env, identity, orgProjectId);
      if (project.role !== 'edit') {
        throw new ProjectRefusalError('You can view this project but not edit it.');
      }
      // Named to the browser at once, not minutes later when the workspace is seeded.
      this.showLinkedProject({ repository: project.name, defaultBranch: MAIN_BRANCH });
      const repositories = this.repositories();
      const repo = await ensureProjectRepository(this.env, identity, repositories, project);
      return seedLinkedWorkspace(this.workspace, repositories, { orgProjectId, name: project.name, repo });
    }
    // A fork starts from its own repository, which the fork made before the chat existed.
    const repositories = this.repositories();
    const own = nativeProjectRepo(binding.chatInitialId);
    if (await repositories.head(own)) {
      const { commit, files } = await repositories.readFilesAt(
        own,
        MAIN_BRANCH,
        (path) => !isExcludedProjectPath(path),
      );
      return seedBuilderWorkspace(
        this.workspace,
        `repository_${commit.hash}`,
        files.map((file): BuilderWorkspaceFileInput => ({
          path: `${WORK_DIR}/${file.path}`,
          content: bytesToBase64(file.bytes),
          encoding: 'base64',
          mode: workspaceFileMode(file.mode),
        })),
      );
    }
    const template = await loadBuilderTemplate();
    return seedBuilderWorkspace(this.workspace, builderTemplateSeedId(), template);
  }

  /**
   * Tells the workspace which repository git in its container reaches through the git proxy: a team
   * project's, or this CloudChef app's own. Each turn, so a workspace seeded before the proxy existed learns it.
   */
  private async nameGitRepository(chatInitialId: string): Promise<void> {
    const linked = await this.workspace.linkedProject();
    await this.workspace.setGitRepository(
      linked
        ? { repo: linked.repository, orgProjectId: linked.orgProjectId }
        : { repo: nativeProjectRepo(chatInitialId), orgProjectId: null },
    );
  }

  /** The commit tool for a CloudChef app; a team project's publish tools commit instead. */
  private appProjectToolContext(): AppProjectModelToolContext {
    return {
      commit: async ({ message }) => {
        const checkpoint = await this.workspace.checkpoint();
        const commit = await this.commitWorkspaceToHistory({
          revision: checkpoint.revision,
          message: `${message}\n\nCloudChef-Revision: ${checkpoint.revision}`,
        });
        if (!commit) {
          return toolFailure('The project changed while it was being saved. Save again.');
        }
        return commit.unchanged
          ? toolSuccess(`This version is already saved (${commit.hash.slice(0, 7)}).`, commit)
          : toolSuccess(`Saved version ${commit.hash.slice(0, 7)}.`, commit);
      },
    };
  }

  /** The publish tools for a workspace opened from a team project; none otherwise. */
  private async createLinkedProjectToolContext(): Promise<LinkedProjectModelToolContext | undefined> {
    const linked = await this.workspace.linkedProject();
    if (!linked) {
      return undefined;
    }
    return {
      repository: linked.name ?? linked.repository,
      defaultBranch: linked.defaultBranch,
      publish: (input, options) =>
        this.trackLinkedPublish(this.keepAliveWhile(() => this.publishLinkedProject(input, options))),
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
   * Commits the workspace to the project's repository: a commit on the chat's own branch, merged
   * into main when it should go live. It returns once the commit is there; Workers Builds is watched in the
   * background, and its result and preview link replace this output when it reports.
   */
  private async publishLinkedProject(
    input: { message: string; live: boolean },
    options: { toolCallId: string; abortSignal?: AbortSignal },
  ): Promise<CloudChefToolResult> {
    const linked = await this.workspace.linkedProject();
    const identity = runtimeConnectionIdentity(this.env);
    if (!linked || !identity || !this.userId) {
      return toolFailure("This workspace is not one of the team's projects.");
    }
    const closed = await this.closedConversationMessage();
    if (closed) {
      return toolFailure(`${closed} Nothing was sent.`);
    }
    const name = linked.name ?? linked.repository;
    // Asked each time: access can be taken away, and the control plane names the project's repository.
    let project: OpenedProject;
    try {
      project = await openProject(this.env, identity, linked.orgProjectId);
    } catch (error) {
      return toolFailure(error instanceof Error ? error.message : 'CloudChef could not open the project.');
    }
    if (project.role !== 'edit' || !project.repo) {
      return toolFailure(
        project.role !== 'edit'
          ? 'Your access to this project is view only, so nothing was sent.'
          : "This project isn't ready yet. Open the project again.",
      );
    }
    const repo = project.repo;
    const { changes, manifest, heldBack } = await linkedWorkspaceChanges(this.workspace, linked);
    if (changes.length === 0) {
      return toolFailure(`There are no new changes to ${name} to send.` + linkedHeldBackNote(heldBack));
    }
    const repositories = this.repositories();
    const author = project.member ?? (await commitAuthor(this.env));
    const branch = memberBranch(project.member?.email ?? null, this.userId, linked.branchKey);
    const [{ files: base }, head] = await Promise.all([
      repositories.readTreeAt(repo, linked.baseCommit),
      repositories.head(repo, branch),
    ]);
    // The last moment a Stop or the tool's deadline can call it off. Once the repository has the commit (and
    // the merge), there's no taking it back: everything below runs to the end, and its result is the real one
    // even if the turn ended meanwhile; the build watch then puts it in place of the stopped call's error.
    options.abortSignal?.throwIfAborted();
    // One commit on top of the base, replacing the branch's last one, so the branch always shows exactly the
    // workspace.
    const committed = await repositories.commitFiles({
      repo,
      branch,
      parent: linked.baseCommit,
      replaces: head,
      files: linkedCommitTree(base, changes),
      message: input.message,
      author,
    });
    if ('conflict' in committed) {
      return toolFailure(
        `Another save of these changes happened at the same moment, so nothing was sent. ${input.live ? 'Publish' : 'Ask for the preview'} again.`,
      );
    }
    let published = committed.commit;
    if (input.live) {
      const merged = await repositories.mergeIntoMain({
        repo,
        branch,
        author,
        message: `Publish from CloudChef: ${input.message.split('\n')[0]}`,
      });
      if ('conflict' in merged) {
        return toolFailure(
          `${linked.defaultBranch} changed since this workspace was opened, and the changes overlap. Nothing went ` +
            `live. The work is saved on the branch ${branch} of ${name}, but this chat's workspace stays on its old ` +
            'base, and so do its new conversations, and CloudChef cannot move it onto the latest version yet: ' +
            'publishing again will meet the same overlap. Tell the person, and that the live version keeps the other change.',
          { branch, commit: committed.commit, conflict: true, defaultBranch: linked.defaultBranch },
        );
      }
      published = merged.commit;
      // The branch's commit becomes the base: its tree is exactly this workspace, so later changes are
      // measured from it, and merging them keeps whatever else main gained meanwhile.
      await this.workspace.setLinkedProject({
        ...linked,
        repository: repo,
        baseCommit: committed.commit,
        baseManifest: manifest,
      });
    }
    const watch: LinkedBuildWatch = {
      toolCallId: options.toolCallId,
      orgProjectId: linked.orgProjectId,
      sha: published,
      branch,
      where: input.live ? `merged into ${linked.defaultBranch}` : `on the branch ${branch}`,
      live: input.live,
      startedAt: Date.now(),
      defaultBranch: linked.defaultBranch,
    };
    if (heldBack.length) {
      watch.heldBack = heldBack.slice(0, LINKED_HELD_BACK_LIMIT);
    }
    return this.followLinkedBuild(watch);
  }

  /**
   * What the command `toolCallId` pushed to a team project's repository, reported as a publish is: its
   * default branch (it goes live) or else the last branch pushed (a preview), with its build followed in the
   * background. Nothing for a CloudChef app's pushes, or a command that pushed no branch.
   */
  private async gitPushResult(toolCallId: string): Promise<CloudChefToolResult | undefined> {
    const linked = await this.workspace.linkedProject();
    if (!linked) {
      return undefined;
    }
    const branches = (await this.workspace.takeGitPushes()).filter(
      (push) => push.ref.startsWith('refs/heads/') && push.newOid !== ZERO_OID,
    );
    const pushed = branches.findLast((push) => push.ref === `refs/heads/${linked.defaultBranch}`) ?? branches.at(-1);
    if (!pushed) {
      return undefined;
    }
    const branch = pushed.ref.slice('refs/heads/'.length);
    const live = branch === linked.defaultBranch;
    return this.followLinkedBuild({
      toolCallId,
      orgProjectId: linked.orgProjectId,
      sha: pushed.newOid,
      branch,
      where: live ? `and pushed to ${branch}` : `and pushed to the branch ${branch}`,
      live,
      startedAt: Date.now(),
      defaultBranch: linked.defaultBranch,
    });
  }

  /** Starts following a commit's build in the background; the result replaces the call's output when it reports. */
  private async followLinkedBuild(watch: LinkedBuildWatch): Promise<CloudChefToolResult> {
    try {
      await this.startFiber(
        LINKED_BUILD_FIBER,
        async (fiber) => {
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
    const identity = runtimeConnectionIdentity(this.env);
    const build = identity
      ? await watchLinkedBuild({
          poll: async () => {
            // A call stopped after its commit shows as failed until its result lands: while the pipeline
            // builds, it at least says what is in the repository.
            await this.landLinkedBuildOutput(watch, linkedBuildStartedResult(watch), { onlyFailed: true });
            return linkedBuildStatus(
              await projectBuildStatus(this.env, identity, watch.orgProjectId, watch.sha),
              watch.live,
            );
          },
          deadline: watch.startedAt + LINKED_BUILD_WATCH_MS,
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
      await abortableSleep(LINKED_BUILD_LANDING_POLL_MS, signal);
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
    await this.persistReplacedToolOutput(messages);
    return true;
  }

  /** Persists the transcript after one finished tool call's output was replaced, and its checkpoint with it. */
  private async persistReplacedToolOutput(messages: CloudChefMessage[]): Promise<void> {
    // SAFETY: these are the agent's existing AI SDK messages with only one terminal tool part changed: its
    // JSON-serializable output replaced, or a stopped call's error replaced by its real output.
    await this.persistMessages(messages as UIMessage[]);
    if (this.state.transcript) {
      await this.advanceTranscriptCheckpoint(this.state.transcript);
    }
  }

  /**
   * A team project's live addresses, for the turn's context: the agent reads its site with curl, and these
   * are where it is. Null when there are none, or they can't be learned quickly, so a turn never waits on it.
   */
  private async linkedSiteNote(): Promise<string | null> {
    const linked = await this.workspace.linkedProject();
    const identity = runtimeConnectionIdentity(this.env);
    if (!linked || !identity) {
      return null;
    }
    try {
      const origins = await projectSiteOrigins(this.env, identity, linked.orgProjectId, SITE_NOTE_TIMEOUT_MS);
      return origins.length > 0 ? `The project's live site and preview links: ${origins.join(', ')}` : null;
    } catch {
      return null;
    }
  }

  /** Whether this person is now an active admin of the organization whose account this runtime uses. */
  private async isOrganizationAdmin(): Promise<boolean> {
    const identity = runtimeConnectionIdentity(this.env);
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
    const identity = runtimeConnectionIdentity(this.env);
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
    const expectedIdentity = await readCloudflareApiRuntimeIdentity(this.env, () => this.isOrganizationAdmin());
    if (
      !expectedIdentity ||
      !this.userId ||
      expectedIdentity.userId !== this.userId ||
      !this.transcriptBinding ||
      !builderTranscriptBindingsEqual(this.transcriptBinding, transcript)
    ) {
      return undefined;
    }
    return {
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
    expectedIdentity: RuntimeConnectionIdentity,
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
    const identity = await this.readCurrentCloudflareApiIdentity(expectedIdentity);
    if (!identity) {
      return cloudflareRequestFailure(expectedIdentity.accountId, CLOUDFLARE_API_IDENTITY_CHANGED);
    }
    if (!write) {
      const signal = options.abortSignal ?? new AbortController().signal;
      let outcome: CloudflareApiOutcome;
      try {
        outcome = await this.createCloudflareApiClient(identity).send(request, signal);
      } catch {
        // A failed tool result lets the model report or retry instead of ending the turn.
        signal.throwIfAborted();
        return cloudflareRequestFailure(identity.accountId, 'The Cloudflare credential is unavailable.');
      }
      return {
        kind: 'cloudflare_request_result',
        // Only a change can be left half-applied; an unobserved read is simply a failure to retry.
        status: outcome.status === 'indeterminate' ? 'failure' : outcome.status,
        accountId: identity.accountId,
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
      binding: { ...identity, transcript },
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
  private async requireCloudflareApiWriteAdmission(expectedIdentity: RuntimeConnectionIdentity): Promise<void> {
    if (!(await this.readCurrentCloudflareApiIdentity(expectedIdentity))) {
      throw new Error(CLOUDFLARE_API_IDENTITY_CHANGED);
    }
  }

  /** The runtime's Cloudflare API identity, only while it is still the connection the turn started with. */
  private async readCurrentCloudflareApiIdentity(
    expectedIdentity: RuntimeConnectionIdentity,
  ): Promise<RuntimeConnectionIdentity | null> {
    const identity = await readCloudflareApiRuntimeIdentity(this.env, () => this.isOrganizationAdmin());
    return identity && sameCloudflareConnectionIdentity(identity, expectedIdentity) ? identity : null;
  }

  private createCloudflareApiClient(identity: RuntimeConnectionIdentity): CloudflareApiClient {
    return new CloudflareApiClient({
      resolveAccessToken: (options) => resolveUserWorkspaceCloudflareAccessToken(this.env, identity, options),
    });
  }

  private async requireCurrentCloudflareExecutionBinding(reason: string): Promise<CloudflareExecutionBinding> {
    const durableIdentity = await this.requireDurableIdentity(reason);
    const transcript = this.transcriptBinding;
    const identity = await readCloudflareApiRuntimeIdentity(this.env, () => this.isOrganizationAdmin());
    if (!transcript || !identity || identity.userId !== durableIdentity.userId) {
      throw new Response('The Cloudflare execution identity is unavailable.', { status: 409 });
    }
    return { ...identity, transcript };
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
    const messages = replaceToolCallPart(this.messages, record.toolCallId, (part, invocation) =>
      invocation.toolName === 'cloudflare_request' && invocation.state === 'output-available'
        ? { ...part, output }
        : null,
    );
    if (messages) {
      await this.persistReplacedToolOutput(messages);
    }
  }

  private refreshCloudflareExecutionState(): void {
    this.cloudflareExecutions.expireAwaiting();
    const cloudflareExecutions = this.cloudflareExecutions.listRecent();
    this.setState({ ...this.state, cloudflareExecutions });
  }

  private async terminalizeDeployment(job: DeploymentJob): Promise<BuilderDeploymentState> {
    return this.publisher.terminalize({
      context: this.requireDeploymentContext(),
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
      // A team project publishes through Workers Builds: nothing here is waiting for production.
      if (this.state.publicationPending) {
        this.setState({ ...this.state, publicationPending: false });
      }
      return;
    }
    const snapshot = validated ?? (await this.workspace.checkpoint().catch(() => null));
    if (!snapshot || this.automaticPublicationStopped(epoch)) {
      return;
    }
    if (snapshot.revision === this.state.productionRevision) {
      if (this.state.publicationPending) {
        this.setState({ ...this.state, publicationPending: false });
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
    await this.scheduleAutomaticDeployment(snapshot, 0, epoch);
  }

  /**
   * Whether automatic publication work noted at `epoch` must not start: the project is being deleted, a
   * turn is running or starting (its end publishes), or a new turn stopped the automatic publications.
   */
  private automaticPublicationStopped(epoch: number): boolean {
    return (
      this.destroying ||
      this.closed ||
      Boolean(this.state.activeTurn) ||
      this.startingTurns > 0 ||
      epoch !== this.publicationEpoch
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
    if (this.automaticPublicationStopped(epoch) || live.some((fiber) => fiber.name === DEPLOYMENT_FIBER)) {
      return;
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
    const stopping = [...this.runningPublications].filter((publication) => publication.automatic);
    if (stopping.length === 0) {
      return;
    }
    for (const publication of stopping) {
      publication.controller.abort(new PublicationSupersededError());
    }
    await settledWithin(
      stopping.map((publication) => publication.settled),
      PUBLICATION_STOP_WAIT_MS,
    );
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
    if (job.revision === this.state.productionRevision) {
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
    // A retry redoes a deployment that failed, so only another one deploying it now stops it.
    const inFlight = () => {
      const current = this.state.deployment;
      return (
        current?.revision === job.revision &&
        (options.retry ? current.status === 'deploying' : current.status !== 'ready')
      );
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
    // Admission can wait out an upgrade: whatever changed meanwhile decides again. A retry also stops
    // for a fiber still deploying the revision, which a failure recorded meanwhile may hide; one started
    // while that is read shows as deploying by the time it answers.
    if (refused() || (options.retry && (await this.deploymentFibersRunning(job.revision)) > 0) || refused()) {
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
          await this.trackPublication(
            run.automatic,
            fiber.signal,
            async (signal) => {
              // The execution it ran last, the one whose record a throw may leave holding the project.
              let execution: DeploymentExecution | undefined;
              try {
                // Counted busy while it runs, whatever later rewrites the deployment record. A stop while
                // it still waits for an upgrade window calls it off before it starts.
                // A deployment that fails throws: the executor never returns a failed one.
                await this.runtimeActivity.run(
                  () =>
                    this.runDeployment(job, signal, (running) => {
                      execution = running;
                    }),
                  { signal },
                );
              } catch (error) {
                if (execution) {
                  await this.scheduleDeploymentRecordSettle({ ...job, ...execution });
                }
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
    await this.hydrateDurableIdentity();
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

  /**
   * A deployment that threw may leave its record holding the project's deployment slot: one promoted
   * whose success write didn't land stays deploying, a claim whose acknowledgement was lost may have
   * committed, and a failure write may not have landed. Only a deployment of the same revision settles
   * it otherwise, so once this fiber has ended its record is settled whatever revision the project has
   * moved on to: the execution that threw, never a later one of the record.
   */
  private async scheduleDeploymentRecordSettle(record: DeploymentRecordSettle): Promise<void> {
    if (this.destroying) {
      return;
    }
    await this.schedule(DEPLOYMENT_RECORD_SETTLE_DELAY_SECONDS, 'settleDeploymentRecord', record, {
      idempotent: true,
    }).catch(() => logger.warn('Unable to schedule settling the deployment record'));
  }

  /**
   * Settles the execution a deployment fiber that threw left holding its record, unless a deployment of
   * its revision runs again.
   */
  async settleDeploymentRecord(payload: DeploymentRecordSettle): Promise<void> {
    const record = deploymentRecordSettleSchema.safeParse(payload).data;
    if (!record) {
      return;
    }
    await this.hydrateDurableIdentity();
    const context = this.deploymentContext();
    if (!context || this.destroying) {
      return;
    }
    const { deploymentId, executionGeneration, ...job } = record;
    const settle = () =>
      this.publisher.settle({
        context,
        deploymentId,
        executionGeneration,
      });
    // Admission can wait out an upgrade window, or D1 being unavailable: a deployment of the revision
    // started meanwhile runs on.
    const settled = await this.runtimeActivity
      .run(async () => ((await this.deploymentFibersRunning(job.revision)) > 0 ? null : this.retry(settle)))
      .catch(() => {
        logger.warn('Unable to settle the deployment record');
        return null;
      });
    if (settled?.settled && settled.deployment.status === 'succeeded') {
      // Production serves it: it was promoted before its success could be recorded. A record found
      // succeeded was settled by a later execution, which a later deployment may have replaced since.
      await this.recordDeploymentSucceeded(job, settled.deployment);
    }
  }

  /**
   * Settle the deployment record holding the project's deployment slot, which refused the record
   * `deploymentId` of `job`, when nothing is running it: no other fiber here deploys its revision, and
   * it has shown no sign of work for a while. It may be of `job`'s own revision, planned under the id it
   * had before. It settles as an interrupted one does, as succeeded when production serves it.
   * Answers null when the slot is still held; otherwise `serves`, the record it settled as succeeded
   * when that is `job`'s own revision, which production then already serves, or null when the refused
   * deployment is worth trying again.
   */
  private async settleBlockingDeployment(
    job: DeploymentJob,
    deploymentId: string | null,
  ): Promise<{ serves: BuilderDeploymentState | null } | null> {
    const context = this.deploymentContext();
    if (!context) {
      return null;
    }
    const blocking = await findActiveProjectDeployment(this.env.DB, {
      userId: context.userId,
      projectId: this.workspace.projectId,
    });
    if (
      !blocking ||
      blocking.id === deploymentId ||
      Date.now() - blocking.lastActiveAt < BLOCKING_DEPLOYMENT_STALE_MS ||
      // This deployment's own fiber deploys `job`'s revision, under another record.
      (await this.deploymentFibersRunning(blocking.revision)) > (blocking.revision === job.revision ? 1 : 0)
    ) {
      return null;
    }
    const blockingJob: DeploymentJob = { workspaceRevision: blocking.workspaceRevision, revision: blocking.revision };
    // Only the execution seen holding the slot: one started since is left to run.
    const settled = await this.publisher.settle({
      context,
      deploymentId: blocking.id,
      executionGeneration: blocking.executionGeneration,
    });
    if (settled.settled && settled.deployment.status === 'succeeded') {
      if (blocking.revision === job.revision) {
        return { serves: settled.deployment };
      }
      await this.recordDeploymentSucceeded(blockingJob, settled.deployment);
    }
    return settled.deployment.status === 'succeeded' || settled.deployment.status === 'failed'
      ? { serves: null }
      : null;
  }

  /** Interrupted fibers count: their recovery hook, not the readiness check, settles them. */
  private async deploymentFibersRunning(revision: string): Promise<number> {
    const live = await this.listFibers({ name: DEPLOYMENT_FIBER, status: ['pending', 'running', 'interrupted'] });
    return live.filter((fiber) => deploymentJobSchema.safeParse(fiber.metadata).data?.revision === revision).length;
  }

  private async runDeployment(
    job: DeploymentJob,
    abortSignal: AbortSignal,
    onExecution: (execution: DeploymentExecution) => void,
  ): Promise<BuilderDeploymentState> {
    const context = this.requireDeploymentContext();
    const startedAt = Date.now();
    // Validation changes nothing in production: however a stop cuts it short, it is a stop.
    await this.buildCheckpoint(
      job,
      `${deploymentToolCallId(job.workspaceRevision, job.revision)}:validation`,
      abortSignal,
    ).catch((error) => {
      throw abortSignal.aborted ? abortSignal.reason : error;
    });
    let planned: string | null = null;
    const deploy = () =>
      this.withPublicationActivity((onPlanned) =>
        this.keepAliveWhile(() =>
          this.publisher.deploy({
            context,
            workspace: this.workspace,
            toolCallId: deploymentToolCallId(job.workspaceRevision, job.revision),
            validatedRevision: job.revision,
            onPlanned: (deploymentId) => {
              planned = deploymentId;
              onPlanned(deploymentId);
            },
            onExecution,
            abortSignal,
          }),
        ),
      );
    const deployment = await deploy().catch(async (error) => {
      // Another record holds the project: another revision's, or this one's under an earlier plan's id.
      // One nothing runs any more would refuse every deployment for good, since only a deployment of
      // its own revision and id settles it otherwise.
      const settled =
        error instanceof DeploymentConcurrencyLimitError
          ? await this.settleBlockingDeployment(job, planned).catch(() => null)
          : null;
      if (!settled) {
        throw error;
      }
      // This revision's record under an earlier plan was promoted: production already serves it.
      return settled.serves ?? deploy();
    });
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
    await this.recordProductionRevision(job.revision, { ...deployment, ...job });
  }

  /**
   * Commits the workspace to main of this app's own repository, while it holds `revision`: the commit, or
   * null when the workspace has moved on (or moved while it was read). A tree main already has is not
   * committed again: main's head is the answer, `unchanged`.
   */
  private async commitWorkspaceToHistory(args: {
    revision: string;
    message: string;
  }): Promise<{ hash: string; unchanged: boolean } | null> {
    const transcript = this.transcriptBinding;
    if (!transcript) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const checkpoint = await this.workspace.checkpoint();
    if (checkpoint.revision !== args.revision) {
      return null;
    }
    const read = await workspaceCommitFiles(this.workspace);
    if (!read || read.targetRevision !== checkpoint.workspaceRevision) {
      return null;
    }
    const repositories = this.repositories();
    const repo = nativeProjectRepo(transcript.chatInitialId);
    const author = await commitAuthor(this.env);
    // Two commits can race for main (a publish's and a production request's): the loser goes again on top.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parent = await repositories.head(repo);
      const result = await repositories.commitFiles({
        repo,
        branch: MAIN_BRANCH,
        parent,
        files: read.files,
        message: args.message,
        author,
      });
      if ('commit' in result) {
        return { hash: result.commit, unchanged: result.unchanged === true };
      }
    }
    throw new Error('main of the project repository kept moving.');
  }

  /** Who a publication runs for and the chat it records, once this agent knows its identity. */
  private deploymentContext(): BuilderDeploymentContext | null {
    return this.userId && this.transcriptBinding
      ? { env: this.env, userId: this.userId, chatInitialId: this.transcriptBinding.chatInitialId }
      : null;
  }

  private requireDeploymentContext(): BuilderDeploymentContext {
    const context = this.deploymentContext();
    if (!context) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    return context;
  }

  /**
   * Production serves this revision now; the publication a turn asked for is done once it is the current one.
   * The deployment that put it there, if given, is recorded in the same write, so no stop falls between them.
   */
  private async recordProductionRevision(revision: string, deployment?: BuilderDeploymentState): Promise<void> {
    const current = await this.workspace.checkpoint().catch(() => null);
    const recordsDeployment = deployment !== undefined && this.state.deployment?.revision === revision;
    this.setState({
      ...this.state,
      deployment: recordsDeployment ? deployment : this.state.deployment,
      productionRevision: revision,
      productionUrl: deployment?.productionUrl ?? this.state.productionUrl ?? null,
      publicationPending: current?.revision === revision ? false : this.state.publicationPending,
    });
  }

  private failDeployment(job: DeploymentJob, error: unknown): void {
    this.setDeploymentResult(job, { status: 'failed', ...job, error: deploymentErrorMessage(error) });
  }

  private setDeploymentResult(job: DeploymentJob, deployment: BuilderDeploymentState | null): void {
    if (this.state.deployment?.revision !== job.revision) {
      return;
    }
    this.setState({ ...this.state, deployment });
  }

  /**
   * The last automatic deployment failure of a CloudChef app, or the warning a succeeded deployment
   * carries for a step after it went live, for the model to act on.
   */
  private publicationFailure(): string | null {
    const deployment = this.state.deployment;
    if (deployment?.status === 'failed' && deployment.error) {
      return `the production deployment of the latest changes failed. ${deployment.error}`;
    }
    if (deployment?.status === 'succeeded' && deployment.error) {
      return `the production deployment of the latest changes went live. ${deployment.error}`;
    }
    return null;
  }

  /** Builds the exact checkpoint a deployment was asked for, showing the build's stages while it runs. */
  private async buildCheckpoint(
    snapshot: BuilderWorkspaceCheckpoint,
    toolCallId: string,
    abortSignal?: AbortSignal,
  ): Promise<BuilderWorkspaceCheckpoint> {
    const needsBuild = !(await this.workspace.hasSuccessfulValidation(snapshot.revision));
    if (needsBuild) {
      this.setValidationProgress(toolCallId, 'computer validation');
    }
    try {
      return await this.keepAliveWhile(() =>
        buildCheckpointForBuilder({
          workspace: this.workspace,
          requestedSnapshot: { workspaceRevision: snapshot.workspaceRevision, revision: snapshot.revision },
          toolCallId,
          onStage: (stage) => this.setValidationProgress(toolCallId, stage),
          abortSignal,
        }),
      );
    } finally {
      if (needsBuild) {
        this.setValidationProgress(toolCallId, null);
      }
    }
  }

  private async refreshDeploymentReadiness(): Promise<BuilderWorkspaceCheckpoint | null> {
    // A team project deploys through Workers Builds: CloudChef's deployment record stays empty.
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
    if (deployment?.status === 'deploying' && (await this.deploymentFibersRunning(snapshot.revision)) === 0) {
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
  private async withPublicationActivity<T>(run: (onPlanned: (deploymentId: string) => void) => Promise<T>): Promise<T> {
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
        const progress = latest ? publicationProgress(latest) : null;
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
      if (this.state.publication) {
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
/** How long a turn's start waits for a team project's addresses before going on without them. */
const SITE_NOTE_TIMEOUT_MS = 5_000;

/**
 * Puts CloudChef's own notes for this turn (the last automatic publication's failure, a team project's
 * addresses) ahead of the turn's workspace context.
 */
function withNotes(
  turnContext: ChatTurnContext | undefined,
  notes: readonly (string | null)[],
): ChatTurnContext | undefined {
  const written = notes.filter((note): note is string => Boolean(note));
  if (written.length === 0) {
    return turnContext;
  }
  const content = [...written, ...(turnContext?.content ? [turnContext.content] : [])].join('\n\n');
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

/**
 * Whether a seed failed with words for the person, shown with Try again rather than retried behind a
 * reconnect: the control plane refused (no access, an import GitHub refused) or said GitHub can't be reached,
 * the copy was refused, impossible or broke off, or the project's answer could not be read. Only an error
 * without such words (the network, a crash in the workspace) is thrown on, and the browser reconnects; a
 * repeated import of a large project behind ten silent reconnects would only take longer to say the same.
 */
function isSeedRefusal(error: Error): boolean {
  return (
    error instanceof ProjectRefusalError ||
    error instanceof ProjectUnavailableError ||
    error instanceof ProjectAccessError ||
    error instanceof z.ZodError ||
    error instanceof ProjectRepositoryError
  );
}

function deploymentErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Deployment failed.';
}

const CLOUDFLARE_API_IDENTITY_CHANGED =
  'Cloudflare API requests are unavailable or the authenticated connection changed.';

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

/** Whether every one of `promises` settled within `timeoutMs`. */
async function settledWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}
