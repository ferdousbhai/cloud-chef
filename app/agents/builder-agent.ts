import {
  AIChatAgent,
  type ChatRecoveryContext,
  type ChatRecoveryExhaustedContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
  type OnChatMessageOptions,
} from '@cloudflare/ai-chat';
import { callable, type FiberRecoveryContext, type FiberRecoveryResult } from 'agents';
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
import { summarizeBuilderContext } from '~/lib/.server/llm/workers-ai-text';
import { chatTurnContextSchema, type ChatTurnContext } from 'cloudchef-agent/turn-context';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import type { UIMessage } from 'ai';
import {
  deployValidatedRevisionForBuilder,
  previewValidatedRevisionForBuilder,
  terminalizeInterruptedDeploymentForBuilder,
  validatePreviewCheckpointForBuilder,
  validatedDeploymentCheckpoint,
  type BuilderDeploymentState,
} from './builder-deployment-command';
import {
  publicationProgress,
  type BuilderPublicationLane,
  type BuilderPublicationState,
} from './builder-publication-progress';
import { latestDeploymentActivity } from '~/lib/.server/cloudflare/deployment-repository';
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
  requireBuilderRequestScope,
  requireBuilderTranscriptIdentity,
  type BuilderTranscriptBinding,
} from './builder-request-policy';
import { initializeBuilderAgentSchema } from './builder-agent-schema';
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
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from './builder-workspace-types';
import { builderTemplateSeedId, loadBuilderTemplate } from './builder-template';
import { parentBuilderWorkspaceSeedId, seedBuilderWorkspace } from './builder-workspace-seed';
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
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import { z } from 'zod';
import {
  BuilderCloudflareExecutionRepository,
  CLOUDFLARE_EXECUTION_RISK_NOTE,
  containsCredentialishCloudflareContent,
  publicExecutionState,
  type CloudflareExecutionBinding,
  type CloudflareExecutionRecord,
} from './builder-cloudflare-execution';
import {
  type CloudflareExecuteFinalResult,
  type CloudflareExecuteProposal,
  type CloudflareExecutionDecisionResult,
  type CloudflareExecutionPublicState,
  type CloudflareExecutionSafeOutcome,
  type CloudflareExecutionStatus,
  type CloudflareMcpImmediateResult,
} from 'cloudchef-agent/cloudflare-mcp';
import {
  cloudflareMcpExecuteEnabled,
  readCloudflareMcpRuntimeAdmission,
  type CloudflareMcpRuntimeControls,
  type CloudflareMcpRuntimeIdentity,
} from '~/lib/.server/cloudflare/cloudflare-mcp-runtime-controls';
import { CloudflareMcpClient, type CloudflareMcpOutcome } from '~/lib/.server/cloudflare/cloudflare-mcp-client';
import { resolveUserWorkspaceCloudflareAccessToken } from '~/lib/.server/cloudflare/user-workspace-cloudflare-credential';
import { requireWorkersAiBuilderModel } from '~/lib/.server/llm/workers-ai-model-catalog';
import type {
  CloudflareDocsModelInput,
  CloudflareExecuteModelInput,
  CloudflareMcpModelToolContext,
  CloudflareSearchModelInput,
  ModelToolExecutionOptions,
} from '~/lib/.server/llm/cloudflare-mcp-model-tools';

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
const TITLE_GENERATION_FIBER = 'background:title_generation';
const CLOUDFLARE_EXECUTION_FIBER = 'background:cloudflare_execution';
const TITLE_GENERATION_JOB_MAX_PROMPT_CHARACTERS = 4_000;
/**
 * How often a running publication re-reads the step it last recorded. Publication steps take tens
 * of seconds each, so this is a heartbeat against one indexed row, not a poll for a result.
 */
const PUBLICATION_ACTIVITY_INTERVAL_MS = 2_000;
const CHAT_CANCELLATION_SETTLE_TIMEOUT_MS = 4.5 * 60 * 1000;

/** Fiber metadata survives a Durable Object restart, so every job is re-parsed before it is resumed. */
const previewPublicationJobSchema = z.object({
  previewId: z.string().min(1),
  workspaceRevision: z.number().int().min(0),
  snapshotRevision: z.string().min(1),
  requestedAt: z.number().int().positive(),
  // Manual "Build preview" requests must not promote to the public production URL. Only the
  // validated-revision pipeline (publishValidatedRevision) opts into the deployment behind the preview.
  autoDeploy: z.boolean().default(true),
});
type PreviewPublicationJob = z.infer<typeof previewPublicationJobSchema>;

const deploymentJobSchema = z.object({
  workspaceRevision: z.number().int().min(0),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}) satisfies z.ZodType<BuilderWorkspaceCheckpoint>;
type DeploymentJob = z.infer<typeof deploymentJobSchema>;

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
  /** The step the running preview or deployment publication last recorded, while it is running. */
  publication?: BuilderPublicationState | null;
  contextCompactionRequestedTurnId?: string | null;
  cloudflareExecutions?: CloudflareExecutionPublicState[];
};

/** Durable transcript as the agent currently holds it, returned after a cancel or an explicit reload. */
export type BuilderTranscriptSnapshot = {
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
    publication: null,
    contextCompactionRequestedTurnId: null,
    cloudflareExecutions: [],
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initializeBuilderAgentSchema(ctx);
    this.identityRepository = new BuilderAgentIdentityRepository(ctx.storage);
    this.cloudflareExecutions = new BuilderCloudflareExecutionRepository(ctx.storage);
    this.workspace = new UserWorkspaceRuntimeClient(env, ctx.id.toString(), () => this.userId);
  }

  async onStart(props?: BuilderAgentProps) {
    if (props) {
      await this.initializeIdentity(props);
    } else {
      await this.hydrateDurableIdentity({ required: false, reason: 'agent_start' });
    }
    this.refreshCloudflareExecutionState();
  }

  /**
   * Accept durable deletion without making the caller wait for the
   * abort-shaped `destroy()` RPC. This is intentionally not decorated with
   * `@callable`: it is an internal Durable Object RPC used only by the D1 GC
   * outbox.
   */
  async scheduleDestroyForGc(ownerId: string): Promise<void> {
    await this.initializeGcIdentity(ownerId);
    const pendingPreviewId = this.state.preview?.pendingId;
    if (pendingPreviewId) {
      await this.cancelFiberByKey(this.previewFiberKey(pendingPreviewId), 'Project deletion').catch(() => undefined);
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
      hasRecoveryData: ctx.recoveryData !== undefined,
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
      await this.generateTitlesForPrompt({ ...job, accountCredentials: credentials });
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
      const error = new Error('Deployment was interrupted. Retry to reconcile the exact revision.');
      try {
        await this.retry(() => this.terminalizeDeployment(job));
      } catch {
        logger.error('Unable to terminalize the interrupted deployment');
        this.failDeployment(job, new Error('Interrupted deployment recovery is pending. Retry to continue.'));
        return { status: 'error', error: 'Interrupted deployment recovery did not settle safely.' };
      }
      this.failDeployment(job, error);
      return { status: 'error', error: error.message };
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
    const credentials = await getUserWorkersAiCredentials(this.env, this.userId);
    await this.runContextCompaction(compaction.data.throughMessageId, credentials);
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
    const { chatInitialId, subchatIndex, transcript, modelId } = requireBuilderRequestScope(
      body,
      durableIdentity.transcript,
    );
    const accountCredentials = await getUserWorkersAiCredentials(this.env, durableIdentity.userId);
    const model = await requireWorkersAiBuilderModel(accountCredentials.binding, modelId);
    if (!options?.continuation) {
      await this.cancelPreview();
      await markChatStarted(this.env.DB, {
        sessionId: durableIdentity.ownerId,
        chatId: chatInitialId,
        agentName: transcript.agentName,
      });
    }
    await this.advanceTranscriptCheckpoint(transcript);
    const turnContext = parseTurnContext(body.turnContext);
    const userMessages = messages.filter((message: { role?: string }) => message.role === 'user');
    const firstUserMessage = !options?.continuation && userMessages.length === 1;
    const latestPrompt = !options?.continuation ? userMessages.at(-1) : undefined;
    const latestPromptText = latestPrompt ? messageText(latestPrompt) : '';
    const shouldGenerateTitle = shouldGenerateConversationTitle(latestPromptText, userMessages.length);
    const turn = createBuilderTurn(options?.requestId);
    console.info({
      event: 'builder_chat_turn_started',
      continuation: options?.continuation === true,
      firstUserMessage,
    });
    this.setState({
      ...this.state,
      activeTurn: turn,
    });
    const steering = new PiSteeringQueue();
    this.activeSteering = { turnId: turn.id, queue: steering };
    const settleSteering = () => {
      if (this.activeSteering?.turnId === turn.id) {
        this.activeSteering = null;
      }
    };

    try {
      const cloudflareMcp = await this.createCloudflareMcpToolContext(durableIdentity.transcript);
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
        );
      }
      this.stashTurn(turn);
      const compactionPending = await this.hasPendingContextCompaction();
      return await createChatResponseFromBody({
        abortSignal: options?.abortSignal,
        firstUserMessage,
        turnContext,
        accountCredentials,
        sessionAffinity: await createWorkersAiSessionAffinity(transcript, modelId),
        workspace: this.workspace,
        cloudflareMcp,
        onValidationStage: (toolCallId, stage) => this.setValidationProgress(toolCallId, stage),
        runWithKeepAlive: (operation) => this.keepAliveWhile(operation),
        steering,
        onSettled: () => {
          settleSteering();
        },
        compaction: {
          current: this.contextCompaction.getCompaction(),
          pending: compactionPending,
          summarize: (prompt, signal) => summarizeBuilderContext(prompt, accountCredentials, signal),
          save: (compaction) => this.contextCompaction.saveCompaction(compaction),
          schedule: async () => {
            const throughMessageId = messages.at(-1)?.id;
            if (throughMessageId) {
              await this.scheduleContextCompaction(throughMessageId, messages.length, accountCredentials);
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
      });
    } catch (error) {
      steering.close();
      settleSteering();
      this.finishTurn(turn, {
        status: 'error',
      });
      throw error;
    }
  }

  private async scheduleContextCompaction(
    throughMessageId: string,
    revision: number,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
  ): Promise<void> {
    if (await this.hasPendingContextCompaction()) {
      return;
    }
    await this.startFiber(
      CONTEXT_COMPACTION_FIBER,
      async (fiber) => {
        fiber.stash({ throughMessageId, version: 1 });
        await this.runContextCompaction(throughMessageId, accountCredentials);
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

  private async runContextCompaction(
    throughMessageId: string,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
  ): Promise<void> {
    const currentMessages = this.messages;
    const throughIndex = currentMessages.findIndex((message) => message.id === throughMessageId);
    if (throughIndex < 0) {
      return;
    }
    const sourceMessages = currentMessages.slice(0, throughIndex + 1);
    const expected = this.contextCompaction.getCompaction();
    const next = await compactContext({
      messages: sourceMessages,
      current: expected,
      summarize: (prompt) => summarizeBuilderContext(prompt, accountCredentials),
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
    const validatedSnapshot = await this.refreshDeploymentReadiness();
    if (status === 'completed') {
      if (compactAfterTurn && this.userId) {
        const throughMessageId = this.messages.at(-1)?.id;
        if (throughMessageId) {
          try {
            const credentials = await getUserWorkersAiCredentials(this.env, this.userId);
            await this.scheduleContextCompaction(throughMessageId, this.messages.length, credentials);
          } catch {
            logger.warn('Unable to queue post-turn context compaction');
          }
        }
      }
      if (validatedSnapshot) {
        await this.publishValidatedRevision(validatedSnapshot);
      }
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
    const fiber = await this.startFiber(
      CLOUDFLARE_EXECUTION_FIBER,
      async (context) => {
        context.stash(job);
        await this.runApprovedCloudflareExecution(job, binding);
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
    const checkpoint = this.state.transcript ? await this.advanceTranscriptCheckpoint(this.state.transcript) : null;
    return {
      checkpoint,
      messages: this.messages,
    };
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
    const snapshot = await validatedDeploymentCheckpoint(this.workspace);
    if (!snapshot) {
      throw new Error('The current project revision must pass validation before deployment.');
    }
    const current = this.state.deployment;
    if (current?.revision === snapshot.revision && (current.status === 'deploying' || current.status === 'succeeded')) {
      return current;
    }
    if (current?.revision === snapshot.revision && current.status === 'failed') {
      await this.terminalizeDeployment(snapshot);
    }
    await this.scheduleDeployment(snapshot, crypto.randomUUID());
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
    this.applyIdentity(identity);
    const workspace = await this.initializeWorkspace(transcriptBinding);
    this.updatePreviewForWorkspace(workspace.revision);
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

  private stashTurn(turn: BuilderTurnState) {
    try {
      this.stash({
        kind: 'cloudchef-chat-turn',
        turn,
        recoveryPlan: {
          onRecovery: 'Persist partial output and continue.',
          contextSource: 'durable AIChatAgent transcript plus this turn checkpoint',
        },
      });
    } catch {
      logger.warn('Unable to stash CloudChef chat turn recovery context');
    }
  }

  private async scheduleTitleGeneration(
    job: TitleGenerationJob,
    accountCredentials: Awaited<ReturnType<typeof getUserWorkersAiCredentials>>,
  ): Promise<void> {
    await this.startFiber(
      TITLE_GENERATION_FIBER,
      async (fiber) => {
        fiber.stash({ ...job, version: 1 });
        await this.generateTitlesForPrompt({ ...job, accountCredentials });
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
    },
  ): Promise<void> {
    const ownerId = this.ownerId;
    if (!ownerId) {
      return;
    }

    // Start model work before persistence so the background request leaves the
    // critical chat path as soon as the first prompt is accepted.
    const conversationTitlePromise = generateConversationTitle(args.prompt, args.accountCredentials);
    const projectTitlePromise =
      args.firstPrompt && args.subchatIndex === 0 ? generateProjectTitle(args.prompt, args.accountCredentials) : null;
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

  private async initializeWorkspace(binding: BuilderTranscriptBinding): Promise<BuilderWorkspaceState> {
    const current = await this.workspace.refresh();
    if (current.initialized) {
      return current;
    }
    if (binding.parentAgentName) {
      const parent = await this.loadParentWorkspace(binding.parentAgentName);
      return this.seedWorkspace(parentBuilderWorkspaceSeedId(parent.targetRevision), parent.entries);
    }
    const template = await loadBuilderTemplate();
    return this.seedWorkspace(builderTemplateSeedId(), template);
  }

  private async createCloudflareMcpToolContext(
    transcript: BuilderTranscriptBinding,
  ): Promise<CloudflareMcpModelToolContext | undefined> {
    const admission = await readCloudflareMcpRuntimeAdmission(this.env);
    if (
      !admission?.controls.cloudflare_mcp ||
      !this.userId ||
      admission.identity.userId !== this.userId ||
      !this.transcriptBinding ||
      !builderTranscriptBindingsEqual(this.transcriptBinding, transcript)
    ) {
      return undefined;
    }
    const expectedIdentity = admission.identity;
    const executeEnabled = cloudflareMcpExecuteEnabled(admission.controls);
    return {
      accountId: expectedIdentity.accountId,
      executeEnabled,
      docs: (input, options) => this.invokeCloudflareReadOnly('docs', input, options, expectedIdentity),
      search: (input, options) => this.invokeCloudflareReadOnly('search', input, options, expectedIdentity),
      proposeExecute: (input, options) => this.proposeCloudflareExecution(input, options, expectedIdentity, transcript),
    };
  }

  private async waitForCloudflareDecisionBoundary(): Promise<void> {
    const stable = await this.waitUntilStable({ timeout: 30_000, pendingInteraction: () => false });
    if (!stable) {
      throw new Response('The builder turn has not finished storing this proposal.', { status: 409 });
    }
  }

  private async invokeCloudflareReadOnly(
    toolName: 'docs',
    input: CloudflareDocsModelInput,
    options: ModelToolExecutionOptions,
    expectedIdentity: CloudflareMcpRuntimeIdentity,
  ): Promise<CloudflareMcpImmediateResult>;
  private async invokeCloudflareReadOnly(
    toolName: 'search',
    input: CloudflareSearchModelInput,
    options: ModelToolExecutionOptions,
    expectedIdentity: CloudflareMcpRuntimeIdentity,
  ): Promise<CloudflareMcpImmediateResult>;
  private async invokeCloudflareReadOnly(
    toolName: 'docs' | 'search',
    input: CloudflareDocsModelInput | CloudflareSearchModelInput,
    options: ModelToolExecutionOptions,
    expectedIdentity: CloudflareMcpRuntimeIdentity,
  ): Promise<CloudflareMcpImmediateResult> {
    const admission = await this.requireCloudflareMcpAdmission(expectedIdentity, false);
    const client = this.createCloudflareMcpClient(admission.identity);
    const signal = options.abortSignal ?? new AbortController().signal;
    try {
      const outcome = await client.invoke(
        toolName === 'docs'
          ? {
              ...admission.identity,
              toolName,
              toolInput: { query: 'query' in input ? input.query : '' },
              signal,
              invocationId: options.toolCallId,
            }
          : {
              ...admission.identity,
              toolName,
              toolInput: { code: 'code' in input ? input.code : '' },
              signal,
              invocationId: options.toolCallId,
            },
      );
      return cloudflareImmediateResult(toolName, admission.identity.accountId, outcome);
    } catch {
      signal.throwIfAborted();
      return {
        kind: 'cloudflare_mcp_result',
        operation: toolName,
        status: 'failure',
        accountId: admission.identity.accountId,
        content: 'The official Cloudflare MCP tool contract is currently unavailable.',
        requestId: null,
        httpStatus: null,
        truncated: false,
      };
    }
  }

  private async proposeCloudflareExecution(
    input: CloudflareExecuteModelInput,
    options: ModelToolExecutionOptions,
    expectedIdentity: CloudflareMcpRuntimeIdentity,
    transcript: BuilderTranscriptBinding,
  ): Promise<CloudflareExecuteProposal> {
    options.abortSignal?.throwIfAborted();
    const admission = await this.requireCloudflareMcpAdmission(expectedIdentity, true);
    if (!this.transcriptBinding || !builderTranscriptBindingsEqual(this.transcriptBinding, transcript)) {
      throw new Error('The transcript changed before the Cloudflare execution proposal was stored.');
    }
    const record = await this.cloudflareExecutions.createProposal({
      toolCallId: options.toolCallId,
      binding: { ...admission.identity, transcript },
      code: input.code,
    });
    this.refreshCloudflareExecutionState();
    return {
      kind: 'cloudflare_execute_proposal',
      status: 'awaiting_approval',
      executionId: record.executionId,
      toolCallId: record.toolCallId,
      accountId: record.accountId,
      code: record.code,
      proposalSha256: record.proposalSha256,
      riskNote: CLOUDFLARE_EXECUTION_RISK_NOTE,
      expiresAt: record.expiresAt,
    };
  }

  private async requireCloudflareMcpAdmission(
    expectedIdentity: CloudflareMcpRuntimeIdentity,
    execute: boolean,
  ): Promise<{ identity: CloudflareMcpRuntimeIdentity; controls: CloudflareMcpRuntimeControls }> {
    const admission = await readCloudflareMcpRuntimeAdmission(this.env);
    if (
      !admission ||
      !cloudflareRuntimeIdentitiesEqual(admission.identity, expectedIdentity) ||
      !admission.controls.cloudflare_mcp ||
      (execute && !cloudflareMcpExecuteEnabled(admission.controls))
    ) {
      throw new Error('Cloudflare MCP is disabled or the authenticated connection changed.');
    }
    return admission;
  }

  private createCloudflareMcpClient(identity: CloudflareMcpRuntimeIdentity): CloudflareMcpClient {
    return new CloudflareMcpClient({
      resolveAccessToken: (options) => resolveUserWorkspaceCloudflareAccessToken(this.env, identity, options),
    });
  }

  private async requireCurrentCloudflareExecutionBinding(reason: string): Promise<CloudflareExecutionBinding> {
    const durableIdentity = await this.hydrateDurableIdentity({ required: true, reason });
    const transcript = this.transcriptBinding;
    const admission = await readCloudflareMcpRuntimeAdmission(this.env);
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
      await this.requireCloudflareMcpAdmission(binding, true);
      const executing = await this.cloudflareExecutions.beginExecution(job.executionId, binding);
      if (!executing) {
        const settled = this.cloudflareExecutions.get(job.executionId);
        if (settled && isCloudflareExecutionTerminal(settled.status)) {
          await this.persistCloudflareExecutionResult(settled);
        }
        return;
      }
      this.refreshCloudflareExecutionState();
      const client = this.createCloudflareMcpClient(binding);
      const outcome = await client.invoke({
        ...binding,
        toolName: 'execute',
        toolInput: { code: executing.code },
        signal: new AbortController().signal,
        invocationId: executing.executionId,
      });
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
    const output: CloudflareExecuteFinalResult = {
      kind: 'cloudflare_execute_result',
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
          invocation?.toolName !== 'cloudflare_execute' ||
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
    while (true) {
      const request: WorkspaceSyncPageRequest = { fromRevision: 0 };
      if (cursor) {
        request.cursor = cursor;
      }
      const page = await parent.getWorkspaceSyncPage(request);
      if (page.restart) {
        entries.length = 0;
        cursor = undefined;
        continue;
      }
      for (const entry of page.entries) {
        if (entry.kind === 'write') {
          entries.push({ path: entry.path, content: entry.content, encoding: entry.encoding });
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
    return terminalizeInterruptedDeploymentForBuilder({
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
   * The user-visible critical path after validation: publish the hosted preview first, then run
   * the production deployment behind it. The preview fiber schedules the deployment when it
   * settles; when no publication is pending (the preview is already serving this revision, or it
   * could not even be queued), the deployment starts directly instead of waiting on anything.
   */
  private async publishValidatedRevision(snapshot: BuilderWorkspaceCheckpoint): Promise<void> {
    const preview = await this.requestPreviewInternal({ validatedSnapshot: snapshot, autoDeploy: true }).catch(() => {
      logger.warn('Unable to queue the validated preview publication');
      return null;
    });
    if (!preview?.pendingId) {
      await this.scheduleDeployment(snapshot).catch(() => logger.warn('Unable to queue the automatic deployment'));
    }
  }

  /** Deployment follows a settled preview publication, never blocking it — and never skipping it. */
  private async scheduleDeploymentAfterPreview(job: PreviewPublicationJob): Promise<void> {
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
    await this.scheduleDeployment(checkpoint).catch(() => logger.warn('Unable to queue the automatic deployment'));
  }

  private async scheduleDeployment(job: DeploymentJob, retryId?: string): Promise<void> {
    const current = this.state.deployment;
    if (
      !retryId &&
      current?.revision === job.revision &&
      (current.status === 'deploying' || current.status === 'succeeded' || current.status === 'failed')
    ) {
      return;
    }
    this.setState({
      ...this.state,
      deployment: { status: 'deploying', ...job },
    });
    try {
      await this.startFiber(
        DEPLOYMENT_FIBER,
        async (fiber) => {
          fiber.stash(job);
          try {
            await this.runDeployment(job);
          } catch (error) {
            this.failDeployment(job, error);
            throw error;
          }
        },
        {
          idempotencyKey: `builder-deployment:${this.name}:${job.workspaceRevision}:${job.revision}${
            retryId ? `:retry:${retryId}` : ''
          }`,
          metadata: job,
        },
      );
    } catch (error) {
      this.failDeployment(job, error);
      throw error;
    }
  }

  private async runDeployment(job: DeploymentJob): Promise<BuilderDeploymentState> {
    const userId = this.userId;
    const transcriptBinding = this.transcriptBinding;
    if (!userId || !transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const startedAt = Date.now();
    const deployment = await this.withPublicationActivity('deployment', (onPlanned) =>
      this.keepAliveWhile(() =>
        deployValidatedRevisionForBuilder({
          context: {
            env: this.env,
            userId,
            chatInitialId: transcriptBinding.chatInitialId,
          },
          workspace: this.workspace,
          toolCallId: deploymentToolCallId(job.workspaceRevision, job.revision),
          validatedRevision: job.revision,
          onPlanned,
        }),
      ),
    );
    const revisionBoundDeployment = { ...deployment, ...job };
    this.setDeploymentResult(job, revisionBoundDeployment);
    console.info({
      event: 'builder_deployment_settled',
      status: revisionBoundDeployment.status,
      durationMs: Date.now() - startedAt,
    });
    return revisionBoundDeployment;
  }

  private failDeployment(job: DeploymentJob, error: unknown): BuilderDeploymentState {
    const deployment = { status: 'failed' as const, ...job, error: deploymentErrorMessage(error) };
    this.setDeploymentResult(job, deployment);
    return deployment;
  }

  private setDeploymentResult(job: DeploymentJob, deployment: BuilderDeploymentState): void {
    if (this.state.deployment?.revision !== job.revision) {
      return;
    }
    this.setState({ ...this.state, deployment });
  }

  private async requestPreviewInternal(
    options: { validatedSnapshot?: BuilderWorkspaceCheckpoint; autoDeploy?: boolean } = {},
  ): Promise<BuilderPreviewState> {
    if (!this.ownerId || !this.userId || !this.transcriptBinding) {
      throw new Response('Agent authentication is required.', { status: 401 });
    }
    const workspace = await this.initializeWorkspace(this.transcriptBinding);
    const current = this.currentPreviewState();
    const snapshot = options.validatedSnapshot ?? (await this.workspace.checkpoint());
    const publishing = current.status === 'queued' || current.status === 'building';
    if (publishing && current.workspaceRevision === workspace.revision) {
      return current;
    }
    if (current.status === 'ready' && current.published?.snapshotRevision === snapshot.revision) {
      return current;
    }
    if (publishing && current.pendingId) {
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
      published: current.published,
    });
    try {
      await this.startFiber(
        PREVIEW_PUBLICATION_FIBER,
        async (fiber) => {
          fiber.stash(job);
          await this.runPreviewPublication(job, fiber.signal);
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

  private async runPreviewPublication(job: PreviewPublicationJob, abortSignal?: AbortSignal): Promise<void> {
    if (!this.isCurrentPreviewJob(job.previewId)) {
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
      const validationToolCallId = `preview:${job.previewId}:validation`;
      const needsValidation = !(await this.workspace.hasSuccessfulValidation(job.snapshotRevision));
      if (needsValidation) {
        this.setValidationProgress(validationToolCallId, 'computer validation');
      }
      let validatedSnapshot: BuilderWorkspaceCheckpoint;
      try {
        const validationRequest: Parameters<typeof validatePreviewCheckpointForBuilder>[0] = {
          workspace: this.workspace,
          requestedSnapshot: {
            workspaceRevision: job.workspaceRevision,
            revision: job.snapshotRevision,
          },
          toolCallId: validationToolCallId,
          onStage: (stage) => this.setValidationProgress(validationToolCallId, stage),
        };
        if (abortSignal) {
          validationRequest.abortSignal = abortSignal;
        }
        validatedSnapshot = await this.keepAliveWhile(() => validatePreviewCheckpointForBuilder(validationRequest));
      } finally {
        if (needsValidation) {
          this.setValidationProgress(validationToolCallId, null);
        }
      }
      abortSignal?.throwIfAborted();
      if (!this.isCurrentPreviewJob(job.previewId)) {
        return;
      }
      const success = await this.withPublicationActivity('preview', (onPlanned) =>
        this.keepAliveWhile(() =>
          previewValidatedRevisionForBuilder({
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
          }),
        ),
      );
      if (!this.isCurrentPreviewJob(job.previewId)) {
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
      await this.schedulePipelineDeploymentAfterPreview(job);
    } catch (error) {
      await this.failPreviewPublication(
        job,
        (error instanceof Error ? error.message : 'The Workers preview publication failed.').slice(-4_000),
      );
      await this.schedulePipelineDeploymentAfterPreview(job);
    }
  }

  /**
   * Deployment follows a settled pipeline preview — never a manual "Build preview", which must not
   * promote to the public production URL. A failed preview still deploys behind the pipeline so one
   * broken preview never costs the user the production deployment.
   */
  private async schedulePipelineDeploymentAfterPreview(job: PreviewPublicationJob): Promise<void> {
    if (job.autoDeploy) {
      await this.scheduleDeploymentAfterPreview(job);
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
    const revision = refreshed?.revision ?? this.workspace.getState().revision;
    this.setPreviewState(failedBuilderPreviewState(this.currentPreviewState(), revision, error));
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
    let validatedSnapshot: BuilderWorkspaceCheckpoint | null = null;
    try {
      validatedSnapshot = await validatedDeploymentCheckpoint(this.workspace);
    } catch {
      logger.warn('Unable to refresh deployment readiness');
    }
    const currentDeployment = this.state.deployment;
    const deployment = validatedSnapshot
      ? currentDeployment?.revision === validatedSnapshot.revision
        ? currentDeployment
        : { status: 'ready' as const, ...validatedSnapshot }
      : null;
    this.setState({
      ...this.state,
      deployment,
    });
    return validatedSnapshot;
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

function cloudflareRuntimeIdentitiesEqual(
  left: CloudflareMcpRuntimeIdentity,
  right: CloudflareMcpRuntimeIdentity,
): boolean {
  return (
    left.userId === right.userId &&
    left.accountId === right.accountId &&
    left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration &&
    left.oauthScopeGrantStatus === right.oauthScopeGrantStatus
  );
}

function cloudflareImmediateResult(
  operation: 'docs' | 'search',
  accountId: string,
  outcome: CloudflareMcpOutcome,
): CloudflareMcpImmediateResult {
  if (outcome.status === 'success') {
    return {
      kind: 'cloudflare_mcp_result',
      operation,
      status: 'success',
      accountId,
      content: outcome.content.map((part) => part.text).join('\n'),
      requestId: outcome.metadata.requestId,
      httpStatus: outcome.metadata.httpStatus,
      truncated: outcome.metadata.truncated,
    };
  }
  if (outcome.status === 'insufficient_scope') {
    return {
      kind: 'cloudflare_mcp_result',
      operation,
      status: 'insufficient_scope',
      accountId,
      content: outcome.message,
      requestId: outcome.metadata.requestId,
      httpStatus: outcome.metadata.httpStatus,
      truncated: outcome.metadata.truncated,
    };
  }
  return {
    kind: 'cloudflare_mcp_result',
    operation,
    status: 'failure',
    accountId,
    content: outcome.error.message,
    requestId: outcome.metadata.requestId,
    httpStatus: outcome.metadata.httpStatus,
    truncated: outcome.metadata.truncated,
  };
}

function safeCloudflareExecutionOutcome(outcome: CloudflareMcpOutcome): CloudflareExecutionSafeOutcome {
  if (outcome.status === 'success') {
    const content = outcome.content.map((part) => part.text).join('\n');
    if (containsCredentialishCloudflareContent(content)) {
      return {
        status: 'success',
        summary: 'Cloudflare completed the approved execution, but sensitive-looking response content was withheld.',
        requestId: outcome.metadata.requestId,
        httpStatus: outcome.metadata.httpStatus,
        truncated: outcome.metadata.truncated,
        sensitiveContentWithheld: true,
      };
    }
    return {
      status: 'success',
      summary: 'Cloudflare completed the approved execution.',
      content,
      requestId: outcome.metadata.requestId,
      httpStatus: outcome.metadata.httpStatus,
      truncated: outcome.metadata.truncated,
    };
  }
  if (outcome.status === 'insufficient_scope') {
    return {
      status: 'insufficient_scope',
      summary: outcome.message,
      requestId: outcome.metadata.requestId,
      httpStatus: outcome.metadata.httpStatus,
      truncated: outcome.metadata.truncated,
    };
  }
  return {
    status: outcome.status,
    summary: outcome.error.message,
    requestId: outcome.metadata.requestId,
    httpStatus: outcome.metadata.httpStatus,
    truncated: outcome.metadata.truncated,
  };
}

function cloudflareExecutionStatusForOutcome(
  outcome: CloudflareMcpOutcome,
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
