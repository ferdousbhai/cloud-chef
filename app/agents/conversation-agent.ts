import {
  Agent,
  callable,
  type Connection,
  type ConnectionContext,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
} from 'agents';
import { PiHarness, ROOT_SESSION, type PiHarnessContext, type PiOperationResult } from 'agents/harness/pi';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { copyJson } from '@earendil-works/chord';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import {
  createRegistry,
  Harness,
  ProviderDoc,
  type Conversation,
  type EntryRecord,
  type ModelRef,
  type UserInput,
} from '@earendil-works/pi-durable';
import { abortableSleep } from '~/lib/abortable-sleep';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import {
  completeBuilderTurn,
  createBuilderTurn,
  type BuilderTurnState,
  type BuilderTurnStatus,
} from './builder-turn-state';
import { chatTurnContextSchema, type ChatTurnContext } from 'cloudchef-agent/turn-context';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
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
import { markWorkspaceStarted } from '~/lib/cloudflare/data/workspace-repository.server';
import {
  setGeneratedProjectDescription,
  setGeneratedConversationDescription,
  setHeuristicProjectDescriptionIfMissing,
  setHeuristicConversationDescriptionIfMissing,
} from '~/lib/cloudflare/data/workspace-service.server';
import { getToolInvocation, replaceToolCallPart, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import {
  advanceTranscriptCheckpoint,
  transcriptChatInitialId,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import {
  loadBuilderTranscriptBinding,
  loadConversationScope,
  recordAppAdoption,
  requireBuilderRequestScope,
  requireBuilderTranscriptIdentity,
  type BuilderTranscriptBinding,
} from './builder-request-policy';
import { initializeConversationAgentSchema } from './conversation-agent-schema';
import {
  BuilderRuntimeActivity,
  isConversationAgentBusy,
  RuntimeUpgradeWaitExceededError,
} from './builder-runtime-activity';
import { rethrowAgentRejection } from './conversation-agent-rejection';
import {
  ConversationAgentIdentityMismatchError,
  ConversationAgentIdentityRepository,
  conversationAgentIdentitiesEqual,
  type ConversationAgentDurableIdentity,
} from './conversation-agent-identity';
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
  revertChanges,
  seedLinkedWorkspace,
  workspaceCommitFiles,
} from './linked-project-workspace';
import { LINKED_BUILD_WATCH_MS } from '~/lib/common/linked-publish';
import {
  linkedBuildSettledResult,
  linkedBuildStartedResult,
  linkedBuildStatus,
  linkedBuildUnfollowedResult,
  linkedBuildWatchSchema,
  watchLinkedBuild,
  withLinkedBuildResult,
  type LinkedBuildWatch,
} from './linked-project-build';
import { ADOPTED_APP_MESSAGE } from '~/lib/common/adopted-app';
import {
  appAdoption,
  ensureProjectRepository,
  openProject,
  ProjectAccessError,
  ProjectRefusalError,
  ProjectUnavailableError,
  projectBuildStatus,
  projectSite,
  commitAuthor,
  requestProductionReview,
  type ProductionRequestOutcome,
} from '~/lib/.server/cloudflare/linked-project-client';
import {
  MAIN_BRANCH,
  nativeProjectRepo,
  ProjectRepositories,
  ProjectRepositoryError,
  filesMatchTree,
  workspaceFileMode,
  type RepositoryFileInput,
} from '~/lib/.server/cloudflare/project-repository';
import { ZERO_OID } from '~/lib/.server/cloudflare/repository-wire';
import { WORK_DIR } from 'cloudchef-agent/constants';
import { bytesToBase64 } from '~/lib/hex-digest';
import {
  BUILDER_TURN_INACTIVITY_MS,
  BUILDER_TURN_WALL_CLOCK_MS,
  BuilderTurnLimitError,
} from '~/lib/.server/llm/builder-turn-limits';
import { createBuilderTools } from '~/lib/.server/llm/builder-tools';
import { createWorkersAiTools } from '~/lib/.server/llm/workers-ai-tools';
import { builderModels } from '~/lib/.server/llm/builder-models';
import { getPiModel, type ModelHandle, type WorkersAiAccountCredentials } from '~/lib/.server/llm/pi-ai-models';
import { createBuilderSkillContext } from '~/lib/.server/llm/builder-skills';
import { systemPrompt } from 'cloudchef-agent/prompts/system';
import {
  contextTokens,
  handoffOpening,
  handoffThresholdTokens,
  hasWorkToHandOff,
  isOverflow,
  writeHandoffNote,
} from '~/lib/.server/llm/handoff';
import { withTurnContext } from '~/lib/.server/llm/turn-context';
import { providerFailureText } from '~/lib/.server/llm/provider-failure-text';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';
import { BUILDER_SETTINGS, BuilderChatStream, builderExtension } from './builder-pi';
import { CHAT_ENTRY, toolOutputEntryData, userEntryData } from './builder-chat-view';
import { dropLegacyChatTables, readLegacyMessages } from './legacy-chat';
import type { BuilderModel, BuilderModelId, BuilderReasoningLevel } from '~/lib/workers-ai-model';
import { deriveProvisionalTitle, shouldGenerateConversationTitle, type TitleSubject } from '~/lib/title-generation';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS, MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import { z } from 'zod';
import { isRecord } from 'cloudchef-agent/utils/isRecord';
import type { DeploymentExecution } from '~/server-handlers/deployments';
import { toolSuccess, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { reviewDomainChange } from './cloudflare-domain-review';
import {
  BuilderCloudflareExecutionRepository,
  cloudflareChangeAnswer,
  cloudflareExecutionStatusForOutcome,
  isCloudflareExecutionTerminal,
  publicExecutionState,
  safeCloudflareExecutionOutcome,
  sameCloudflareConnectionIdentity,
  type CloudflareExecutionBinding,
} from './builder-cloudflare-execution';
import {
  cloudflareApiRequestIsRead,
  CloudflareApiRequestRejectedError,
  cloudflareApiRequestSchema,
  normalizeCloudflareApiRequest,
  type CloudflareApiRequest,
  type CloudflareExecutionDecisionResult,
  type CloudflareExecutionPublicState,
  type CloudflareExecutionSafeOutcome,
  type CloudflareRequestFiled,
  type CloudflareRequestFinalResult,
} from 'cloudchef-agent/cloudflare-api';
import { cloudflareApiErrorBody, type CloudflareChangeAnswer } from '~/lib/.server/cloudflare/cloudflare-api-proxy';
import { fileTeamCloudflareChange, TEAM_FILED_ANSWER } from '~/lib/.server/cloudflare/team-cloudflare-approvals';
import {
  readCloudflareApiRuntimeIdentity,
  type RuntimeConnectionIdentity,
  runtimeConnectionIdentity,
} from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { CloudflareApiClient } from '~/lib/.server/cloudflare/cloudflare-api-client';
import {
  confirmUserWorkspaceAccess,
  modelRequestAccess,
  postRuntimeRoute,
  readAccountModelSettings,
  reportUserWorkspaceModelUsage,
  resolveUserWorkspaceCloudflareAccessToken,
} from '~/lib/.server/cloudflare/user-workspace-cloudflare-credential';
import { workersAiGatewayLogging, type WorkersAiGatewayLogging } from '~/lib/.server/llm/workers-ai-gateway';
import { recordModelResponse, turnUsage, type ModelTurnUsage } from '~/lib/.server/llm/workers-ai-telemetry';
import type { Usage } from '@earendil-works/pi-ai';
import { requireBuilderModel, requireBuilderReasoningLevel } from '~/lib/.server/llm/workers-ai-model-catalog';

const logger = createScopedLogger('ConversationAgent');

/** A change `cf` asked for that is answered at once, in Cloudflare's error shape so `cf` prints why. */
function refusedChange(status: number, message: string): CloudflareChangeAnswer {
  return { kind: 'answer', status, body: cloudflareApiErrorBody(message) };
}

/**
 * The tool-call identity every publication of one validated revision shares. Deployment and its
 * recovery resolve to the same deterministic deployment plan because they name the same checkpoint here.
 */
function deploymentToolCallId(workspaceRevision: number, revision: string): string {
  return `deploy-command:${workspaceRevision}:${revision}`;
}

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
 * account. The ConversationAgent harness replaces them, as it replaces the ProjectWorkspace.
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

const cloudflareExecutionDecisionSchema = z.object({ executionId: z.string().uuid() }).strict();

const workspaceCloudflareChangeSchema = z.object({
  toolCallId: z.string().min(1).max(512),
  request: cloudflareApiRequestSchema,
});
const WORKSPACE_CHANGE_REFUSAL = 'This workspace can’t change the Cloudflare account.';
/** A change whose proxy hasn't asked about it for this long has no command waiting for it any more. */
const CLOUDFLARE_CHANGE_WAITER_TIMEOUT_MS = 15_000;
const TEAM_APPROVAL_NOTE =
  'This changes the team’s Cloudflare account. One of the team’s admins approves or rejects it on their Approvals ' +
  'page; approving sends this exact request once.';
/** The changes a command filed for the team's admins, in its output: each one waiting, or what they decided. */
const commandChangesSchema = z.looseObject({ cloudflareChanges: z.array(z.unknown()) });
/** One of them still waiting for the team's admins. */
const filedChangeSchema = z.object({ kind: z.literal('cloudflare_request_filed'), approvalId: z.string() });
const commandOutputPartSchema = z.object({ output: commandChangesSchema });
const approvalOutcomeSchema = z.object({
  agentName: z.string(),
  toolCallId: z.string(),
  requestSha256: z.string(),
  status: z.enum(['pending', 'sending', 'done', 'rejected', 'expired']),
  result: z.enum(['succeeded', 'failed', 'indeterminate']).nullable(),
  outcome: z
    .object({
      status: z.enum(['success', 'failure', 'insufficient_scope', 'indeterminate', 'denied']),
      summary: z.string(),
      content: z.string().optional(),
      requestId: z.string().nullable().optional(),
      httpStatus: z.number().nullable().optional(),
      truncated: z.boolean().optional(),
      sensitiveContentWithheld: z.boolean().optional(),
    })
    .nullable(),
});
const cloudflareExecutionFiberSchema = z
  .object({ executionId: z.string().uuid(), proposalSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
type CloudflareExecutionFiberJob = z.infer<typeof cloudflareExecutionFiberSchema>;

/** Steering text arrives over the agent connection while a turn is already running. */
const steeringRequestSchema = z.object({ text: z.string(), turnContext: chatTurnContextSchema.optional() });

/** A message the person sends: its text, the turn's workspace context, and the model and effort they chose. */
const builderMessageInputSchema = z.object({
  text: z.string(),
  turnContext: chatTurnContextSchema.optional(),
  requestId: z.string().max(512).optional(),
  modelId: z.unknown(),
  reasoningLevel: z.unknown().optional(),
  transcript: z.unknown(),
});
export type BuilderMessageInput = {
  text: string;
  turnContext?: ChatTurnContext;
  requestId?: string;
  modelId: BuilderModelId;
  reasoningLevel?: BuilderReasoningLevel;
  transcript: TranscriptIdentity;
};

/** The model a turn chose, as the agent keeps it to resume the turn's run after a restart. */
export type BuilderTurnModel = {
  modelId: BuilderModelId;
  reasoningLevel: BuilderReasoningLevel | undefined;
  contentLogging: boolean;
  gatewayKeyRevision: string | undefined;
};

/** How often a running turn checks its overall time limit and whether it has gone quiet. */
const TURN_LIMIT_CHECK_MS = 15_000;

/** No model at all, for the moments no turn has chosen one: a request then fails `no_model`. */
const NO_MODELS: Models = createModels();

const titleGenerationJobSchema = z.object({
  chatInitialId: z.string().min(1),
  firstPrompt: z.boolean(),
  prompt: z.string().min(1).max(TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS),
  promptGeneration: z.number().int().min(1),
  subchatIndex: z.number().int().min(0),
});
type TitleGenerationJob = z.infer<typeof titleGenerationJobSchema>;

export type ConversationAgentState = {
  activeTurn?: BuilderTurnState | null;
  generatedSubchatTitle?: {
    subchatIndex: number;
    title: string;
    updatedAt: string;
  } | null;
  lastCompletedTurn?: BuilderTurnState | null;
  /** The model the running turn chose, kept so a restarted agent resumes the run with it. */
  turnModel?: BuilderTurnModel | null;
  /** Why the last turn failed, in words for the person; cleared when the next one starts. */
  turnError?: string | null;
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
   * Why the last turn's push to main did not go live: the workspace held changes main doesn't. Told to the
   * model at its next turn, and cleared once a publication starts.
   */
  heldPublication?: string | null;
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
  cloudflareExecutions?: CloudflareExecutionPublicState[];
  /** The team project this workspace works on, once it's prepared; null for a CloudChef app. */
  linkedProject?: BuilderLinkedProjectSummary | null;
  linkedSite?: BuilderLinkedSite | null;
  /**
   * A newer conversation in the chat continues the project, so this one is kept to read: only the newest
   * conversation changes the project. Also set for an app a team adopted as one of its projects.
   */
  conversationClosed?: boolean;
  /** An admin approved this CloudChef app as a draft: it is the team's project now, changed only from there. */
  conversationAdopted?: boolean;
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
 * The site a team or uploaded project's workspace shows beside the chat: the newest preview this conversation
 * made, else the live site; with whether it may be framed (null until CloudChef checked).
 */
export type BuilderLinkedSite = { url: string; frameable: boolean | null; kind: 'live' | 'preview' };

/**
 * What a conversation hands the newer one that continues its project: where production stands and
 * where it serves, and whether a publication is still owed. The newer conversation publishes from then on.
 */
type BuilderPublicationHandover = Pick<
  ConversationAgentState,
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
type ConversationAgentProps = { userId: string };

export class ConversationAgent extends Agent<Env, ConversationAgentState, ConversationAgentProps> {
  static override options = {
    sendIdentityOnConnect: false,
  };

  initialState: ConversationAgentState = {
    activeTurn: null,
    generatedSubchatTitle: null,
    lastCompletedTurn: null,
    turnModel: null,
    turnError: null,
    validationProgress: null,
    deployment: null,
    productionRevision: null,
    productionUrl: null,
    publicationPending: false,
    heldPublication: null,
    failedPublicationRevision: null,
    publication: null,
    upgradeWaiting: false,
    cloudflareExecutions: [],
    linkedProject: null,
    linkedSite: null,
    conversationClosed: false,
  };

  /** The extensions pi runs with; one registry per object, as pi keeps a Harness subscribed to it. */
  private readonly registry = createRegistry();
  /** pi-durable on this object's SQLite: the transcript, runs, tool calls and their recovery, woken by Lifecycle. */
  protected readonly piHarness = new PiHarness({ harness: (context) => this.openPi(context) });
  /** The model the current turn runs with, as pi-ai `Models`, and the handle its handoff note is written with. */
  protected turnModels: { handle: ModelHandle; models: Models; ref: ModelRef } | null = null;
  /** Stops the turn being started, while it waits for an upgrade or the workspace. */
  private startingTurnAbort: AbortController | null = null;
  /** The turns this instance waits for the end of. */
  private readonly turnWatches = new Set<string>();
  /** When the conversation last committed anything: the turn's inactivity watch reads it. */
  private lastChatActivity = Date.now();
  /** The chat as the browser shows it, sent to every connected browser as it changes. */
  private readonly chat = new BuilderChatStream({
    harness: () => this.piHarness.pi(),
    conversation: () => this.piHarness.conversation(ROOT_SESSION),
    events: () => this.piHarness.session(ROOT_SESSION).events(),
    send: (frame) => this.broadcast(frame),
    onActivity: () => {
      this.lastChatActivity = Date.now();
    },
  });
  private readonly identityRepository: ConversationAgentIdentityRepository;
  private readonly cloudflareExecutions: BuilderCloudflareExecutionRepository;
  /** Changes each running command filed for the team's admins, in order, until that command's output takes them. */
  private readonly filedCloudflareChanges = new Map<string, CloudflareRequestFiled[]>();
  /** When the proxy holding each waiting change last asked about it, by execution: a change no one waits for is not sent. */
  private readonly waitingCloudflareChanges = new Map<string, number>();
  private readonly workspace: BuilderWorkspaceApi;
  private userId: string | null = null;
  private transcriptBinding: BuilderTranscriptBinding | null = null;
  private readonly publisher = builderPublisher;
  /** The account's project repositories (Artifacts); the ConversationAgent harness replaces it with a fake. */
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
    initializeConversationAgentSchema(ctx);
    this.identityRepository = new ConversationAgentIdentityRepository(ctx.storage);
    this.cloudflareExecutions = new BuilderCloudflareExecutionRepository(ctx.storage);
    this.workspace = new UserWorkspaceRuntimeClient(
      env,
      () => this.workspaceProjectId(),
      () => this.userId,
      () => this.name,
    );
    this.runtimeActivity = new BuilderRuntimeActivity({
      db: env.DB,
      agentName: () => this.name,
    });
    this.lifecycle.use(this.piHarness);
  }

  /**
   * The chat's one project, which every conversation in it works on: the workspace (and so the Worker and
   * resources named after it) is keyed on the chat, by the id of its first conversation's agent.
   */
  private workspaceProjectId(): string {
    const chatInitialId = this.transcriptBinding?.chatInitialId ?? transcriptChatInitialId(this.name);
    return this.env.ConversationAgent.idFromName(chatInitialId).toString();
  }

  override onStateChanged(state: ConversationAgentState | undefined): void {
    void this.runtimeActivity.observe(isConversationAgentBusy(state));
  }

  async onStart(props?: ConversationAgentProps) {
    if (props) {
      await this.initializeIdentity(props);
    } else {
      await this.hydrateDurableIdentity();
    }
    this.refreshCloudflareExecutionState();
    // A team admin may have decided a change this conversation filed while CloudChef couldn't reach it.
    if (this.userId) {
      this.ctx.waitUntil(
        this.settleFiledTeamApprovals().catch(() => logger.warn('Unable to read back filed team approvals')),
      );
    }
    if (this.state.upgradeWaiting) {
      // The turn that waited stopped with the instance before it started.
      this.setState({ ...this.state, upgradeWaiting: false });
    }
    if (this.userId) {
      await this.convertLegacyChat();
      await this.chat.start();
      this.resumeTurn();
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
   * A chat from before pi-durable: its messages move once into the transcript, shown only, and the conversation
   * goes on in a fresh context (`legacy-chat.ts`).
   */
  private async convertLegacyChat(): Promise<void> {
    const legacy = readLegacyMessages(this.ctx.storage.sql);
    if (legacy.length > 0) {
      const conversation = await this.piHarness.conversation(ROOT_SESSION);
      const first = await conversation.entries({ order: 'ascending' }, 1, undefined, BACKGROUND_CONTEXT);
      if (first.items[0]?.kind !== CHAT_ENTRY.legacy) {
        await conversation.commit(async (tx) => {
          for (const message of legacy) {
            await tx.appendEntry(conversation.id, { kind: CHAT_ENTRY.legacy, data: { message } });
          }
        }, BACKGROUND_CONTEXT);
      }
    }
    dropLegacyChatTables(this.ctx.storage.sql);
  }

  /** A turn this instance recorded before it stopped: wait for its run again, or end it if it never reached pi. */
  private resumeTurn(): void {
    const turn = this.state.activeTurn;
    if (!turn) {
      return;
    }
    if (turn.operationId) {
      this.watchTurn(turn.id);
      return;
    }
    this.setState({ ...this.state, turnError: 'The builder was interrupted. Please send your message again.' });
    this.ctx.waitUntil(this.endTurn(turn, 'error').catch(() => logger.warn('Unable to end the interrupted turn')));
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
       FROM conversations AS transcripts
       INNER JOIN workspaces ON workspaces.id = transcripts.workspace_id
       WHERE transcripts.agent_name = ? AND workspaces.creator_id = ? AND workspaces.is_deleted = 1
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
      this.cloudflareExecutions.recoverIndeterminate(job.executionId, job.proposalSha256);
      this.refreshCloudflareExecutionState();
      return {
        status: 'error',
        error: 'The approved Cloudflare execution was interrupted and will not be replayed.',
      };
    }
    return super.onFiberRecovered(ctx);
  }

  /**
   * The person sent a message. Refused before anything is stopped or recorded when it can't start; otherwise
   * recorded as the active turn and handed to pi-durable, which runs it. Resolves once pi has saved it: the chat
   * shows the run as it goes, from the agent's chat stream. A message sent while a turn runs joins it instead.
   */
  @callable()
  async sendMessage(input: BuilderMessageInput): Promise<{ accepted: true }> {
    const durableIdentity = await this.requireDurableIdentity('chat_message');
    const parsed = builderMessageInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Response('Invalid message', { status: 400 });
    }
    const text = parsed.data.text.trim();
    if (!text || text.length > MAX_USER_MESSAGE_CHARACTERS) {
      throw new Response('Invalid message', { status: 400 });
    }
    if (this.state.activeTurn) {
      await this.steerActiveTurn({ text, turnContext: parsed.data.turnContext });
      return { accepted: true };
    }
    // A conversation a newer one took over is kept to read: only the newest one changes the project. So is an app
    // a team adopted as one of its projects.
    await this.learnAdoption();
    await this.refuseIfClosed();
    const { chatInitialId, subchatIndex, transcript, modelId, reasoningLevel } = requireBuilderRequestScope(
      parsed.data,
      durableIdentity.transcript,
    );
    const { accountCredentials, model, gatewayKeyRevision, chosenReasoningLevel } = await this.chooseModel(
      durableIdentity.userId,
      modelId,
      reasoningLevel,
    );
    // The model reads what became of any change this conversation filed for the team's admins.
    await this.settleFiledTeamApprovals().catch(() => logger.warn('Unable to read back filed team approvals'));
    const siteNote = this.linkedSiteNote();
    // From the stop until the turn is recorded active, no automatic publication may start: this turn's end publishes.
    this.startingTurns += 1;
    let turn: BuilderTurnState;
    let started = false;
    try {
      // The person is talking to the builder again: the publication of the last turn must not hold the workspace
      // this turn edits. It publishes again, with this turn's changes, when this turn ends.
      await this.stopAutomaticPublications();
      await markWorkspaceStarted(this.env.DB, {
        sessionId: durableIdentity.userId,
        chatId: chatInitialId,
        agentName: transcript.agentName,
      });
      turn = createBuilderTurn(parsed.data.requestId);
      this.setState({ ...this.state, activeTurn: turn, turnError: null });
      started = true;
    } finally {
      this.startingTurns -= 1;
      if (!started) {
        // It stopped the automatic publications and failed before it began: nothing ends to publish them.
        this.publishAfterInterruptedTurn();
      }
    }
    const publicationFailure = this.publicationFailure();
    if (this.state.heldPublication) {
      // Said once: a later turn that pushed nothing to main has nothing held to be told about.
      this.setState({ ...this.state, heldPublication: null });
    }
    const turnContext = withNotes(parsed.data.turnContext, [
      publicationFailure &&
        `CloudChef publication status: ${publicationFailure.slice(-MAX_PUBLICATION_FAILURE_CHARACTERS)}`,
      await siteNote,
    ]);
    const shown = await this.chat.messages();
    const userMessages = shown.filter((message) => message.role === 'user').length + 1;
    console.info({ event: 'builder_chat_turn_started', firstUserMessage: userMessages === 1 });
    const starting = new AbortController();
    this.startingTurnAbort = starting;
    try {
      // Before any model work: a Worker upgrade that found this workspace idle a moment ago lands first. An upgrade
      // that keeps its window open too long fails the turn.
      // A Stop calls the wait off.
      await this.runtimeActivity
        .admit({
          signal: starting.signal,
          maxWaitMs: TURN_UPGRADE_WAIT_MS,
          onWaiting: (waiting) => this.setUpgradeWaiting(waiting),
        })
        .catch((error: Error) => {
          throw error instanceof RuntimeUpgradeWaitExceededError ? new Response(error.message, { status: 503 }) : error;
        });
      // Again now that the turn is visible: a newer conversation that took over meanwhile either saw this turn and
      // stopped it, or closed this one before this read.
      await this.refuseIfClosed();
      const { contentLogging } = await this.requireModelAccess();
      // The browser prepares the workspace before it sends, but nothing else seeds a new one.
      await this.initializeWorkspace(durableIdentity.transcript);
      await this.nameGitRepository(chatInitialId);
      if (shouldGenerateConversationTitle(text, userMessages)) {
        await this.scheduleTitleGeneration(
          {
            chatInitialId,
            firstPrompt: userMessages === 1,
            prompt: text.slice(0, TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS),
            promptGeneration: userMessages,
            subchatIndex,
          },
          accountCredentials,
          workersAiGatewayLogging(contentLogging),
        );
      }
      const turnModel: BuilderTurnModel = {
        modelId,
        reasoningLevel: chosenReasoningLevel,
        contentLogging,
        gatewayKeyRevision,
      };
      this.useModel(turnModel, accountCredentials, model);
      this.setState({ ...this.state, turnModel });
      const conversation = await this.piHarness.conversation(ROOT_SESSION);
      const current = this.requireTurnModels();
      await conversation.configure(
        { model: current.ref, thinkingLevel: chosenReasoningLevel ?? 'off' },
        BACKGROUND_CONTEXT,
      );
      const content = withTurnContext(text, turnContext);
      // A conversation already near the limit starts the turn from a handoff note, so the turn has room to work.
      await this.handOffIfNeeded('turn_start', Math.ceil(content.length / 4));
      const receipt = await this.piHarness.submit(content, {
        operationId: `turn:${turn.id}`,
        entry: { kind: CHAT_ENTRY.user, data: userEntryData(text) },
      });
      starting.signal.throwIfAborted();
      this.updateTurn(turn.id, { operationId: receipt.operationId });
      this.watchTurn(turn.id);
    } catch (error) {
      if (this.isActiveTurn(turn.id)) {
        this.finishTurn(turn, { status: 'error' });
        this.publishAfterInterruptedTurn();
      }
      throw error;
    } finally {
      if (this.startingTurnAbort === starting) {
        this.startingTurnAbort = null;
      }
    }
    return { accepted: true };
  }

  /** The model the person chose, as the account allows it, with the effort they chose for it. */
  protected async chooseModel(
    userId: string,
    modelId: BuilderModelId,
    reasoningLevel: BuilderReasoningLevel | undefined,
  ): Promise<{
    accountCredentials: WorkersAiAccountCredentials;
    model: BuilderModel;
    gatewayKeyRevision: string | undefined;
    chosenReasoningLevel: BuilderReasoningLevel | undefined;
  }> {
    const accountCredentials = await getUserWorkersAiCredentials(this.env, userId);
    const { model, gatewayKeyRevision } = await requireBuilderModel(accountCredentials.binding, modelId, () =>
      readAccountModelSettings(this.env),
    );
    return {
      accountCredentials,
      model,
      gatewayKeyRevision,
      chosenReasoningLevel: requireBuilderReasoningLevel(model, reasoningLevel),
    };
  }

  private setUpgradeWaiting(waiting: boolean): void {
    if (Boolean(this.state.upgradeWaiting) !== waiting) {
      this.setState({ ...this.state, upgradeWaiting: waiting });
    }
  }

  /** Opens pi-durable over this object's SQLite, with the builder's tools, system prompt and model. */
  private async openPi({ storage, context, onWake }: PiHarnessContext): Promise<Harness> {
    // A run a restart cut off resumes with the model its turn chose; a new turn sets its own.
    if (this.state.activeTurn && this.state.turnModel && !this.turnModels) {
      await this.restoreTurnModel(this.state.turnModel).catch(() =>
        logger.warn('Unable to restore the model of the interrupted turn'),
      );
    }
    this.registry.install(
      builderExtension({
        tools: createBuilderTools(
          createWorkersAiTools(
            this.workspace,
            {
              onValidationStage: (toolCallId, stage) => this.setValidationProgress(toolCallId, stage),
              pushResult: (toolCallId) => this.gitPushResult(toolCallId),
              cloudflareChanges: async (toolCallId) => this.settleCommandCloudflareChanges(toolCallId),
              runWithKeepAlive: (operation) => this.keepAliveWhile(operation),
            },
            { read: async (path) => (await this.skillContext()).reader.read(path) },
          ),
        ),
        systemPrompt: async () => {
          const linkedProject = await this.linkedProjectSummary();
          return systemPrompt((await this.skillContext()).prompt, linkedProject);
        },
        afterResponse: (message) => this.reportModelUsage(recordModelResponse(message)),
        afterTools: async () => {
          if (await this.handOffIfNeeded('step', 0)) {
            const turn = this.state.activeTurn;
            if (turn) {
              this.updateTurn(turn.id, { continueAfterHandoff: true });
            }
          }
        },
      }),
    );
    return Harness.open(
      storage,
      {
        models: () => this.turnModels?.models ?? NO_MODELS,
        registry: this.registry,
        settings: BUILDER_SETTINGS,
        identity: { attribution: null },
        onWake,
        onReport: (_error, info) => logger.warn('pi-durable reported a failure', { type: info.type }),
      },
      context,
    );
  }

  private async skillContext() {
    return createBuilderSkillContext({ linkedProject: (await this.linkedProjectSummary()) !== undefined });
  }

  protected useModel(turnModel: BuilderTurnModel, credentials: WorkersAiAccountCredentials, model: BuilderModel): void {
    const transcript = this.transcriptBinding;
    const handle = getPiModel(credentials, turnModel.modelId, {
      model,
      // When the person allows logging, the turn's requests are found in the account's AI Gateway logs by chat (its
      // URL id) and member; otherwise they are neither logged nor labelled.
      gatewayLogging: workersAiGatewayLogging(
        turnModel.contentLogging,
        transcript && this.userId
          ? { chat: transcript.chatInitialId, user: this.userId, agent: transcript.agentName }
          : undefined,
      ),
      gatewayKeyRevision: turnModel.gatewayKeyRevision,
    });
    this.turnModels = { handle, ...builderModels(handle) };
  }

  /** The model a turn chose, again after a restart, so pi can go on with the run it cut off. */
  protected async restoreTurnModel(turnModel: BuilderTurnModel): Promise<void> {
    const userId = this.userId ?? this.identityRepository.get()?.userId;
    if (!userId) {
      return;
    }
    const credentials = await getUserWorkersAiCredentials(this.env, userId);
    const { model } = await requireBuilderModel(credentials.binding, turnModel.modelId, () =>
      readAccountModelSettings(this.env),
    );
    this.useModel(turnModel, credentials, model);
  }

  private requireTurnModels(): NonNullable<ConversationAgent['turnModels']> {
    if (!this.turnModels) {
      throw new Error('The turn has no model.');
    }
    return this.turnModels;
  }

  /**
   * Near the model's context limit, the model writes a handoff note and the conversation is reset to it: the work
   * goes on in a fresh context that starts from the system prompt, the note and the person's latest request. By
   * pi-durable's own accounting: the newest response's reported usage and what came after it, against the model's
   * window. `extraTokens` is what is about to be sent. Whether it handed off.
   */
  private async handOffIfNeeded(at: 'turn_start' | 'step', extraTokens: number): Promise<boolean> {
    const handle = this.turnModels?.handle;
    if (!handle) {
      return false;
    }
    const conversation = await this.piHarness.conversation(ROOT_SESSION);
    const { messages } = await conversation.context(BACKGROUND_CONTEXT);
    if (
      !hasWorkToHandOff(messages) ||
      contextTokens(messages) + extraTokens < handoffThresholdTokens(handle.model.contextWindow, at)
    ) {
      return false;
    }
    await this.handOff(conversation, messages, handle);
    return true;
  }

  private async handOff(conversation: Conversation, messages: readonly Message[], handle: ModelHandle): Promise<void> {
    const harness = await this.piHarness.pi();
    const provider = await harness.snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT);
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    const note = await writeHandoffNote({
      handle,
      messages,
      budgetTokens: handoffThresholdTokens(handle.model.contextWindow, 'step'),
      reasoning: agent.thinkingLevel,
      // The conversation's own provider session, so the note is written from the cached prefix.
      sessionId: provider?.sessionId ?? `${this.name}:handoff`,
      onUsage: (usage) => this.reportModelUsage(turnUsage(usage)),
    });
    // Shown in the chat where the conversation went on from it; the reset is what the model sees.
    await conversation.submit(
      { type: 'write', entry: { kind: CHAT_ENTRY.handoff, data: { note } } },
      BACKGROUND_CONTEXT,
    );
    await conversation.reset(handoffOpening(note), BACKGROUND_CONTEXT);
    console.info({ event: 'builder_handoff', noteCharacters: note.length });
  }

  private isActiveTurn(turnId: string): boolean {
    return this.state.activeTurn?.id === turnId;
  }

  private updateTurn(turnId: string, change: Partial<BuilderTurnState>): void {
    const turn = this.state.activeTurn;
    if (turn?.id === turnId) {
      this.setState({ ...this.state, activeTurn: { ...turn, ...change } });
    }
  }

  /**
   * Waits for the active turn's run to settle, in the background and keeping the object alive, then ends the turn.
   * A handoff that ended the run sends the person's latest request again; a context overflow hands off and does so
   * once. A restarted agent calls this again for the turn it recorded.
   */
  private watchTurn(turnId: string): void {
    if (this.turnWatches.has(turnId)) {
      return;
    }
    const watch = this.runtimeActivity
      .run(() => this.keepAliveWhile(() => this.followTurn(turnId)))
      .catch(() => {
        logger.warn('Unable to follow the turn to its end');
        const turn = this.state.activeTurn;
        if (turn?.id === turnId) {
          this.setState({ ...this.state, turnError: 'The builder was interrupted. Please send your message again.' });
          return this.endTurn(turn, 'error');
        }
      })
      .finally(() => this.turnWatches.delete(turnId));
    this.turnWatches.add(turnId);
    this.ctx.waitUntil(watch);
  }

  private async followTurn(turnId: string): Promise<void> {
    const limits = new AbortController();
    const turnStart = this.state.activeTurn?.startedAt ?? Date.now();
    // pi-durable bounds each model request; the host keeps only a turn's overall limit, and a watch on a run that
    // shows no progress at all between its tool calls.
    const timer = setInterval(() => {
      const reason =
        Date.now() - turnStart > BUILDER_TURN_WALL_CLOCK_MS
          ? 'wall_clock'
          : Date.now() - this.lastChatActivity > BUILDER_TURN_INACTIVITY_MS && !this.chat.toolRunning()
            ? 'inactivity'
            : null;
      if (reason && !limits.signal.aborted) {
        limits.abort(new BuilderTurnLimitError(reason));
      }
    }, TURN_LIMIT_CHECK_MS);
    try {
      for (;;) {
        const turn = this.state.activeTurn;
        if (turn?.id !== turnId || !turn.operationId) {
          return;
        }
        const result = await this.waitForOperation(turn.operationId, limits.signal);
        const current = this.state.activeTurn;
        if (current?.id !== turnId) {
          // A Stop ended it already.
          return;
        }
        if (result === 'limit') {
          const reason = limits.signal.reason;
          this.setState({
            ...this.state,
            turnError: reason instanceof Error ? reason.message : 'The builder stopped.',
          });
          await this.piHarness.abort();
          await this.endTurn(current, 'error');
          return;
        }
        if (current.continueAfterHandoff) {
          await this.continueAfterHandoff(current);
          continue;
        }
        if (result.status === 'unanswered' && result.reason === 'model_error' && !current.overflowHandedOff) {
          if (await this.handOffAfterOverflow()) {
            this.updateTurn(turnId, { overflowHandedOff: true });
            await this.continueAfterHandoff({ ...current, overflowHandedOff: true });
            continue;
          }
        }
        const status: BuilderTurnStatus =
          result.status === 'done' ? 'completed' : result.reason === 'aborted' ? 'aborted' : 'error';
        if (status === 'error') {
          this.setState({ ...this.state, turnError: await this.runFailureText(result.reason) });
        }
        await this.endTurn(current, status);
        return;
      }
    } finally {
      clearInterval(timer);
    }
  }

  private async waitForOperation(operationId: string, signal: AbortSignal): Promise<PiOperationResult | 'limit'> {
    try {
      return await this.piHarness.wait(operationId, { signal });
    } catch (error) {
      if (signal.aborted) {
        return 'limit';
      }
      throw error;
    }
  }

  /** The person's latest request, sent again after a handoff, as the model saw it the first time. */
  private async continueAfterHandoff(turn: BuilderTurnState): Promise<void> {
    const request = await this.latestRequest();
    this.updateTurn(turn.id, { continueAfterHandoff: false });
    if (!request) {
      return;
    }
    const receipt = await this.piHarness.submit(request, {
      operationId: `continue:${turn.id}:${crypto.randomUUID()}`,
      entry: { kind: CHAT_ENTRY.continued },
    });
    this.updateTurn(turn.id, { operationId: receipt.operationId });
  }

  private async latestRequest(): Promise<UserInput | null> {
    const conversation = await this.piHarness.conversation(ROOT_SESSION);
    let cursor: Parameters<Conversation['entries']>[2];
    do {
      const page = await conversation.entries({}, 50, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        if (entry.kind === CHAT_ENTRY.user) {
          const message = entry.model?.find((item) => item.role === 'user');
          return message?.role === 'user' ? message.content : null;
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return null;
  }

  /** The provider said the context was too long: hand off from what fits, so the request is sent again once. */
  private async handOffAfterOverflow(): Promise<boolean> {
    const handle = this.turnModels?.handle;
    if (!handle) {
      return false;
    }
    const conversation = await this.piHarness.conversation(ROOT_SESSION);
    const view = await conversation.context(BACKGROUND_CONTEXT);
    const failed = lastResponse(view.entries);
    if (!failed || !isOverflow(failed, handle.model.contextWindow) || !hasWorkToHandOff(view.messages)) {
      return false;
    }
    const { messages } = view;
    await this.handOff(conversation, messages, handle);
    return true;
  }

  /** What the chat says about a run that failed: the provider's own words where it gave some. */
  private async runFailureText(reason: string | undefined): Promise<string> {
    if (reason !== 'model_error') {
      return reason === 'no_model'
        ? 'No model was available for this turn. Choose one and send again.'
        : 'The turn failed.';
    }
    const conversation = await this.piHarness.conversation(ROOT_SESSION);
    const { entries } = await conversation.context(BACKGROUND_CONTEXT);
    const errorText = lastResponse(entries)?.errorMessage ?? '';
    return isWorkersAiFreeAllocationError(new Error(errorText))
      ? workersPaidRequiredMessage()
      : providerFailureText(errorText);
  }

  /** The turn's run settled: record how, and publish what it pushed. */
  protected async endTurn(turn: BuilderTurnState, status: BuilderTurnStatus): Promise<void> {
    this.finishTurn(turn, { status });
    const validatedSnapshot = await this.refreshDeploymentReadiness();
    // A turn that pushed a CloudChef app's main, or one before it whose publication never reached production,
    // publishes it however the turn ended: the deployment builds the exact revision (unless the model already
    // validated it) and publishes it to production. A team project previews and deploys through Workers Builds,
    // when the agent pushes or publishes to it.
    if (this.state.publicationPending) {
      await this.publishLatestRevision(validatedSnapshot);
    }
  }

  /** A message the person sent while the turn runs: it joins the running work after the current round of tool calls. */
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
    if (!this.state.activeTurn) {
      throw new Response('The builder is not currently running.', { status: 409 });
    }
    await this.refuseIfClosed();
    await this.piHarness.submit(withTurnContext(text, steering.data.turnContext), {
      whenBusy: 'steer',
      entry: { kind: CHAT_ENTRY.user, data: userEntryData(text) },
    });
    return { accepted: true };
  }

  @callable()
  async approveCloudflareExecution(input: { executionId: string }): Promise<CloudflareExecutionDecisionResult> {
    const parsed = cloudflareExecutionDecisionSchema.safeParse(input);
    if (!parsed.success) {
      throw new Response('Invalid Cloudflare execution decision.', { status: 400 });
    }
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
    // Sent only while the command that asked still waits for it: its proxy asks again every few seconds.
    const asked = this.waitingCloudflareChanges.get(proposal.executionId);
    if (asked === undefined || Date.now() - asked > CLOUDFLARE_CHANGE_WAITER_TIMEOUT_MS) {
      this.cloudflareExecutions.withdraw(proposal.toolCallId, proposal.executionId);
      this.refreshCloudflareExecutionState();
      throw new Response('The command that asked for this change has stopped, so it wasn’t sent.', { status: 409 });
    }
    await this.startFiber(
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
    return { execution: publicExecutionState(execution) };
  }

  @callable()
  async rejectCloudflareExecution(input: { executionId: string }): Promise<CloudflareExecutionDecisionResult> {
    const parsed = cloudflareExecutionDecisionSchema.safeParse(input);
    if (!parsed.success) {
      throw new Response('Invalid Cloudflare execution decision.', { status: 400 });
    }
    const binding = await this.requireCurrentCloudflareExecutionBinding('reject_cloudflare_execution');
    const { record } = await this.cloudflareExecutions.reject(parsed.data.executionId, binding);
    this.refreshCloudflareExecutionState();
    return { execution: publicExecutionState(record) };
  }

  /**
   * The person pressed Stop: the running validation is cancelled and pi-durable aborts the run (queued messages are
   * withdrawn, running tool calls are aborted), resolving once nothing more runs. What the run did stays in the chat.
   */
  @callable()
  async cancelActiveTurn(): Promise<{ stopped: boolean }> {
    const activeTurn = this.state.activeTurn;
    const validationCancellation = this.workspace.cancelActiveValidation();
    // A turn still starting stops where it is.
    this.startingTurnAbort?.abort(new DOMException('Cancelled by the project owner', 'AbortError'));
    if (activeTurn) {
      this.finishTurn(activeTurn, { status: 'aborted' });
    }
    await this.piHarness.abort();
    await validationCancellation;
    if (activeTurn) {
      // Its end found no turn to finish, so nothing redid the publication it stopped.
      this.publishAfterInterruptedTurn();
    }
    return { stopped: activeTurn !== null };
  }

  /** The whole chat, as the browser shows it; sent to each browser that connects, and again on request. */
  @callable()
  async getChatFrame(): Promise<string> {
    await this.requireDurableIdentity('chat_frame');
    return this.chat.snapshotFrame();
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    await super.onConnect(connection, ctx);
    if (this.transcriptBinding) {
      connection.send(await this.chat.snapshotFrame());
    }
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
    // The running turn stops, and pi-durable resolves the abort once nothing more runs.
    await this.cancelActiveTurn();
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
    return settledWithin([...this.runningSaves], timeoutMs);
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
    const { closed, deleted, adoptedBy } = await loadConversationScope(this.env.DB, {
      agentName: this.name,
      ownerId,
    });
    if (deleted) {
      return DELETED_CONVERSATION_MESSAGE;
    }
    if (adoptedBy) {
      return ADOPTED_APP_MESSAGE;
    }
    return closed ? CLOSED_CONVERSATION_MESSAGE : null;
  }

  /**
   * In a team's account, asks CloudChef whether an admin has approved this CloudChef app as a draft: its repository
   * is then the team project's, so its workspace is recorded as kept to read (`adopted_by_org_project_id`). Asked
   * before anything here changes the app's repository or publishes it.
   */
  private async learnAdoption(): Promise<void> {
    const identity = runtimeConnectionIdentity(this.env);
    const transcript = this.transcriptBinding;
    if (this.env.CLOUDCHEF_SHARED_ACCOUNT !== '1' || !identity || !transcript || !this.userId) {
      return;
    }
    const ownerId = this.userId;
    const scope = await loadConversationScope(this.env.DB, { agentName: this.name, ownerId });
    if (scope.orgProjectId || scope.adoptedBy || scope.deleted) {
      return;
    }
    const orgProjectId = await appAdoption(this.env, identity, nativeProjectRepo(transcript.chatInitialId));
    if (orgProjectId) {
      await recordAppAdoption(this.env.DB, { agentName: this.name, ownerId, orgProjectId });
    }
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
    // Sent again once approved, it would commit this workspace over what the team has done since.
    await this.learnAdoption();
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
    await this.learnAdoption();
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
   * whether a newer conversation continues the project or a team adopted this app as one of its projects, so it
   * offers nothing here that would change it.
   */
  private async publishWorkspaceSummary(): Promise<void> {
    const linked = await this.workspace.linkedProject();
    this.showLinkedProject(
      linked
        ? { repository: linked.name ?? linked.repository, repo: linked.repository, defaultBranch: linked.defaultBranch }
        : null,
    );
    if (linked && this.state.linkedSite?.kind !== 'preview') {
      void this.showLiveSite(linked.orgProjectId);
    }
    if (!linked) {
      await this.learnAdoption().catch(() => logger.warn('Unable to ask whether a team adopted this app'));
    }
    const scope =
      this.userId === null
        ? null
        : await loadConversationScope(this.env.DB, { agentName: this.name, ownerId: this.userId });
    const adopted = scope?.adoptedBy != null;
    const closed = scope !== null && (scope.closed || adopted);
    if ((this.state.conversationClosed ?? false) !== closed || (this.state.conversationAdopted ?? false) !== adopted) {
      this.setState({ ...this.state, conversationClosed: closed, conversationAdopted: adopted });
    }
  }

  /** The project's live site, shown beside the chat; what was shown stays when it can't be looked up. */
  private async showLiveSite(orgProjectId: string): Promise<void> {
    const identity = runtimeConnectionIdentity(this.env);
    if (!identity) {
      return;
    }
    const site = await projectSite(this.env, identity, orgProjectId, SITE_NOTE_TIMEOUT_MS).catch(() => null);
    if (site) {
      this.showLinkedSite(site.live ? { url: site.live, frameable: site.frameable, kind: 'live' } : null);
    }
  }

  private showLinkedSite(next: BuilderLinkedSite | null): void {
    const current = this.state.linkedSite ?? null;
    if (current?.url === next?.url && current?.frameable === next?.frameable && current?.kind === next?.kind) {
      return;
    }
    this.setState({ ...this.state, linkedSite: next });
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
    this.ctx.waitUntil(this.startUndeployedVersion());
    await this.refreshDeploymentReadiness();
    return state;
  }

  /**
   * For a project CloudChef deploys itself, the deploy of its latest version when none was started: an upload whose
   * deploy didn't start, or a push from a workspace that hadn't been upgraded yet. Asking for one already claimed
   * does nothing.
   */
  private async startUndeployedVersion(): Promise<void> {
    try {
      const linked = await this.workspace.linkedProject();
      const identity = runtimeConnectionIdentity(this.env);
      if (!linked || !identity || !this.env.PROJECT_BUILDER) {
        return;
      }
      const project = await openProject(this.env, identity, linked.orgProjectId);
      // A push that lands after the head is read claims its own commit, and wins over this one.
      const headReadAt = Date.now();
      const head =
        project.deploysWith === 'cloudchef' && project.repo ? await this.repositories().head(project.repo) : null;
      if (head) {
        await this.env.PROJECT_BUILDER.get(this.env.PROJECT_BUILDER.idFromName(linked.orgProjectId)).enqueue({
          orgProjectId: linked.orgProjectId,
          branch: MAIN_BRANCH,
          commit: head,
          headReadAt,
        });
      }
    } catch {
      logger.warn('Unable to start the deploy of the latest version');
    }
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
    await this.learnAdoption();
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

  /**
   * The chat as the browser shows it, with a checkpoint of it: its message count as its revision, which a subchat
   * records as where it branched off.
   */
  @callable()
  async getTranscriptSnapshot(identityValue: TranscriptIdentity): Promise<BuilderTranscriptSnapshot> {
    const identity = requireBuilderTranscriptIdentity(identityValue, this.transcriptBinding);
    const messages = await this.chat.messages();
    if (messages.length === 0) {
      return { checkpoint: null, messages };
    }
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, messages);
    return { checkpoint: { ...checkpoint, revision: messages.length }, messages };
  }

  /**
   * Internal Worker RPC used by the authenticated transcript reload endpoint.
   * Direct namespace RPCs do not carry Agent connection props, so initialize
   * the same owner-scoped context before reading the durable transcript.
   */
  async getTranscriptSnapshotForOwner(
    identityValue: TranscriptIdentity,
    ownerId: string,
  ): ReturnType<ConversationAgent['getTranscriptSnapshot']> {
    await this.initializeIdentity({ userId: ownerId });
    return this.getTranscriptSnapshot(identityValue);
  }

  private async initializeIdentity(props: ConversationAgentProps): Promise<void> {
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
    const identity: ConversationAgentDurableIdentity = { userId: props.userId, transcript: transcriptBinding };
    try {
      this.identityRepository.claim(identity);
    } catch (error) {
      if (error instanceof ConversationAgentIdentityMismatchError) {
        this.rejectIdentity('connection_identity_mismatch');
      }
      throw error;
    }
    // Only the identity: `onStart` runs this inside the SDK's startup lock, which Cloudflare resets after 30
    // seconds, and a seed can take minutes. `prepareWorkspace` and a turn seed the workspace outside it.
    this.applyIdentity(identity);
  }

  /** The stored identity, applied, or null when none is stored or it no longer names the active transcript. */
  private async hydrateDurableIdentity(): Promise<ConversationAgentDurableIdentity | null> {
    const stored = await this.readDurableIdentity();
    return stored === 'missing' || stored === 'stale' ? null : stored;
  }

  /** The stored identity, applied; a missing or stale one rejects the request. */
  private async requireDurableIdentity(reason: string, incidentId?: string): Promise<ConversationAgentDurableIdentity> {
    const stored = await this.readDurableIdentity();
    if (stored === 'missing') {
      this.rejectIdentity(`${reason}_missing`, incidentId, 401);
    }
    if (stored === 'stale') {
      this.rejectIdentity(`${reason}_stale`, incidentId);
    }
    return stored;
  }

  private async readDurableIdentity(): Promise<ConversationAgentDurableIdentity | 'missing' | 'stale'> {
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
      !conversationAgentIdentitiesEqual(stored, { userId: stored.userId, transcript: activeTranscript })
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

  private applyIdentity(identity: ConversationAgentDurableIdentity): void {
    if (
      (this.userId && this.userId !== identity.userId) ||
      (this.transcriptBinding &&
        !conversationAgentIdentitiesEqual({ userId: identity.userId, transcript: this.transcriptBinding }, identity))
    ) {
      this.rejectIdentity('memory_identity_mismatch');
    }
    this.userId = identity.userId;
    this.transcriptBinding = identity.transcript;
  }

  private rejectIdentity(reason: string, incidentId: string = crypto.randomUUID(), status = 404): never {
    logger.error('Rejected ConversationAgent durable identity', {
      incidentId,
      reason,
    });
    throw new Response(status === 401 ? 'Agent authentication is required.' : 'Agent not found.', { status });
  }

  protected async scheduleTitleGeneration(
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
    // A team or imported project's workspace goes by the project's own name, so only an app of one's own is named.
    const namesProject =
      args.firstPrompt && args.subchatIndex === 0 && !(await this.workspace.linkedProject().catch(() => null));
    const projectTitlePromise = namesProject ? generateTitle('project') : null;
    const provisionalTitle = args.firstPrompt ? deriveProvisionalTitle(args.prompt) : null;

    if (provisionalTitle) {
      try {
        const [, savedHeuristicSubchat] = await Promise.all([
          namesProject
            ? setHeuristicProjectDescriptionIfMissing(this.env.DB, {
                sessionId: ownerId,
                id: args.chatInitialId,
                description: provisionalTitle,
              })
            : Promise.resolve(false),
          setHeuristicConversationDescriptionIfMissing(this.env.DB, {
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
        const savedSubchatTitle = await setGeneratedConversationDescription(this.env.DB, {
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

  /** A team project's name and default branch, for the prompt; none for a CloudChef app. */
  private async linkedProjectSummary(): Promise<{ repository: string; defaultBranch: string } | undefined> {
    const linked = await this.workspace.linkedProject();
    return linked ? { repository: linked.name ?? linked.repository, defaultBranch: linked.defaultBranch } : undefined;
  }

  /**
   * Whether this CloudChef app's workspace holds exactly what main of its repository does, as git would see
   * it: a file main tracks counts whatever `.gitignore` says, and installed or built output never does.
   */
  private async workspaceMatchesMain(): Promise<boolean> {
    const transcript = this.transcriptBinding;
    const main = transcript
      ? await this.repositories()
          .readTreeAt(nativeProjectRepo(transcript.chatInitialId), MAIN_BRANCH)
          .catch(() => null)
      : null;
    if (!main) {
      return false;
    }
    const tracked = main.files.filter((file) => !isExcludedProjectPath(file.path));
    const read = await workspaceCommitFiles(this.workspace, new Set(tracked.map((file) => file.path))).catch(
      () => null,
    );
    return read !== null && (await filesMatchTree(read.files, tracked));
  }

  /**
   * A CloudChef app's push to main: its turn publishes it when it ends, which the model is told, with what
   * stops that while the workspace holds changes main doesn't.
   */
  private async appPushResult(): Promise<CloudChefToolResult | undefined> {
    const pushes = await this.workspace.takeGitPushes();
    if (!pushes.some((push) => push.ref === `refs/heads/${MAIN_BRANCH}` && push.newOid !== ZERO_OID)) {
      return undefined;
    }
    // Owed from the moment main moved, in the agent's durable state: the turn's end publishes it, and so does
    // an agent that restarted before it could. A team project publishes through Workers Builds instead.
    if (!this.state.publicationPending) {
      this.setState({ ...this.state, publicationPending: true });
    }
    return (await this.workspaceMatchesMain())
      ? toolSuccess('Pushed to main: CloudChef publishes it to the live site when this turn ends.')
      : toolSuccess(
          "Pushed to main, but the workspace holds changes main doesn't (not committed, or committed but not " +
            'pushed). Only what main holds goes live, and only once the workspace matches it: commit and push ' +
            'them before the turn ends, or the live site stays as it is.',
        );
  }

  /**
   * What the command `toolCallId` pushed to a team project's repository, reported as a publish is: its
   * default branch (it goes live) or else the last branch pushed (a preview), with its build followed in the
   * background. Nothing for a CloudChef app's pushes, or a command that pushed no branch.
   */
  private async gitPushResult(toolCallId: string): Promise<CloudChefToolResult | undefined> {
    const linked = await this.workspace.linkedProject();
    if (!linked) {
      return this.appPushResult();
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
    if (build?.state === 'success' && build.previewUrl) {
      // What was just built is what the workspace shows: the preview, or the live site once it is live.
      this.showLinkedSite({
        url: build.previewUrl,
        frameable: this.state.linkedSite?.frameable ?? null,
        kind: watch.live ? 'live' : 'preview',
      });
    }
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
    const messages = withLinkedBuildResult(await this.chat.messages(), watch.toolCallId, output, options);
    if (!messages) {
      return false;
    }
    await this.replaceToolOutput(watch.toolCallId, messages);
    return true;
  }

  /**
   * A finished call's output changed after it ended (a team build's result, an admin's decision): kept beside the
   * transcript as a display-only entry the chat shows in its place. The model saw the output as it was; it reads the
   * new one in that command's output when it next looks.
   */
  private async replaceToolOutput(toolCallId: string, messages: readonly CloudChefMessage[]): Promise<void> {
    const part = messages
      .flatMap((message) => message.parts)
      .map(getToolInvocation)
      .find((invocation) => invocation?.toolCallId === toolCallId && invocation.state === 'output-available');
    if (!part) {
      return;
    }
    const conversation = await this.piHarness.conversation(ROOT_SESSION);
    await conversation.submit(
      {
        type: 'write',
        entry: {
          kind: CHAT_ENTRY.toolOutput,
          data: toolOutputEntryData(toolCallId, copyJson(part.output ?? null, { omitUndefinedProperties: true })),
        },
      },
      BACKGROUND_CONTEXT,
    );
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
      const { origins } = await projectSite(this.env, identity, linked.orgProjectId, SITE_NOTE_TIMEOUT_MS);
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
  protected async requireModelAccess(): Promise<{ contentLogging: boolean }> {
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

  /**
   * A change `cf` asked for while this conversation's command `toolCallId` runs (the runtime's CloudflareApiProxy
   * asks). In the person's own account, or a team's for its admins, it waits in that command's place in the chat
   * until the person approves or rejects it; a team member's goes to the team's admins. The answer is for `cf`.
   */
  async proposeWorkspaceCloudflareChange(input: {
    toolCallId: string;
    request: CloudflareApiRequest;
  }): Promise<CloudflareChangeAnswer> {
    const parsed = workspaceCloudflareChangeSchema.safeParse(input);
    const account = runtimeConnectionIdentity(this.env);
    const transcript = this.transcriptBinding;
    if (!parsed.success || !account || !this.userId || !transcript) {
      return refusedChange(403, WORKSPACE_CHANGE_REFUSAL);
    }
    const { toolCallId } = parsed.data;
    let request: CloudflareApiRequest;
    try {
      request = normalizeCloudflareApiRequest(parsed.data.request, account.accountId);
    } catch (error) {
      if (!(error instanceof CloudflareApiRequestRejectedError)) {
        throw error;
      }
      return refusedChange(403, error.message);
    }
    if (cloudflareApiRequestIsRead(request)) {
      return refusedChange(400, 'Only changes wait for approval.');
    }
    const identity = await readCloudflareApiRuntimeIdentity(this.env, () => this.isOrganizationAdmin());
    if (!identity) {
      // A team's member: their changes go to the team's admins, and CloudChef sends what an admin approves.
      return account.userId === this.userId && this.env.CLOUDCHEF_SHARED_ACCOUNT === '1'
        ? this.fileTeamCloudflareChange(toolCallId, request, account, transcript)
        : refusedChange(403, WORKSPACE_CHANGE_REFUSAL);
    }
    if (identity.userId !== this.userId) {
      return refusedChange(403, WORKSPACE_CHANGE_REFUSAL);
    }
    const review = await reviewDomainChange(request, (path) => this.readCloudflareText(identity, path));
    if ('refusal' in review) {
      return refusedChange(403, review.refusal);
    }
    const record = await this.cloudflareExecutions.createProposal({
      toolCallId,
      binding: { ...identity, transcript },
      request,
      warning: review.warning,
    });
    if (!record) {
      // An earlier change of the same command still waits: this one is asked for again once that one is settled.
      return { kind: 'queued' };
    }
    this.refreshCloudflareExecutionState();
    return this.answerWaitingChange(record);
  }

  /** The answer for `cf`, noting that the proxy still waits when the change is not settled yet. */
  private answerWaitingChange(record: CloudflareExecutionPublicState): CloudflareChangeAnswer {
    const answer = cloudflareChangeAnswer(record);
    if (answer.kind === 'waiting') {
      this.waitingCloudflareChanges.set(record.executionId, Date.now());
    } else {
      this.waitingCloudflareChanges.delete(record.executionId);
    }
    return answer;
  }

  /** What became of a change the command `toolCallId` asked for: still waiting, or the answer for `cf`. */
  async workspaceCloudflareChangeOutcome(input: {
    toolCallId: string;
    executionId: string;
  }): Promise<CloudflareChangeAnswer> {
    const record = this.cloudflareExecutions.get(input.executionId);
    if (!record || record.toolCallId !== input.toolCallId) {
      return refusedChange(404, 'This change is not waiting for approval.');
    }
    if (record.status === 'awaiting_approval' && record.expiresAt <= Date.now()) {
      this.refreshCloudflareExecutionState();
      return this.answerWaitingChange(this.cloudflareExecutions.get(input.executionId) ?? record);
    }
    return this.answerWaitingChange(record);
  }

  /** The command that asked for a change stopped while it waited: it is never sent. */
  async withdrawWorkspaceCloudflareChange(input: { toolCallId: string; executionId: string }): Promise<void> {
    const record = this.cloudflareExecutions.get(input.executionId);
    if (
      record?.toolCallId === input.toolCallId &&
      this.cloudflareExecutions.withdraw(input.toolCallId, input.executionId)
    ) {
      this.refreshCloudflareExecutionState();
    }
  }

  /**
   * After a command ends: a change it left waiting is withdrawn, since nothing waits for its answer any more, and
   * the changes it filed for the team's admins are given for its output, where their decisions later land.
   */
  private settleCommandCloudflareChanges(toolCallId: string): CloudflareRequestFiled[] {
    if (this.cloudflareExecutions.withdraw(toolCallId)) {
      this.refreshCloudflareExecutionState();
    }
    const filed = this.filedCloudflareChanges.get(toolCallId) ?? [];
    this.filedCloudflareChanges.delete(toolCallId);
    return filed;
  }

  /**
   * A team member's change, filed for the team's admins. The member's workspace never holds the team account's
   * authorization: a change is checked and sent by CloudChef once an admin approves it. A command may file several.
   */
  private async fileTeamCloudflareChange(
    toolCallId: string,
    request: CloudflareApiRequest,
    identity: RuntimeConnectionIdentity,
    transcript: BuilderTranscriptBinding,
  ): Promise<CloudflareChangeAnswer> {
    const changes = this.filedCloudflareChanges.get(toolCallId) ?? [];
    const filed = await fileTeamCloudflareChange(
      this.env,
      identity,
      { source: 'agent', agentName: transcript.agentName, toolCallId, changeNumber: changes.length + 1 },
      request,
    );
    if (filed.kind === 'refused') {
      return filed.answer;
    }
    changes.push({
      kind: 'cloudflare_request_filed',
      status: 'awaiting_team_admin',
      approvalId: filed.approvalId,
      accountId: identity.accountId,
      request,
      riskNote: filed.warning ? `${filed.warning} ${TEAM_APPROVAL_NOTE}` : TEAM_APPROVAL_NOTE,
      expiresAt: filed.expiresAt,
      note:
        'Filed for the team’s admins, who approve or reject it on their Approvals page; CloudChef then sends it once. ' +
        'Its result replaces this one when they decide.',
    });
    this.filedCloudflareChanges.set(toolCallId, changes);
    return TEAM_FILED_ANSWER;
  }

  /** Reads back every change this conversation filed for the team's admins that still shows as waiting. */
  private async settleFiledTeamApprovals(): Promise<void> {
    const ownerId = this.userId;
    if (!ownerId) {
      return;
    }
    const waiting = (await this.chat.messages()).flatMap((message) =>
      message.parts.flatMap((part) => {
        const changes = commandOutputPartSchema.safeParse(part).data?.output.cloudflareChanges ?? [];
        return changes.flatMap((change) => {
          const filed = filedChangeSchema.safeParse(change);
          return filed.success ? [filed.data.approvalId] : [];
        });
      }),
    );
    for (const approvalId of waiting) {
      await this.settleTeamApproval({ approvalId, ownerId });
    }
  }

  /**
   * A team admin decided a change this conversation filed: its result replaces the filed change in the output of
   * the command that asked. Answers whether it did; the control plane is asked what was decided, so nothing the
   * caller says is taken on trust.
   */
  async settleTeamApproval(input: { approvalId: string; ownerId: string }): Promise<boolean> {
    const durable = await this.readDurableIdentity();
    const identity = runtimeConnectionIdentity(this.env);
    if (
      durable === 'missing' ||
      durable === 'stale' ||
      durable.userId !== input.ownerId ||
      identity?.userId !== input.ownerId
    ) {
      return false;
    }
    const answer = await postRuntimeRoute(this.env, identity, 'runtime-projects/approvals/outcome', {
      approvalId: input.approvalId,
    });
    const decided = approvalOutcomeSchema.safeParse(await answer.json().catch(() => null));
    if (!answer.ok || !decided.success || decided.data.agentName !== this.name) {
      return false;
    }
    const { status, result, outcome, toolCallId, requestSha256 } = decided.data;
    const final: CloudflareRequestFinalResult['status'] | null =
      status === 'done' ? result : status === 'rejected' || status === 'expired' ? status : null;
    if (!final) {
      return false;
    }
    const decision: CloudflareRequestFinalResult = {
      kind: 'cloudflare_request_final_result',
      executionId: input.approvalId,
      accountId: identity.accountId,
      proposalSha256: requestSha256,
      status: final,
      outcome: outcome ?? { status: 'denied', summary: 'No team admin decided before the request expired.' },
    };
    const messages = replaceToolCallPart(await this.chat.messages(), toolCallId, (part, invocation) => {
      if (invocation.toolName !== 'exec' || invocation.state !== 'output-available' || !isRecord(invocation.output)) {
        return null;
      }
      const changes = commandChangesSchema.safeParse(invocation.output).data?.cloudflareChanges;
      const at = changes?.findIndex(
        (change) => filedChangeSchema.safeParse(change).data?.approvalId === input.approvalId,
      );
      if (!changes || at === undefined || at < 0) {
        return null;
      }
      return { ...part, output: { ...invocation.output, cloudflareChanges: changes.with(at, decision) } };
    });
    if (messages) {
      await this.replaceToolOutput(toolCallId, messages);
    }
    return true;
  }

  /** A read of the account's API by its path below `/client/v4`: the response's text, or null when it fails. */
  private async readCloudflareText(identity: RuntimeConnectionIdentity, path: string): Promise<string | null> {
    try {
      const outcome = await this.createCloudflareApiClient(identity).send(
        { method: 'GET', url: `https://api.cloudflare.com/client/v4${path}` },
        new AbortController().signal,
      );
      return outcome.status === 'success' ? outcome.content : null;
    } catch {
      return null;
    }
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
      // Re-admitted as it is sent: a demoted admin or a replaced connection sends nothing.
      const current = await readCloudflareApiRuntimeIdentity(this.env, () => this.isOrganizationAdmin());
      if (!current || !sameCloudflareConnectionIdentity(current, binding)) {
        throw new Error('The Cloudflare connection changed before the approved change was sent.');
      }
      const executing = await this.cloudflareExecutions.beginExecution(job.executionId, binding);
      if (!executing) {
        return;
      }
      this.refreshCloudflareExecutionState();
      const outcome = await this.createCloudflareApiClient(binding).send(
        executing.request,
        new AbortController().signal,
      );
      this.cloudflareExecutions.complete(
        job.executionId,
        cloudflareExecutionStatusForOutcome(outcome),
        safeCloudflareExecutionOutcome(outcome),
      );
      this.refreshCloudflareExecutionState();
    } catch {
      const current = this.cloudflareExecutions.get(job.executionId);
      if (!current || isCloudflareExecutionTerminal(current.status)) {
        return;
      }
      const failure: CloudflareExecutionSafeOutcome = {
        status: 'failure',
        summary: 'The approved change could not be sent safely, so nothing was sent to Cloudflare.',
      };
      if (current.status === 'approved') {
        this.cloudflareExecutions.failApproved(job.executionId, failure);
      } else if (current.status === 'executing') {
        this.cloudflareExecutions.complete(job.executionId, 'failed', failure);
      } else {
        this.cloudflareExecutions.recoverIndeterminate(job.executionId, job.proposalSha256);
      }
      // The raw error text stays out of the log by policy (runtime-log-privacy); the durable
      // outcome record carries what happened, keyed by executionId.
      logger.warn('Cloudflare execution fiber settled without a provider success', {
        executionId: job.executionId,
      });
      this.refreshCloudflareExecutionState();
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
    // Production serves main: a workspace holding changes main doesn't would put live what no version holds.
    if (!(await this.workspaceMatchesMain())) {
      this.setState({
        ...this.state,
        publicationPending: false,
        heldPublication:
          "main was pushed, but the workspace holds changes that main doesn't (not committed, or committed but " +
          'not pushed), so nothing went live. Commit and push them to main to publish.',
      });
      return;
    }
    const failedBefore = this.state.failedPublicationRevision === snapshot.revision;
    if (options.resume && failedBefore) {
      // It failed to publish already and nothing has changed it since: the next turn's end tries again.
      return;
    }
    if (!this.state.publicationPending || failedBefore || this.state.heldPublication) {
      this.setState({
        ...this.state,
        publicationPending: true,
        failedPublicationRevision: null,
        heldPublication: null,
      });
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
    const repositories = this.repositories();
    const repo = nativeProjectRepo(transcript.chatInitialId);
    // What main holds that the workspace can't: files it tracks stay saved whatever `.gitignore` says, and its
    // symbolic links and submodules, which no workspace holds, go on as they are.
    const main = (await repositories.head(repo)) ? await repositories.readTreeAt(repo, MAIN_BRANCH) : null;
    const tracked = new Set(main?.files.map((file) => file.path) ?? []);
    const links: RepositoryFileInput[] = (main?.files ?? [])
      .filter((file) => file.mode === '120000' || file.mode === '160000')
      .map((file) => ({ path: file.path, mode: Number.parseInt(file.mode, 8), oid: file.oid }));
    const read = await workspaceCommitFiles(this.workspace, tracked);
    if (!read || read.targetRevision !== checkpoint.workspaceRevision) {
      return null;
    }
    const author = await commitAuthor(this.env);
    // Two commits can race for main (a publish's and a production request's): the loser goes again on top.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parent = await repositories.head(repo);
      const result = await repositories.commitFiles({
        repo,
        branch: MAIN_BRANCH,
        parent,
        files: [...read.files, ...links],
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
    if (this.state.heldPublication) {
      return this.state.heldPublication;
    }
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

/**
 * Whether a seed failed with words for the person, shown with Try again rather than retried behind a
 * reconnect: the control plane refused (no access, an import GitHub refused) or said GitHub can't be reached,
 * the copy was refused, impossible or broke off, or the project's answer could not be read. Only an error
 * without such words (the network, a crash in the workspace) is thrown on, and the browser reconnects; a
 * repeated import of a large project behind ten silent reconnects would only take longer to say the same.
 */
/** The newest model response in the context's entries, a failed one included (the model's own view leaves it out). */
function lastResponse(entries: readonly EntryRecord[]): AssistantMessage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.kind === 'pi.assistant' ? entries[index]?.model?.[0] : undefined;
    if (message?.role === 'assistant') {
      return message;
    }
  }
  return undefined;
}

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
