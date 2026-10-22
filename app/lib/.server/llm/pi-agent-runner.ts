import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import {
  createInitialSystemMessage,
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Usage,
} from '@earendil-works/pi-ai';
import { normalizeTextPartBoundaries, type PiStreamChunk } from './pi-stream';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { calculatePromptCharacterCounts } from 'cloudchef-agent/context-message-metrics';
import { systemPrompt } from 'cloudchef-agent/prompts/system';
import { toolResultSucceeded } from 'cloudchef-agent/tool-result';
import type { ChatTurnContext } from 'cloudchef-agent/turn-context';
import { logger } from 'cloudchef-agent/utils/logger';
import type { BuilderModel, BuilderReasoningLevel } from '~/lib/workers-ai-model';
import {
  WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE,
  WorkspaceToolOperationIndeterminateError,
  type BuilderWorkspaceApi,
} from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import {
  BUILDER_TURN_FIRST_PROGRESS_MS,
  BUILDER_TURN_INACTIVITY_MS,
  BUILDER_TURN_WALL_CLOCK_MS,
  BuilderTurnLimitError,
  type BuilderTurnLimitReason,
  type BuilderTurnReport,
  type BuilderTurnTerminalReason,
} from './builder-turn-limits';
import {
  compactPiContext,
  estimatePiContextTokens,
  durableHistoryEntries,
  liveHistoryEntry,
  type HistoryEntry,
  type ContextCompaction,
} from './context-compaction';
import { createContextWindowTools } from './context-window-tools';
import { ModelInputBudgetExceededError, modelCompactionPolicy, prepareModelInput } from './model-input';
import { createToolTimeAccounting } from './tool-time-accounting';
import {
  clearOldToolResults,
  MIN_TOOL_RESULT_CLEARING_SAVINGS_TOKENS,
  toolResultClearingTriggerTokens,
} from './tool-result-clearing';
import { getPiModel, type WorkersAiAccountCredentials } from './pi-ai-models';
import type { WorkersAiGatewayLogging } from './workers-ai-gateway';
import {
  recordFirstBuilderMutation,
  recordFirstMeaningfulWorkersAiProgress,
  recordFirstWorkersAiResponse,
  recordPiStage,
  recordPiTurnReport,
  recordWorkersAiFinish,
  turnUsage,
  type ModelTurnUsage,
} from './workers-ai-telemetry';
import { createPiToolBundle } from './pi-tools-adapter';
import { createBuilderSkillContext } from './builder-skills';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';
import { logProviderFailure } from './provider-error-logging';
import { ProviderStopError, providerStopDiagnosticCode } from './provider-stop-error';
import type { PiSteeringQueue } from './pi-steering';
import type { CloudflareApiModelToolContext } from './cloudflare-api-model-tools';
import type { LinkedProjectModelToolContext } from './linked-project-model-tools';
import { isRecord } from 'cloudchef-agent/utils/isRecord';

type Messages = CloudChefMessage[];
type UIMessageChunk = PiStreamChunk;

/** Tools whose execution can durably change the project. */
const DURABLE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'edit', 'exec']);

export interface PiAgentOptions {
  abortSignal?: AbortSignal;
  firstUserMessage: boolean;
  messages: Messages;
  model: BuilderModel;
  /** The reasoning effort the person chose for this model; absent for the provider's default. */
  reasoningLevel?: BuilderReasoningLevel;
  turnContext?: ChatTurnContext;
  compaction: {
    current: ContextCompaction | null;
    save: (compaction: ContextCompaction) => void;
    schedule: () => Promise<void>;
    requestDurableCompaction: () => void;
  };
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
  /** Whether the turn's model requests are logged in the account's AI Gateway, and under what. */
  gatewayLogging: WorkersAiGatewayLogging;
  /** For a gateway provider's model: the alias of the account's key for that provider. */
  gatewayKeyAlias?: string;
  /** Which key that alias names, as Cloudflare last changed it: a different key forgets what the old one was refused. */
  gatewayKeyRevision?: string;
  workspace: BuilderWorkspaceApi;
  cloudflareApi?: CloudflareApiModelToolContext;
  /** Set when the workspace is one of an organization's GitHub projects. */
  linkedProject?: LinkedProjectModelToolContext;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
  steering: PiSteeringQueue;
  onSettled: (report: BuilderTurnReport) => void;
  /** A finished turn's token counts, for an organization's per-member usage. */
  onModelUsage?: (usage: ModelTurnUsage) => void;
}

type PiPreparationStage = 'tool_setup' | 'model_input' | 'prompt_metrics' | 'tool_result_clearing';

/**
 * The reasoning level a builder turn asks for: the person's choice for this model, or `undefined`
 * — "Default" — when they made none, which leaves the provider at its own default effort; why
 * reasoning is never turned off is `provider-default-reasoning.ts`.
 */
function builderThinkingLevel(
  model: { reasoning: boolean },
  chosen: BuilderReasoningLevel | undefined,
): BuilderReasoningLevel | undefined {
  return model.reasoning ? chosen : undefined;
}

/**
 * The model spent its entire output budget without streaming any visible text or tool call —
 * reasoning-heavy models do this and would otherwise end the turn silently "completed".
 */
class HiddenReasoningExhaustionError extends Error {
  constructor() {
    super(
      'The model used up its output budget on internal reasoning without producing a result. Retry, or pick a different model.',
    );
    this.name = 'HiddenReasoningExhaustionError';
  }
}

class PiAgentPreparationError extends Error {
  readonly diagnosticCode: string;

  constructor(stage: PiPreparationStage, cause: unknown) {
    super(`Pi agent preparation failed during ${stage}.`, { cause });
    this.name = 'PiAgentPreparationError';
    this.diagnosticCode = `pi_prepare:${stage}`;
  }
}

/**
 * Runs a builder turn and streams it. A turn that fails before it streams is thrown as the Response the
 * browser shows: 413 for input too large to send, otherwise a bare 500, with only the failure's
 * non-identifying facts logged.
 */
export async function piAgentRunner(options: PiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  try {
    return await startPiAgent(options);
  } catch (error) {
    logProviderFailure(logger, 'Workers AI chat request failed', error);
    if (error instanceof ModelInputBudgetExceededError) {
      throw new Response(error.message, { status: 413, statusText: 'Current request is too large' });
    }
    throw new Response(null, { status: 500, statusText: 'Internal Server Error' });
  }
}

async function startPiAgent(options: PiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const {
    abortSignal,
    firstUserMessage,
    messages,
    model,
    turnContext,
    compaction,
    accountCredentials,
    sessionAffinity,
    gatewayLogging,
    gatewayKeyAlias,
    gatewayKeyRevision,
    workspace,
    cloudflareApi,
    linkedProject,
    onValidationStage,
    runWithKeepAlive,
    steering,
    onSettled,
  } = options;

  const startedAt = Date.now();
  const modelId = model.id;
  const handle = getPiModel(accountCredentials, modelId, {
    model,
    sessionAffinity,
    gatewayLogging,
    gatewayKeyAlias,
    gatewayKeyRevision,
  });
  // Real signals, so an in-flight model stream is bounded too — not just the gaps between turns.
  const wallClockSignal = AbortSignal.timeout(BUILDER_TURN_WALL_CLOCK_MS);
  const inactivityController = new AbortController();
  const firstProgressController = new AbortController();
  const limitSignals = [wallClockSignal, inactivityController.signal, firstProgressController.signal];
  const loopSignal = AbortSignal.any(abortSignal ? [abortSignal, ...limitSignals] : limitSignals);
  /** A hung turn stays distinct from an owner cancellation or a durable teardown. */
  const reachedLimitReason = (): BuilderTurnLimitReason | undefined => {
    if (abortSignal?.aborted) {
      return undefined;
    }
    if (firstProgressController.signal.aborted) {
      return 'no_first_progress';
    }
    return inactivityController.signal.aborted ? 'inactivity' : wallClockSignal.aborted ? 'wall_clock' : undefined;
  };
  const limitErrorForFailure = (error: unknown): unknown => {
    const reason = error instanceof BuilderTurnLimitError ? undefined : reachedLimitReason();
    return reason ? new BuilderTurnLimitError(reason) : error;
  };
  const { skillContext, piTools } = await withPreparationStage('tool_setup', async () => {
    const skillContext = createBuilderSkillContext({ linkedProject: linkedProject !== undefined });
    return {
      skillContext,
      piTools: createPiToolBundle(
        workspace,
        { onValidationStage, runWithKeepAlive },
        skillContext.reader,
        cloudflareApi,
        linkedProject,
      ),
    };
  });

  const archivedHistory: HistoryEntry[] = [];
  const archivedMessages = new Set<AgentMessage>();
  /** Copies whose output was cleared from the model's view; history keeps the originals instead. */
  const clearedCopies = new WeakSet<AgentMessage>();
  const checkpointReminders = new Set<AgentMessage>();
  const archive = (entries: AgentMessage[]) => {
    for (const entry of entries) {
      // The system prompt and tool declarations are configuration, not conversation history.
      if (entry.role !== 'system' && !archivedMessages.has(entry) && !clearedCopies.has(entry)) {
        archivedMessages.add(entry);
        archivedHistory.push(liveHistoryEntry(entry, `live-${archivedHistory.length}`));
      }
    }
  };
  let rolloverRequested = false;
  let manualHandoff: string | undefined;
  let checkpointReminderSent = false;
  Object.assign(
    piTools,
    createContextWindowTools({
      history: () => [...durableHistoryEntries(messages), ...archivedHistory],
      requestRollover: (handoff) => {
        manualHandoff = handoff;
        rolloverRequested = true;
        compaction.requestDurableCompaction();
      },
    }),
  );

  const instructions = systemPrompt(skillContext.prompt, linkedProject);
  const modelInput = await withPreparationStage('model_input', () =>
    prepareModelInput({
      messages,
      turnContext,
      currentCompaction: compaction.current,
      scheduleCompaction: compaction.schedule,
      signal: loopSignal,
      contextWindow: handle.model.contextWindow,
      systemPrompt: instructions,
      tools: Object.values(piTools),
    }),
  );
  if (modelInput.nextCompaction) {
    compaction.save(modelInput.nextCompaction);
  }

  const promptCharacterCounts = withPreparationStage('prompt_metrics', () =>
    calculatePromptCharacterCounts(modelInput.promptMessages, instructions),
  );
  const compactionPolicy = modelCompactionPolicy(handle.model.contextWindow);
  const clearingTriggerTokens = toolResultClearingTriggerTokens(compactionPolicy.hardLimitTokens);
  /** Clears old tool output once the context is large, when doing so frees enough to be worth a cache miss. */
  const withOldToolResultsCleared = (source: AgentMessage[], tokens: number) => {
    if (tokens < clearingTriggerTokens) {
      return { messages: source, tokens };
    }
    const cleared = clearOldToolResults(source);
    if (cleared.savedTokens < MIN_TOOL_RESULT_CLEARING_SAVINGS_TOKENS) {
      return { messages: source, tokens };
    }
    for (const copy of cleared.cleared) {
      clearedCopies.add(copy);
    }
    return { messages: cleared.messages, tokens: tokens - cleared.savedTokens };
  };
  const piMessages = withPreparationStage(
    'tool_result_clearing',
    () => withOldToolResultsCleared(modelInput.messages, modelInput.estimatedTokens).messages,
  );
  const replayedMessages = new Set<AgentMessage>(piMessages);
  recordPiStage('prepared', modelId);

  const streamedToolCalls = new Map<number, { toolCallId: string; toolName: string }>();
  const completedToolInputs = new Set<string>();
  let recordedFirstResponse = false;
  let terminalAssistant: AssistantMessage | undefined;
  let totalUsage = emptyUsage();
  let currentTurnStreamedContent = false;
  let runtimeContextCompacted = false;
  let toolIndeterminateError: WorkspaceToolOperationIndeterminateError | undefined;
  let cloudflareApprovalPending = false;
  let terminalReason: BuilderTurnTerminalReason = 'failed';
  let stepCount = 0;
  let toolCallCount = 0;
  let toolsInFlight = 0;
  let durableMutationStarted = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let firstProgressTimer: ReturnType<typeof setTimeout> | undefined;
  const toolAccounting = createToolTimeAccounting();

  /** Stop for an indeterminate workspace operation or a pending user approval. */
  const turnInterrupted = () => toolIndeterminateError !== undefined || cloudflareApprovalPending;

  const clearInactivityWatchdog = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };
  /** Tools already carry their own deadlines, so only watch the gaps between them. */
  const armInactivityWatchdog = () => {
    clearInactivityWatchdog();
    if (toolsInFlight === 0) {
      inactivityTimer = setTimeout(() => inactivityController.abort(), BUILDER_TURN_INACTIVITY_MS);
    }
  };
  /** Disarms the first-progress deadline for the rest of the turn, the first time it is called. */
  const observeMeaningfulProgress = () => {
    if (firstProgressTimer !== undefined) {
      clearTimeout(firstProgressTimer);
      firstProgressTimer = undefined;
      recordFirstMeaningfulWorkersAiProgress(startedAt);
    }
  };

  const { readable, writable } = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = writable.getWriter();

  const emit = async (event: AgentEvent) => {
    if (event.type === 'message_end') {
      archive([event.message]);
    }
    if (event.type === 'tool_execution_start') {
      toolsInFlight += 1;
      toolAccounting.start(event.toolCallId, event.toolName);
      observeMeaningfulProgress();
      if (!durableMutationStarted && DURABLE_MUTATION_TOOL_NAMES.has(event.toolName)) {
        durableMutationStarted = true;
        recordFirstBuilderMutation(startedAt, event.toolName);
      }
    } else if (event.type === 'tool_execution_end') {
      toolsInFlight = Math.max(0, toolsInFlight - 1);
      toolCallCount += 1;
      toolAccounting.end(event.toolCallId);
    } else if (event.type === 'turn_end') {
      toolsInFlight = 0;
      toolAccounting.settle();
    }
    armInactivityWatchdog();

    if (event.type === 'turn_start') {
      currentTurnStreamedContent = false;
      return;
    }

    if (event.type === 'message_update') {
      if (!recordedFirstResponse) {
        recordedFirstResponse = true;
        recordFirstWorkersAiResponse(startedAt);
      }
      const assistantEvent = event.assistantMessageEvent;
      if (isMeaningfulAssistantEvent(assistantEvent)) {
        observeMeaningfulProgress();
        currentTurnStreamedContent = true;
      } else if (isReasoningProgressEvent(assistantEvent)) {
        // A model that is reasoning is working, so it must not trip the first-progress deadline.
        // It has still streamed no content, so hidden-reasoning exhaustion and overflow recovery
        // keep treating this turn as having produced nothing.
        observeMeaningfulProgress();
      }
      const streamPartId = `pi-${event.message.timestamp}-${eventContentIndex(assistantEvent) ?? 0}`;
      if (assistantEvent.type === 'text_start') {
        await writer.write({ type: 'text-start', id: streamPartId });
      } else if (assistantEvent.type === 'text_delta' && assistantEvent.delta) {
        await writer.write({ type: 'text-delta', id: streamPartId, delta: assistantEvent.delta });
      } else if (assistantEvent.type === 'text_end') {
        await writer.write({ type: 'text-end', id: streamPartId });
      } else if (assistantEvent.type === 'thinking_start') {
        // Reasoning is shown live so the wait is legible, and it stays out of the turn's content
        // accounting: a turn that only thought still counts as having produced nothing.
        await writer.write({ type: 'reasoning-start', id: streamPartId });
      } else if (assistantEvent.type === 'thinking_delta' && assistantEvent.delta) {
        await writer.write({ type: 'reasoning-delta', id: streamPartId, delta: assistantEvent.delta });
      } else if (assistantEvent.type === 'thinking_end') {
        await writer.write({ type: 'reasoning-end', id: streamPartId });
      } else if (assistantEvent.type === 'toolcall_start') {
        const streamed = streamedToolCall(assistantEvent);
        if (streamed) {
          streamedToolCalls.set(streamed.contentIndex, streamed);
          await writer.write({
            type: 'tool-input-start',
            toolCallId: streamed.toolCallId,
            toolName: streamed.toolName,
            dynamic: true,
          });
        }
      } else if (assistantEvent.type === 'toolcall_delta') {
        const streamed = streamedToolCalls.get(assistantEvent.contentIndex);
        if (streamed) {
          await writer.write({
            type: 'tool-input-delta',
            toolCallId: streamed.toolCallId,
            inputTextDelta: assistantEvent.delta,
          });
        }
      } else if (assistantEvent.type === 'toolcall_end') {
        const { toolCall } = assistantEvent;
        if (toolCall.id && toolCall.name) {
          completedToolInputs.add(toolCall.id);
          await writer.write({
            type: 'tool-input-available',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.arguments,
            dynamic: true,
          });
        }
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      if (!completedToolInputs.has(event.toolCallId)) {
        await writer.write({
          type: 'tool-input-start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          dynamic: true,
        });
        await writer.write({
          type: 'tool-input-available',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.args,
          dynamic: true,
        });
        completedToolInputs.add(event.toolCallId);
      }
      return;
    }

    if (event.type === 'tool_execution_update') {
      await writer.write({
        type: 'data-tool-progress',
        id: event.toolCallId,
        data: { toolCallId: event.toolCallId, toolName: event.toolName, result: event.partialResult },
        transient: true,
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      const result = piToolResultDetails(event.result);
      toolIndeterminateError ??= event.isError ? toolIndeterminateErrorFromResult(event.result) : undefined;
      // A proposal is a completed tool result, but it deliberately ends this Pi run before another model step.
      cloudflareApprovalPending ||=
        event.toolName === 'cloudflare_request' && isRecord(result) && result.kind === 'cloudflare_request_proposal';
      if (event.isError && !hasStructuredToolResult(event.result)) {
        await writer.write({
          type: 'tool-output-error',
          toolCallId: event.toolCallId,
          errorText: piToolResultError(event.result),
          dynamic: true,
        });
      } else {
        await writer.write({
          type: 'tool-output-available',
          toolCallId: event.toolCallId,
          output: result,
          dynamic: true,
        });
      }
      return;
    }

    if (event.type === 'turn_end') {
      stepCount += 1;
      if (isAssistantMessage(event.message)) {
        terminalAssistant = event.message;
        totalUsage = addUsage(totalUsage, event.message.usage);
      }
    }
  };

  const tools = Object.values(piTools);
  // Pi 1.0 carries the prompt and tool declarations in the transcript itself. Declaring the tools
  // up front keeps the loop from appending a tool-change system message before the first request.
  const systemMessage = createInitialSystemMessage(instructions, tools);
  let context: AgentContext = {
    messages: systemMessage ? [systemMessage, ...piMessages] : piMessages,
    tools,
  };

  const compactRuntimeContext = async (source: AgentContext): Promise<AgentContext | undefined> => {
    if (loopSignal.aborted) {
      return undefined;
    }
    archive(source.messages);
    const compacted = compactPiContext({
      messages: source.messages,
      durableMessages: messages,
      // Replayed requests are already listed under their real ids from the durable transcript.
      previousInputs: [...archivedMessages].filter(
        (message) => message.role === 'user' && !checkpointReminders.has(message) && !replayedMessages.has(message),
      ),
      // The current prompt is listed from the durable transcript, without the context injected into it.
      turnContext: turnContext?.content,
      handoff: manualHandoff,
    });
    if (!compacted) {
      return undefined;
    }
    manualHandoff = undefined;
    rolloverRequested = false;
    checkpointReminderSent = false;
    runtimeContextCompacted = true;
    compaction.requestDurableCompaction();
    return { ...source, messages: compacted.messages };
  };

  void (async () => {
    try {
      await writer.write({ type: 'start' });
      recordPiStage('loop_start', modelId);
      const loopConfig: AgentLoopConfig & { toolChoice: 'auto' } = {
        model: handle.model,
        // SAFETY: every message in this loop's context originates from `transcriptToPiMessages`, the Pi
        // tool adapter, or the Pi stream itself, so the context never holds a custom agent message.
        convertToLlm: (agentMessages) => agentMessages as Message[],
        getSteeringMessages: () => steering.drain(),
        prepareNextTurn: async ({ message, context: turnContext }) => {
          archive(turnContext.messages);
          const wouldContinue = message.content.some((part) => part.type === 'toolCall');
          if (!wouldContinue) {
            return undefined;
          }
          const policy = compactionPolicy;
          const visible = withOldToolResultsCleared(
            turnContext.messages,
            estimatePiContextTokens(turnContext.messages),
          );
          const tokens = visible.tokens;
          if (!rolloverRequested && tokens < policy.hardLimitTokens) {
            if (!checkpointReminderSent && tokens >= policy.proactiveTokens) {
              checkpointReminderSent = true;
              const reminder: AgentMessage = {
                role: 'user',
                content:
                  'Context checkpoint: save longer working notes in the project, then call new_context with concise goal, progress, decisions, failures, and next steps. Earlier conversation remains available through history.',
                timestamp: Date.now(),
              };
              checkpointReminders.add(reminder);
              context = { ...turnContext, messages: [...visible.messages, reminder] };
              return { context };
            }
            if (visible.messages !== turnContext.messages) {
              context = { ...turnContext, messages: visible.messages };
              return { context };
            }
            return undefined;
          }
          const compacted = await compactRuntimeContext(turnContext);
          if (!compacted) {
            return undefined;
          }
          context = compacted;
          return { context: compacted };
        },
        finishTurn: (turn) => {
          if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') {
            return undefined;
          }
          return turnInterrupted() ? { action: 'end' } : undefined;
        },
        afterToolCall: async ({ result, isError }) =>
          !isError && !toolResultSucceeded(result.details) ? { isError: true } : undefined,
        maxTokens: handle.model.maxTokens,
        reasoning: builderThinkingLevel(handle.model, options.reasoningLevel),
        toolChoice: 'auto',
      };

      armInactivityWatchdog();
      // Armed once, when the model request starts: the first meaningful event disarms it for good.
      firstProgressTimer = setTimeout(() => firstProgressController.abort(), BUILDER_TURN_FIRST_PROGRESS_MS);
      let overflowRecoveryAttempted = false;
      while (true) {
        terminalAssistant = undefined;
        await runAgentLoopContinue(context, loopConfig, emit, loopSignal, handle.stream);
        if (
          terminalAssistant &&
          isContextOverflow(terminalAssistant, handle.model.contextWindow) &&
          !overflowRecoveryAttempted &&
          !currentTurnStreamedContent &&
          !abortSignal?.aborted
        ) {
          overflowRecoveryAttempted = true;
          if (context.messages.at(-1)?.role === 'assistant') {
            context = { ...context, messages: context.messages.slice(0, -1) };
          }
          const compacted = await compactRuntimeContext(context);
          if (!compacted) {
            break;
          }
          context = compacted;
          continue;
        }
        break;
      }

      recordPiStage('loop_complete', modelId);
      const finalAssistant = assistantMessageValue(terminalAssistant);
      if (toolIndeterminateError) {
        throw toolIndeterminateError;
      }
      const limitReason = reachedLimitReason();
      if (limitReason) {
        throw new BuilderTurnLimitError(limitReason);
      }
      if (finalAssistant?.stopReason === 'error') {
        const stopText = finalAssistant.errorMessage || 'The model request failed.';
        throw new ProviderStopError(stopText, providerStopDiagnosticCode(stopText));
      }
      if (finalAssistant?.stopReason === 'aborted' && !abortSignal?.aborted) {
        throw new ProviderStopError(
          finalAssistant.errorMessage || 'The model request was aborted.',
          'provider_aborted',
        );
      }
      if (finalAssistant?.stopReason === 'length' && !currentTurnStreamedContent) {
        throw new HiddenReasoningExhaustionError();
      }
      const finalContextTokens = estimatePiContextTokens(context.messages);
      if (finalContextTokens >= compactionPolicy.proactiveTokens) {
        compaction.requestDurableCompaction();
      }
      const turnUsage = recordWorkersAiFinish({
        usage: totalUsage,
        finishReason: finalAssistant?.stopReason ?? 'stop',
        firstUserMessage,
        contextReduced: modelInput.contextCompacted || runtimeContextCompacted,
        estimatedContextTokens: Math.max(modelInput.estimatedTokens, finalContextTokens),
        promptCharacterCounts,
        providerModel: modelId,
        startedAt,
      });
      options.onModelUsage?.(turnUsage);
      terminalReason = abortSignal?.aborted ? 'cancelled' : 'completed';
    } catch (cause) {
      // A turn that fails part-way has still used the tokens it got through; the organization pays for them.
      const failedUsage = turnUsage(totalUsage);
      if (failedUsage.inputTokens + failedUsage.outputTokens > 0) {
        options.onModelUsage?.(failedUsage);
      }
      const error = limitErrorForFailure(cause);
      terminalReason =
        error instanceof BuilderTurnLimitError ? error.reason : abortSignal?.aborted ? 'cancelled' : 'failed';
      recordPiStage('loop_error', modelId);
      logProviderFailure(logger, 'Pi agent runner failed.', error);
      if (
        (error instanceof BuilderTurnLimitError ||
          error instanceof WorkspaceToolOperationIndeterminateError ||
          error instanceof HiddenReasoningExhaustionError) &&
        !abortSignal?.aborted
      ) {
        await writer.write({ type: 'error', errorText: error.message });
      } else if (isWorkersAiFreeAllocationError(error)) {
        await writer.write({ type: 'error', errorText: workersPaidRequiredMessage() });
      } else if (!abortSignal?.aborted) {
        await writer.write({
          type: 'error',
          errorText: providerFailureText(error instanceof Error ? error.message : String(error)),
        });
      }
    } finally {
      clearInactivityWatchdog();
      clearTimeout(firstProgressTimer);
      steering.close();
      toolAccounting.settle();
      const report: BuilderTurnReport = {
        terminalReason,
        stepCount,
        toolCallCount,
        elapsedMs: Date.now() - startedAt,
        toolWallClockMs: toolAccounting.wallClockMs(),
        toolMsByName: toolAccounting.byName(),
        changedProject: durableMutationStarted,
      };
      recordPiTurnReport(modelId, report);
      onSettled(report);
      await writer
        .write({
          type: 'finish',
          finishReason: assistantMessageValue(terminalAssistant)?.stopReason === 'length' ? 'length' : 'stop',
        })
        .catch(() => undefined);
      await writer.close().catch(() => undefined);
    }
  })();

  return normalizeTextPartBoundaries(readable);
}

/** A provider rejection body is unbounded; the chat line only needs the head of it. */
const MAX_PROVIDER_REASON_CHARACTERS = 300;

/**
 * The `error` chunk reaches only the account owner's own chat, so the provider's own wording is
 * carried through. Without it every distinct failure — a truncated stream, a rejected request body,
 * a 400 naming the offending field — renders as one generic sentence and cannot be acted on. The
 * reason must not additionally be logged.
 */
function providerFailureText(reason: string): string {
  const trimmed = reason.trim().replace(/[.\s]+$/, '');
  if (!trimmed) {
    return 'The model request failed. Please retry.';
  }
  if (trimmed.length > MAX_PROVIDER_REASON_CHARACTERS) {
    return `The model request failed: ${trimmed.slice(0, MAX_PROVIDER_REASON_CHARACTERS)}… Retry, or pick a different model.`;
  }
  return `The model request failed: ${trimmed}. Retry, or pick a different model.`;
}

function piToolResultDetails(result: unknown): unknown {
  return isRecord(result) && 'details' in result ? result.details : result;
}

function hasStructuredToolResult(result: unknown): boolean {
  const details = piToolResultDetails(result);
  return isRecord(details) && Object.keys(details).length > 0;
}

function firstTextBlock(blocks: readonly unknown[]): string | undefined {
  return blocks.find(
    (block): block is { type: 'text'; text: string } =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string',
  )?.text;
}

function piToolResultError(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = firstTextBlock(result.content);
    if (text) {
      return text;
    }
  }
  const details = piToolResultDetails(result);
  return isRecord(details) && typeof details.summary === 'string' ? details.summary : 'Tool execution failed.';
}

function toolIndeterminateErrorFromResult(result: unknown): WorkspaceToolOperationIndeterminateError | undefined {
  const payload = toolErrorPayload(result);
  return payload?.code === WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE && typeof payload.error === 'string'
    ? new WorkspaceToolOperationIndeterminateError(payload.error)
    : undefined;
}

function toolErrorPayload(result: unknown): { code?: unknown; error?: unknown } | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return undefined;
  }
  const text = firstTextBlock(result.content);
  if (!text) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(text);
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `terminalAssistant` is only ever assigned from the event handler, so control-flow analysis still
 * believes it is `undefined` where the loop result is read. Passing it through a declared parameter
 * restores its declared type without asserting anything.
 */
function assistantMessageValue(message: AssistantMessage | undefined): AssistantMessage | undefined {
  return message;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, usage: Usage): Usage {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: {
      input: total.cost.input + usage.cost.input,
      output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total,
    },
  };
}

function eventContentIndex(event: AssistantMessageEvent): number | undefined {
  return 'contentIndex' in event ? event.contentIndex : undefined;
}

/**
 * Visible text or a streamed tool call: the model is producing something the user or the workspace
 * will act on. This is the stricter of the two tests, because it also decides whether the turn
 * streamed content at all — the signal behind hidden-reasoning exhaustion and overflow recovery.
 */
function isMeaningfulAssistantEvent(event: AssistantMessageEvent): boolean {
  return (
    event.type === 'text_start' ||
    event.type === 'text_delta' ||
    event.type === 'toolcall_start' ||
    event.type === 'toolcall_delta' ||
    event.type === 'toolcall_end'
  );
}

/**
 * The model is reasoning. Nothing is visible yet and nothing may ever be, so this is not content —
 * but it is unambiguously work, and killing a high-effort model for thinking is the one thing the
 * first-progress deadline must never do. Every other event is transport framing.
 */
function isReasoningProgressEvent(event: AssistantMessageEvent): boolean {
  return event.type === 'thinking_start' || event.type === 'thinking_delta';
}

/** The tool call a `toolcall_start` event opened, taken from the partial message it carries. */
function streamedToolCall(
  event: Extract<AssistantMessageEvent, { type: 'toolcall_start' }>,
): { contentIndex: number; toolCallId: string; toolName: string } | undefined {
  const call = event.partial.content[event.contentIndex];
  if (call?.type !== 'toolCall' || !call.id || !call.name) {
    return undefined;
  }
  return { contentIndex: event.contentIndex, toolCallId: call.id, toolName: call.name };
}

function withPreparationStage<T>(stage: PiPreparationStage, operation: () => Promise<T>): Promise<T>;
function withPreparationStage<T>(stage: PiPreparationStage, operation: () => T): T;
function withPreparationStage<T>(stage: PiPreparationStage, operation: () => T | Promise<T>): T | Promise<T> {
  try {
    const result = operation();
    return result instanceof Promise ? result.catch((error: unknown) => rethrowPreparationError(stage, error)) : result;
  } catch (error) {
    return rethrowPreparationError(stage, error);
  }
}

function rethrowPreparationError(stage: PiPreparationStage, error: unknown): never {
  if (error instanceof ModelInputBudgetExceededError) {
    throw error;
  }
  throw new PiAgentPreparationError(stage, error);
}
