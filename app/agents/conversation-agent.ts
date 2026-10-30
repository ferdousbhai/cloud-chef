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
import { generateModelTitle } from '~/lib/.server/llm/workers-ai-title';
import { markWorkspaceStarted } from '~/lib/cloudflare/data/workspace-repository.server';
import {
  setGeneratedConversationDescription,
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
  linkWorkspaceToProject,
  loadConversationScope,
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
import { AgentRefusal, rethrowAgentRejection } from './conversation-agent-rejection';
import {
  ConversationAgentIdentityMismatchError,
  ConversationAgentIdentityRepository,
  conversationAgentIdentitiesEqual,
  type ConversationAgentDurableIdentity,
} from './conversation-agent-identity';
import type {
  BuilderWorkspaceApi,
  WorkspaceApplyChangesRequest,
  WorkspaceSyncPageRequest,
} from './builder-workspace-api';
import { UserWorkspaceRuntimeClient } from '~/lib/.server/cloudflare/user-workspace-runtime-client';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from '@cloudchef/user-workspace-runtime/protocol';
import { commitBuilderTemplate } from './builder-template';
import { WorkspaceSeedError, type WorkspaceSeedFailure } from './builder-workspace-seed';
import { isExcludedProjectPath, revertChanges, seedLinkedWorkspace } from './linked-project-workspace';
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
import {
  ensureProjectRepository,
  openProject,
  ProjectAccessError,
  ProjectRefusalError,
  ProjectUnavailableError,
  projectBuildStatus,
  projectSite,
  commitAuthor,
  nameChatProject,
  postReel,
  reelTarget,
  registerUploadedProject,
} from '~/lib/.server/cloudflare/linked-project-client';
import {
  BuilderReelRepository,
  makeReel,
  ReelRefusal,
  reelRequestSchema,
  workersAiSpeaker,
  type ReelDraftForChat,
  type ReelDraftPublicState,
  type ReelRequest,
} from './builder-reels';
import {
  importedProjectRepo,
  MAIN_BRANCH,
  ProjectRepositories,
  ProjectRepositoryError,
} from '~/lib/.server/cloudflare/project-repository';
import { ZERO_OID } from '~/lib/.server/cloudflare/repository-wire';
import { WORK_DIR } from 'cloudchef-agent/constants';
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
import { systemPrompt, type ProjectFacts } from 'cloudchef-agent/prompts/system';
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
import { mainMovedNote } from './main-moved-note';
import type { BuilderModel, BuilderModelId, BuilderReasoningLevel } from '~/lib/workers-ai-model';
import { deriveProvisionalTitle, shouldGenerateConversationTitle, type TitleSubject } from '~/lib/title-generation';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS, MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import { z } from 'zod';
import { isRecord } from 'cloudchef-agent/utils/isRecord';
import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { reviewDomainChange } from './cloudflare-domain-review';
import {
  BuilderCloudflareExecutionRepository,
  cloudflareChangeAnswer,
  cloudflareExecutionStatusForOutcome,
  chatCloudflareChange,
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
  type CloudflareCommandChange,
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

const TITLE_GENERATION_FIBER = 'background:title_generation';
const CLOUDFLARE_EXECUTION_FIBER = 'background:cloudflare_execution';
const LINKED_BUILD_FIBER = 'background:linked_build';
/** A cancelled turn settles its transcript a moment after it stops: a watched publish missing that long is gone. */
const LINKED_BUILD_MISSING_GRACE_MS = 30_000;
const LINKED_BUILD_LANDING_POLL_MS = 2_000;
const TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS = 4_000;
/**
 * How long a turn waits for a workspace upgrade to finish before it gives up with a message to send
 * again. An upgrade's window lapses five minutes after its last renewal, but one that keeps renewing it
 * must not hold a turn indefinitely.
 */
const TURN_UPGRADE_WAIT_MS = 3 * 60_000;
/**
 * How long a closed conversation waits for an editor save already under way before it reports that it has not
 * settled: a save is one compare-and-swap change set, well within this.
 */
const WORKSPACE_WRITES_SETTLE_MS = 2.5 * 60_000;
const CLOSED_CONVERSATION_MESSAGE = 'A newer chat continues this project. Open the newest chat to keep working.';
const DELETED_CONVERSATION_MESSAGE = 'This conversation was deleted.';

const revertRequestSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** Owner identifiers reach this Durable Object over RPC, so they are re-checked at every entry point. */
const transcriptOwnerIdSchema = z.string().min(1).max(512);

const cloudflareExecutionDecisionSchema = z.object({ executionId: z.string().uuid() }).strict();

const workspaceCloudflareChangeSchema = z.object({
  toolCallId: z.string().min(1).max(512),
  request: cloudflareApiRequestSchema,
});
const WORKSPACE_CHANGE_REFUSAL = 'This workspace can’t change the Cloudflare account.';
/**
 * A change whose proxy hasn't asked about it for this long has no command waiting for it any more: approving it
 * leaves it to the chat, and what Cloudflare answers reaches the agent in the command's output.
 */
const CLOUDFLARE_CHANGE_WAITER_TIMEOUT_MS = 15_000;
const TEAM_APPROVAL_NOTE =
  'This changes the team’s Cloudflare account. One of the team’s admins approves or rejects it on their Approvals ' +
  'page; approving sends this exact request once.';
/** The changes a command filed for the team's admins, in its output: each one waiting, or what they decided. */
const commandChangesSchema = z.looseObject({ cloudflareChanges: z.array(z.unknown()) });
/** One of them still waiting for the team's admins. */
const filedChangeSchema = z.object({ kind: z.literal('cloudflare_request_filed'), approvalId: z.string() });
/** One in the person's own account the command left waiting in the chat. */
const waitingInChatSchema = z.object({ kind: z.literal('cloudflare_change_waiting_in_chat'), executionId: z.string() });
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
  conversationIndex: z.number().int().min(0),
});
type TitleGenerationJob = z.infer<typeof titleGenerationJobSchema>;

export type ConversationAgentState = {
  activeTurn?: BuilderTurnState | null;
  generatedConversationTitle?: {
    conversationIndex: number;
    title: string;
    updatedAt: string;
  } | null;
  lastCompletedTurn?: BuilderTurnState | null;
  /** The model the running turn chose, kept so a restarted agent resumes the run with it. */
  turnModel?: BuilderTurnModel | null;
  /** Why the last turn failed, in words for the person; cleared when the next one starts. */
  turnError?: string | null;
  /**
   * What became of changes commands left waiting in the chat, decided since the model last ran, and restores
   * CloudChef refused because main moved elsewhere: told at its next turn.
   */
  untoldChanges?: string[];
  validationProgress?: {
    toolCallId: string;
    stage: BuilderValidationStage;
  } | null;
  /**
   * A turn is waiting for an upgrade of the workspace runtime to finish before it starts, for at most
   * a few minutes. The browser shows that the workspace is upgrading.
   */
  upgradeWaiting?: boolean;
  cloudflareExecutions?: CloudflareExecutionPublicState[];
  /** Clips for the project's post the agent made, each shown in the chat with Approve and Not now. */
  reels?: ReelDraftPublicState[];
  /** The project this workspace works on, once it's prepared. */
  linkedProject?: BuilderLinkedProjectSummary | null;
  linkedSite?: BuilderLinkedSite | null;
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
 * The site a team or uploaded project's workspace shows beside the chat: the newest preview this conversation
 * made, else the live site; with whether it may be framed (null until CloudChef checked).
 */
export type BuilderLinkedSite = { url: string; frameable: boolean | null; kind: 'live' | 'preview' };

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
    generatedConversationTitle: null,
    lastCompletedTurn: null,
    turnModel: null,
    turnError: null,
    validationProgress: null,
    upgradeWaiting: false,
    cloudflareExecutions: [],
    reels: [],
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
  private readonly reels: BuilderReelRepository;
  /** Changes each running command filed for the team's admins, in order, until that command's output takes them. */
  private readonly filedCloudflareChanges = new Map<string, CloudflareRequestFiled[]>();
  /** When the proxy holding each waiting change last asked about it, by execution: a change no one waits for is not sent. */
  private readonly waitingCloudflareChanges = new Map<string, number>();
  private readonly workspace: BuilderWorkspaceApi;
  private userId: string | null = null;
  private transcriptBinding: BuilderTranscriptBinding | null = null;
  /** The account's project repositories (Artifacts); the ConversationAgent harness replaces it with a fake. */
  private readonly repositories = (): ProjectRepositories => new ProjectRepositories(this.env.ARTIFACTS);
  /** Chat requests between their checks and recording their turn as active: a restore waits for none. */
  private startingTurns = 0;
  /** Editor saves under way, from before their closed check: a closed conversation waits for them too. */
  private readonly runningSaves = new Set<Promise<BuilderWorkspaceApplyResult>>();
  /** The seed of a new workspace under way, which every caller needing the workspace seeded shares. */
  private workspaceSeed: Promise<BuilderWorkspaceState> | null = null;
  /** What the prompt says about the project, read once the workspace is the project's. */
  #projectFacts: ProjectFacts | null = null;
  /** Tells the control plane, through the runtime, when a redeploy would cut this agent's work off. */
  private readonly runtimeActivity: BuilderRuntimeActivity;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeConversationAgentSchema(ctx);
    this.identityRepository = new ConversationAgentIdentityRepository(ctx.storage);
    this.cloudflareExecutions = new BuilderCloudflareExecutionRepository(ctx.storage);
    this.reels = new BuilderReelRepository(ctx.storage);
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
      await this.chat.start();
      this.resumeTurn();
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
    // Every background job that watches this project's builds stops with it.
    const live = await this.listFibers({ status: ['pending', 'running', 'interrupted'] }).catch(() => []);
    for (const fiber of live) {
      if (fiber.name === LINKED_BUILD_FIBER) {
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
      throw new AgentRefusal('Invalid transcript owner', 400);
    }
    if (this.userId && this.userId !== ownerId) {
      throw new AgentRefusal('Agent not found.', 404);
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
      throw new AgentRefusal('Agent not found.', 404);
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
      throw new AgentRefusal('Invalid message', 400);
    }
    const text = parsed.data.text.trim();
    if (!text || text.length > MAX_USER_MESSAGE_CHARACTERS) {
      throw new AgentRefusal('Invalid message', 400);
    }
    if (this.state.activeTurn) {
      await this.steerActiveTurn({ text, turnContext: parsed.data.turnContext });
      return { accepted: true };
    }
    // A conversation a newer one took over is kept to read: only the newest one changes the project.
    await this.refuseIfClosed();
    const { chatInitialId, conversationIndex, transcript, modelId, reasoningLevel } = requireBuilderRequestScope(
      parsed.data,
      durableIdentity.transcript,
    );
    const { accountCredentials, model, gatewayKeyRevision, chosenReasoningLevel } = await this.chooseModel(
      durableIdentity.userId,
      modelId,
      reasoningLevel,
    );
    // The model reads what became of any change this conversation filed for the team's admins, or left waiting in
    // the chat.
    await this.settleFiledTeamApprovals().catch(() => logger.warn('Unable to read back filed team approvals'));
    await this.settleChatCloudflareChanges();
    const siteNote = this.linkedSiteNote();
    const mainNote = this.mainMovedTurnNote();
    // Until the turn is recorded active, a restore must not start: it would change the files this turn edits.
    this.startingTurns += 1;
    let turn: BuilderTurnState;
    try {
      await markWorkspaceStarted(this.env.DB, {
        sessionId: durableIdentity.userId,
        workspaceId: chatInitialId,
        agentName: transcript.agentName,
      });
      turn = createBuilderTurn(parsed.data.requestId);
      this.setState({ ...this.state, activeTurn: turn, turnError: null });
    } finally {
      this.startingTurns -= 1;
    }
    const untoldChanges = this.state.untoldChanges ?? [];
    if (untoldChanges.length > 0) {
      this.setState({ ...this.state, untoldChanges: [] });
    }
    const turnContext = withNotes(parsed.data.turnContext, [await siteNote, await mainNote, ...untoldChanges]);
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
          throw error instanceof RuntimeUpgradeWaitExceededError ? new AgentRefusal(error.message, 503) : error;
        });
      // Again now that the turn is visible: a newer conversation that took over meanwhile either saw this turn and
      // stopped it, or closed this one before this read.
      await this.refuseIfClosed();
      const { contentLogging } = await this.requireModelAccess();
      // The browser prepares the workspace before it sends, but nothing else seeds a new one.
      await this.initializeWorkspace(durableIdentity.transcript);
      await this.nameGitRepository();
      if (shouldGenerateConversationTitle(text, userMessages)) {
        await this.scheduleTitleGeneration(
          {
            chatInitialId,
            firstPrompt: userMessages === 1,
            prompt: text.slice(0, TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS),
            promptGeneration: userMessages,
            conversationIndex,
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
              cloudflareChanges: async (toolCallId, ended) => this.settleCommandCloudflareChanges(toolCallId, ended),
              runWithKeepAlive: (operation) => this.keepAliveWhile(operation),
            },
            { read: async (path) => (await this.skillContext()).reader.read(path) },
          ),
        ),
        systemPrompt: async () => {
          return systemPrompt((await this.skillContext()).prompt, await this.projectFacts());
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
    return createBuilderSkillContext({ starterApp: (await this.projectFacts()).starterApp });
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

  /**
   * The turn's run settled: record how. What it pushed publishes on its own, from the project's repository (a push of
   * main goes live, another branch makes a preview), followed by the build watch its command started.
   */
  protected async endTurn(turn: BuilderTurnState, status: BuilderTurnStatus): Promise<void> {
    this.finishTurn(turn, { status });
  }

  /** A message the person sent while the turn runs: it joins the running work after the current round of tool calls. */
  @callable()
  async steerActiveTurn(input: BuilderSteeringInput): Promise<{ accepted: true }> {
    await this.requireDurableIdentity('steer_active_turn');
    const steering = steeringRequestSchema.safeParse(input);
    if (!steering.success) {
      throw new AgentRefusal('Invalid steering message', 400);
    }
    const text = steering.data.text.trim();
    if (!text || text.length > MAX_USER_MESSAGE_CHARACTERS) {
      throw new AgentRefusal('Invalid steering message', 400);
    }
    if (!this.state.activeTurn) {
      throw new AgentRefusal('The builder is not currently running.', 409);
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
      throw new AgentRefusal('Invalid Cloudflare execution decision.', 400);
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
      throw new AgentRefusal('This Cloudflare execution can no longer be approved.', 409);
    }
    const job: CloudflareExecutionFiberJob = {
      executionId: proposal.executionId,
      proposalSha256: proposal.proposalSha256,
    };
    await this.runtimeActivity.admit();
    // While the command that asked waits for it, its proxy asks again every few seconds and hands `cf` the answer.
    // A change no proxy asks about any more is the chat's: it is sent all the same, and the answer goes to the agent.
    const asked = this.waitingCloudflareChanges.get(proposal.executionId);
    if (
      proposal.leftWaitingAt === null &&
      (asked === undefined || Date.now() - asked > CLOUDFLARE_CHANGE_WAITER_TIMEOUT_MS)
    ) {
      this.cloudflareExecutions.leaveInChat(proposal.toolCallId, proposal.executionId);
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
    await this.settleChatCloudflareChanges();
    return { execution: publicExecutionState(execution) };
  }

  @callable()
  async rejectCloudflareExecution(input: { executionId: string }): Promise<CloudflareExecutionDecisionResult> {
    const parsed = cloudflareExecutionDecisionSchema.safeParse(input);
    if (!parsed.success) {
      throw new AgentRefusal('Invalid Cloudflare execution decision.', 400);
    }
    const binding = await this.requireCurrentCloudflareExecutionBinding('reject_cloudflare_execution');
    const { record } = await this.cloudflareExecutions.reject(parsed.data.executionId, binding);
    this.refreshCloudflareExecutionState();
    await this.settleChatCloudflareChanges();
    return { execution: publicExecutionState(record) };
  }

  /**
   * A clip for the project's post, from `cloudchef reel` while this conversation's command `toolCallId` runs (the
   * runtime's ReelProxy asks). Made here, its lines spoken in the person's own account, and shown in that command's
   * place in the chat with Approve and Not now; nothing leaves the account until they approve. The answer is the
   * command's output, for the agent.
   */
  async proposeReel(input: { toolCallId: string; request: ReelRequest }): Promise<{ status: number; message: string }> {
    const parsed = proposedReelSchema.safeParse(input);
    const identity = runtimeConnectionIdentity(this.env);
    if (!parsed.success || !identity || identity.userId !== this.userId) {
      return { status: 403, message: 'A clip is made by the agent in its own chat.' };
    }
    const linked = await this.workspace.linkedProject();
    if (!linked) {
      return { status: 409, message: 'This workspace is not tied to a project yet.' };
    }
    try {
      const target = await reelTarget(this.env, identity, linked.orgProjectId);
      const reel = await makeReel(parsed.data.request, workersAiSpeaker(this.env.AI));
      const draft = this.reels.add({ toolCallId: parsed.data.toolCallId, postPath: target.path, reel });
      this.refreshReelState();
      return {
        status: 200,
        message:
          `The ${Math.round(draft.seconds)}-second clip is playing in the chat for the person, with Approve and Not now. ` +
          `It goes on their post (${target.path}) only if they approve; nothing more is needed from you.`,
      };
    } catch (error) {
      if (error instanceof ReelRefusal || error instanceof ProjectRefusalError) {
        return { status: 400, message: error.message };
      }
      throw error;
    }
  }

  /** A clip waiting in the chat, for the chat's player to play. */
  @callable()
  async reelForChat(input: { reelId: string }): Promise<ReelDraftForChat> {
    await this.requireDurableIdentity('reel_for_chat');
    const reel = this.reels.bundle(reelIdOf(input));
    if (!reel) {
      throw new AgentRefusal('This clip is no longer in the chat.', 404);
    }
    return reel;
  }

  /** Approve: the clip goes on the project's post, sent to CloudChef as the person. */
  @callable()
  async approveReel(input: { reelId: string }): Promise<ReelDraftPublicState> {
    const durable = await this.requireDurableIdentity('approve_reel');
    const reelId = reelIdOf(input);
    const identity = runtimeConnectionIdentity(this.env);
    const linked = await this.workspace.linkedProject();
    const reel = this.reels.bundle(reelId);
    if (!identity || identity.userId !== durable.userId || !linked || !reel) {
      throw new AgentRefusal('This clip can no longer be posted.', 409);
    }
    if (!this.reels.move(reelId, 'waiting', 'posting', null)) {
      return this.reels.require(reelId);
    }
    this.refreshReelState();
    try {
      const posted = await postReel(this.env, identity, linked.orgProjectId, reel);
      this.reels.move(
        reelId,
        'posting',
        'posted',
        posted.shown ? null : 'It shows on your post once CloudChef has looked at it.',
      );
    } catch (error) {
      const note =
        error instanceof ProjectRefusalError ? error.message : 'CloudChef couldn’t take the clip just now. Try again.';
      this.reels.move(reelId, 'posting', 'waiting', note);
    }
    this.refreshReelState();
    return this.reels.require(reelId);
  }

  /** Not now: the clip is put aside, and its files go. */
  @callable()
  async declineReel(input: { reelId: string }): Promise<ReelDraftPublicState> {
    await this.requireDurableIdentity('decline_reel');
    const reelId = reelIdOf(input);
    this.reels.move(reelId, 'waiting', 'declined', null);
    this.refreshReelState();
    return this.reels.require(reelId);
  }

  private refreshReelState(): void {
    this.setState({ ...this.state, reels: this.reels.listRecent() });
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
   * A newer conversation in this chat has taken the project over (this one is closed): stop the turn running
   * here, and return once nothing more can change the workspace. Saves, steering and approvals are already
   * refused here. A project's build watch keeps running: it only reads the build's status and fills in this
   * transcript's push result.
   *
   * An internal Durable Object RPC, not `@callable`: the data API calls it when the new conversation starts.
   */
  async closeForSuccessor(ownerId: string): Promise<void> {
    if (!transcriptOwnerIdSchema.safeParse(ownerId).success) {
      throw new AgentRefusal('Invalid transcript owner', 400);
    }
    const identity = await this.hydrateDurableIdentity();
    if (!identity) {
      // Never started, so nothing runs here.
      return;
    }
    if (identity.userId !== ownerId) {
      throw new AgentRefusal('Agent not found.', 404);
    }
    if (!(await loadConversationScope(this.env.DB, { agentName: this.name, ownerId })).closed) {
      throw new AgentRefusal('This conversation is still the newest one.', 409);
    }
    if (!this.state.conversationClosed) {
      this.setState({ ...this.state, conversationClosed: true });
    }
    // The running turn stops, and pi-durable resolves the abort once nothing more runs.
    await this.cancelActiveTurn();
    // A save that found this conversation current runs to the end whatever the Stop: reported saved, it must be
    // in the workspace before the newer conversation works on it.
    if (!(await this.waitForWorkspaceWrites(WORKSPACE_WRITES_SETTLE_MS))) {
      throw new Error('The earlier conversation did not settle in time.');
    }
  }

  /** Whether every editor save under way settled within `timeoutMs`. */
  private async waitForWorkspaceWrites(timeoutMs: number): Promise<boolean> {
    return settledWithin([...this.runningSaves], timeoutMs);
  }

  /**
   * A conversation a newer one took over is kept to read, and a deleted chat's agent lives on for a while,
   * its turn too: nothing may change the project of either.
   */
  private async refuseIfClosed(): Promise<void> {
    const closed = await this.closedConversationMessage();
    if (closed) {
      throw new AgentRefusal(closed, 409);
    }
  }

  /** Why this conversation may no longer change its project, or null while it may. */
  private async closedConversationMessage(): Promise<string | null> {
    const ownerId = this.userId ?? (await this.requireDurableIdentity('closed_check')).userId;
    const { closed, deleted } = await loadConversationScope(this.env.DB, {
      agentName: this.name,
      ownerId,
    });
    if (deleted) {
      return DELETED_CONVERSATION_MESSAGE;
    }
    return closed ? CLOSED_CONVERSATION_MESSAGE : null;
  }

  /**
   * Makes the workspace hold exactly the files of `commit` in the project's history, as one change set
   * through the same compare-and-swap path as an editor save: files the commit lacks are deleted, except
   * what no commit holds (installed and built output, local secrets, ignored files). Refused while a turn
   * runs, and while main has commits the workspace's files aren't based on, which restoring would silently
   * undo. The restored files are published by the agent like any other change, by pushing them.
   */
  @callable()
  async revertToCommit(commit: string): Promise<BuilderWorkspaceApplyResult> {
    await this.requireDurableIdentity('revert_to_commit');
    const parsed = revertRequestSchema.safeParse(commit);
    if (!parsed.success) {
      throw new AgentRefusal('Invalid commit.', 400);
    }
    if (this.state.activeTurn || this.startingTurns > 0) {
      throw new AgentRefusal('Stop the agent before restoring a version.', 409);
    }
    await this.refuseIfClosed();
    const linked = await this.workspace.linkedProject();
    const identity = runtimeConnectionIdentity(this.env);
    const project = linked && identity ? await openProject(this.env, identity, linked.orgProjectId) : null;
    if (!project?.repo || project.role !== 'edit') {
      throw new AgentRefusal('You can view this project but not change it.', 403);
    }
    const repo = project.repo;
    // Refused before the files change: what main took elsewhere would be undone by the restore once it is pushed.
    await this.refuseIfMainMovedElsewhere(await this.repositories().head(repo));
    const { files } = await this.repositories().readFilesAt(repo, parsed.data, (path) => !isExcludedProjectPath(path));
    const { baseRevision, changes } = await revertChanges(this.workspace, files);
    const result = await this.applyWorkspaceClientChanges({ baseRevision, changes });
    if (!result.ok) {
      throw new AgentRefusal('The project changed while this version was being restored. Try again.', 409);
    }
    return result;
  }

  /** The project this workspace works on, or null before it is prepared. */
  getLinkedProject(): Promise<BuilderWorkspaceLinkedProject | null> {
    return this.workspace.linkedProject();
  }

  /**
   * Tells the browser which project this workspace works on and its live site, and whether a newer conversation
   * continues the project, so it offers nothing here that would change it.
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
    const scope =
      this.userId === null
        ? null
        : await loadConversationScope(this.env.DB, { agentName: this.name, ownerId: this.userId });
    const closed = scope?.closed === true;
    if ((this.state.conversationClosed ?? false) !== closed) {
      this.setState({ ...this.state, conversationClosed: closed });
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
      throw new AgentRefusal('Agent authentication is required.', 401);
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
    return this.workspace.applyClientChanges(request);
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
      throw new AgentRefusal('Agent not found.', 404);
    }
    const transcriptBinding = await loadBuilderTranscriptBinding(this.env.DB, {
      agentName: this.name,
      ownerId: props.userId,
    });
    if (!transcriptBinding) {
      throw new AgentRefusal('Agent not found.', 404);
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
    throw new AgentRefusal(status === 401 ? 'Agent authentication is required.' : 'Agent not found.', status);
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
        idempotencyKey: `${TITLE_GENERATION_FIBER}:${job.conversationIndex}:${job.promptGeneration}`,
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
    // A project made in this chat is named after it; any other project keeps its own name, which the control plane
    // alone tells apart, so naming one is refused there.
    const namesProject = args.firstPrompt && args.conversationIndex === 0;
    const projectTitlePromise = namesProject ? generateTitle('project') : null;
    const provisionalTitle = args.firstPrompt ? deriveProvisionalTitle(args.prompt) : null;

    if (provisionalTitle) {
      try {
        const [, savedHeuristicSubchat] = await Promise.all([
          namesProject ? this.nameChatProject(provisionalTitle) : Promise.resolve(false),
          setHeuristicConversationDescriptionIfMissing(this.env.DB, {
            sessionId: ownerId,
            id: args.chatInitialId,
            conversationIndex: args.conversationIndex,
            description: provisionalTitle,
            promptGeneration: args.promptGeneration,
          }),
        ]);
        if (savedHeuristicSubchat) {
          const updatedAt = new Date().toISOString();
          this.setState({
            ...this.state,
            generatedConversationTitle: {
              conversationIndex: args.conversationIndex,
              title: provisionalTitle,
              updatedAt,
            },
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
          conversationIndex: args.conversationIndex,
          description: conversationResult.value,
          promptGeneration: args.promptGeneration,
        });
        if (savedSubchatTitle) {
          const updatedAt = new Date().toISOString();
          this.setState({
            ...this.state,
            generatedConversationTitle: {
              conversationIndex: args.conversationIndex,
              title: conversationResult.value,
              updatedAt,
            },
          });
        }
      } catch {
        logger.warn('Generated conversation title could not be saved');
      }
    } else if (conversationResult.status === 'rejected') {
      logger.warn('Conversation title generation failed; keeping the current title');
    }

    if (projectResult.status === 'fulfilled' && projectResult.value) {
      await this.nameChatProject(projectResult.value);
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
    const identity = runtimeConnectionIdentity(this.env);
    if (!identity || !this.userId) {
      throw new ProjectRefusalError('This workspace is not connected to CloudChef, so it cannot open the project.');
    }
    const { orgProjectId: opened } = await loadConversationScope(this.env.DB, {
      agentName: binding.agentName,
      ownerId: this.userId,
    });
    const orgProjectId = opened ?? (await this.createChatProject(identity, binding));
    {
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
  }

  /**
   * Names the project this chat made after what it is about, once its workspace is the project's: the first prompt's
   * words at once, the generated title after. A project the chat didn't make keeps its name (the control plane
   * refuses), as does one whose workspace isn't seeded yet.
   */
  private async nameChatProject(name: string): Promise<boolean> {
    const identity = runtimeConnectionIdentity(this.env);
    const seeding = this.workspaceSeed;
    if (seeding) {
      await seeding.catch(() => undefined);
    }
    const linked = await this.workspace.linkedProject().catch(() => null);
    if (!identity || !linked) {
      return false;
    }
    try {
      await nameChatProject(this.env, identity, { orgProjectId: linked.orgProjectId, name });
    } catch {
      return false;
    }
    await this.workspace.setLinkedProject({ ...linked, name }).catch(() => undefined);
    this.showLinkedProject({ repository: name, repo: linked.repository, defaultBranch: linked.defaultBranch });
    return true;
  }

  /**
   * A new chat's own project (`created_from = 'chat'`, a person's own or, in a team, the team's that its maker may
   * edit): its repository starts with CloudChef's starter as its first commit, and the chat's workspace becomes the
   * project's, so it is worked on and published as every project is, by pushing to main. Nothing is published until
   * the first push.
   */
  private async createChatProject(identity: RuntimeConnectionIdentity, binding: BuilderTranscriptBinding) {
    const orgProjectId = crypto.randomUUID();
    const repo = importedProjectRepo(orgProjectId);
    const repositories = this.repositories();
    await commitBuilderTemplate(repositories, repo, await commitAuthor(this.env));
    try {
      await registerUploadedProject(this.env, identity, { orgProjectId, name: 'New project', repo, chat: true });
    } catch (error) {
      await repositories.deleteRepo(repo).catch(() => undefined);
      throw error;
    }
    if (
      !(await linkWorkspaceToProject(this.env.DB, {
        agentName: binding.agentName,
        ownerId: identity.userId,
        orgProjectId,
      }))
    ) {
      throw new ProjectRefusalError('This chat already has a project. Open it again.');
    }
    return orgProjectId;
  }

  /**
   * Tells the workspace which repository git in its container reaches through the git proxy: its project's.
   * Each turn, so a workspace seeded before the proxy existed learns it.
   */
  private async nameGitRepository(): Promise<void> {
    const linked = await this.workspace.linkedProject();
    if (linked) {
      await this.workspace.setGitRepository({ repo: linked.repository, orgProjectId: linked.orgProjectId });
    }
  }

  /**
   * What the prompt says about the project: its name and main branch, and whether it is made from CloudChef's
   * starter (it has the starter's `cloudflare.project.json`), read once the workspace is the project's.
   */
  private async projectFacts(): Promise<ProjectFacts> {
    if (this.#projectFacts) {
      return this.#projectFacts;
    }
    const linked = await this.workspace.linkedProject();
    const starterApp = await this.workspace.readText(`${WORK_DIR}/cloudflare.project.json`).then(
      () => true,
      () => false,
    );
    const facts = {
      name: linked?.name ?? linked?.repository ?? 'This project',
      defaultBranch: linked?.defaultBranch ?? MAIN_BRANCH,
      starterApp,
    };
    if (linked) {
      this.#projectFacts = facts;
    }
    return facts;
  }

  /**
   * What the command `toolCallId` pushed to the project's repository, reported as a publish is: its default
   * branch (it goes live) or else the last branch pushed (a preview), with its build followed in the
   * background. Nothing for a command that pushed no branch.
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

  /** Puts `output` in place of what a watched command pushed once no turn is running; whether it landed. */
  private async landLinkedBuildOutput(watch: LinkedBuildWatch, output: CloudChefToolResult): Promise<boolean> {
    if (this.state.activeTurn) {
      return false;
    }
    const messages = withLinkedBuildResult(await this.chat.messages(), watch.toolCallId, output);
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

  /**
   * The commits main took since git in the workspace last fetched or pushed it, and who made them, for the turn's
   * context. Null when there are none, or they can't be learned quickly, so a turn never waits on it.
   */
  private async mainMovedTurnNote(): Promise<string | null> {
    const note = (async () => {
      const [linked, known] = await Promise.all([this.workspace.linkedProject(), this.workspace.knownMain()]);
      return linked ? mainMovedNote(this.repositories(), linked.repository, known) : null;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SITE_NOTE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([note, late]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      note.catch(() => undefined);
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
      throw new AgentRefusal("You no longer have access to this team's account.", 403);
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
    if (record.status === 'awaiting_approval' && record.leftWaitingAt === null && record.expiresAt <= Date.now()) {
      // Its command's wait ran out: it is left waiting in the chat, and `cf` is told so.
      this.refreshCloudflareExecutionState();
      return this.answerWaitingChange(this.cloudflareExecutions.get(input.executionId) ?? record);
    }
    return this.answerWaitingChange(record);
  }

  /** `cf` stopped while its change waited (the command may go on): the change waits in the chat instead. */
  async leaveWorkspaceCloudflareChangeInChat(input: { toolCallId: string; executionId: string }): Promise<void> {
    const record = this.cloudflareExecutions.get(input.executionId);
    if (
      record?.toolCallId === input.toolCallId &&
      this.cloudflareExecutions.leaveInChat(input.toolCallId, input.executionId)
    ) {
      this.refreshCloudflareExecutionState();
    }
  }

  /**
   * After a command ends, the changes it asked for, for its output. One it finished without stays waiting in the
   * chat, where the person may still approve or reject it, and what they decide replaces it in this output; when the
   * command was stopped, one `cf` still waited for is withdrawn, since nothing reads its answer. The changes it filed
   * for the team's admins are given too, where their decisions later land.
   */
  private settleCommandCloudflareChanges(
    toolCallId: string,
    ended: 'finished' | 'stopped' = 'finished',
  ): CloudflareCommandChange[] {
    const settled =
      ended === 'stopped'
        ? this.cloudflareExecutions.withdrawHeld(toolCallId)
        : this.cloudflareExecutions.leaveInChat(toolCallId);
    if (settled) {
      this.refreshCloudflareExecutionState();
    }
    const inChat = this.cloudflareExecutions
      .leftInChatBy(toolCallId)
      .map((record) => chatCloudflareChange(publicExecutionState(record)));
    const filed = this.filedCloudflareChanges.get(toolCallId) ?? [];
    this.filedCloudflareChanges.delete(toolCallId);
    return [...inChat, ...filed];
  }

  /**
   * Puts what the person decided on each change a command left waiting in the chat in place of that change in the
   * command's output, which the agent reads at its next turn.
   */
  private async settleChatCloudflareChanges(): Promise<void> {
    const shown = await this.chat.messages();
    let messages: CloudChefMessage[] = shown;
    const replaced = new Set<string>();
    const decisions: string[] = [];
    for (const message of shown) {
      for (const part of message.parts) {
        const changes = commandOutputPartSchema.safeParse(part).data?.output.cloudflareChanges ?? [];
        for (const change of changes) {
          const waiting = waitingInChatSchema.safeParse(change);
          const record = waiting.success ? this.cloudflareExecutions.get(waiting.data.executionId) : null;
          if (!record || !isCloudflareExecutionTerminal(record.status)) {
            continue;
          }
          const decided = chatCloudflareChange(publicExecutionState(record));
          const next = replaceToolCallPart(messages, record.toolCallId, (current, invocation) => {
            if (
              invocation.toolName !== 'exec' ||
              invocation.state !== 'output-available' ||
              !isRecord(invocation.output)
            ) {
              return null;
            }
            const listed = commandChangesSchema.safeParse(invocation.output).data?.cloudflareChanges;
            const at = listed?.findIndex(
              (entry) => waitingInChatSchema.safeParse(entry).data?.executionId === record.executionId,
            );
            if (!listed || at === undefined || at < 0) {
              return null;
            }
            return { ...current, output: { ...invocation.output, cloudflareChanges: listed.with(at, decided) } };
          });
          if (next) {
            messages = next;
            replaced.add(record.toolCallId);
            decisions.push(
              `The Cloudflare change command ${record.toolCallId} left waiting in the chat was decided: ${JSON.stringify(decided)}`,
            );
          }
        }
      }
    }
    for (const toolCallId of replaced) {
      await this.replaceToolOutput(toolCallId, messages);
    }
    if (decisions.length > 0) {
      // The model saw the command's output as it was; it is told what was decided at its next turn.
      this.setState({ ...this.state, untoldChanges: [...(this.state.untoldChanges ?? []), ...decisions] });
    }
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
      throw new AgentRefusal('The Cloudflare execution identity is unavailable.', 409);
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
    this.cloudflareExecutions.leaveOverdueInChat();
    const cloudflareExecutions = this.cloudflareExecutions.listRecent();
    this.setState({ ...this.state, cloudflareExecutions });
  }

  /**
   * Refuses restoring a version over main (at `head`, null before main exists) when main took commits the
   * workspace's files aren't based on, pushed from the person's computer or another chat: the restored files,
   * pushed, would silently undo them. The model is told at its next turn.
   */
  private async refuseIfMainMovedElsewhere(head: string | null): Promise<void> {
    const known = head === null ? null : await this.workspace.knownMain();
    if (head === null || head === known) {
      return;
    }
    // Nothing recorded (a workspace from before this was kept, or whose git never fetched): main may not have moved
    // at all, so the person is told only that the copy needs bringing up to date.
    const why =
      known === null
        ? "which commit of main the workspace's files are based on isn't known, as git here hasn't fetched or " +
          'pushed main yet.'
        : "main has commits the workspace's files aren't based on, pushed from elsewhere since git here last fetched.";
    this.setState({
      ...this.state,
      untoldChanges: [
        ...(this.state.untoldChanges ?? []),
        `CloudChef refused to restore an earlier version: ${why} ` + '`git pull` brings it up to date.',
      ],
    });
    throw new AgentRefusal(known === null ? MAIN_BASE_UNKNOWN : MAIN_MOVED_ELSEWHERE, 409);
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

/** Why a version can't be restored over main that moved elsewhere, in words for the person. */
const MAIN_MOVED_ELSEWHERE =
  'This project changed somewhere else since your copy was last updated, from your computer or another chat. ' +
  'Ask CloudChef to bring in the latest changes, then try again.';
/** Why a version can't be restored when what the workspace's files are based on isn't known, in words for the person. */
const MAIN_BASE_UNKNOWN =
  'CloudChef needs to bring your copy up to date with the project first. Ask it to, then try again.';
/** How long a turn's start waits for a team project's addresses, or what main took since git last fetched it. */
const SITE_NOTE_TIMEOUT_MS = 5_000;

/**
 * Puts CloudChef's own notes for this turn (the project's addresses, the commits main took since git last
 * fetched it, what became of changes left waiting) ahead of the turn's workspace context.
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

const proposedReelSchema = z.strictObject({ toolCallId: z.string().min(1), request: reelRequestSchema });
const reelChoiceSchema = z.strictObject({ reelId: z.string().uuid() });

function reelIdOf(input: { reelId: string }): string {
  const parsed = reelChoiceSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentRefusal('Name the clip.', 400);
  }
  return parsed.data.reelId;
}
