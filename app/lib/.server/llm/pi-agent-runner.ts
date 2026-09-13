import {
  runAgentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentToolResult,
} from '@earendil-works/pi-agent-core';
import {
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message,
  type Usage,
} from '@earendil-works/pi-ai';
import type { PiStreamChunk } from './pi-stream';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { calculatePromptCharacterCounts } from 'ghostbuild-agent/context-message-metrics';
import { systemPrompt } from 'ghostbuild-agent/prompts/system';
import { toolResultSucceeded } from 'ghostbuild-agent/tool-result';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { logger } from 'ghostbuild-agent/utils/logger';
import type { WorkersAiModel } from '~/lib/workers-ai-model';
import {
  WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE,
  WorkspaceToolOperationIndeterminateError,
  type BuilderWorkspaceApi,
} from '~/agents/builder-workspace-api';
import {
  AUTO_VALIDATION_TOOL_CALL_ID_PREFIX,
  type BuilderValidationStage,
} from '~/lib/common/builder-validation-progress';
import {
  BUILDER_TURN_BUDGET_ERROR_CODE,
  BUILDER_TURN_FIRST_PROGRESS_MS,
  BUILDER_TURN_INACTIVITY_MS,
  BUILDER_TURN_WALL_CLOCK_MS,
  BuilderTurnBudgetExceededError,
  type BuilderTurnBudgetReason,
  type BuilderTurnBudgetReport,
  type BuilderTurnTerminalReason,
} from './builder-turn-budget';
import { compactPiContext, estimatePiContextTokens, type ContextCompaction } from './context-compaction';
import {
  ContextCompactionUnavailableError,
  ModelInputBudgetExceededError,
  modelCompactionPolicy,
  prepareModelInput,
} from './model-input';
import { modelMessagesToPi } from './pi-message-conversion';
import { recordPiStage, recordPiTurnBudget } from './pi-telemetry';
import { createToolTimeAccounting } from './tool-time-accounting';
import { getPiModel, type WorkersAiAccountCredentials } from './pi-ai-models';
import { appendDeterministicCompletion, normalizeTextPartBoundaries } from './workers-ai-stream';
import {
  recordFirstBuilderMutation,
  recordFirstMeaningfulWorkersAiProgress,
  recordFirstWorkersAiResponse,
  recordWorkersAiFinish,
} from './workers-ai-telemetry';
import { getValidatedBuildCompletion } from './workers-ai-tools';
import { createPiToolBundle, piToolsToList } from './pi-tools-adapter';
import { createBuilderSkillContext } from './builder-skills';
import {
  cloudflareAiFundingRequiredMessage,
  isCloudflareAiFundingError,
  isWorkersAiFreeAllocationError,
  workersPaidRequiredMessage,
} from '~/lib/workers-paid';
import { logProviderFailure } from './provider-error-logging';
import { ProviderStopError, providerStopDiagnosticCode } from './provider-stop-error';
import type { PiSteeringQueue } from './pi-steering';
import type { CloudflareMcpModelToolContext } from './cloudflare-mcp-model-tools';
import { isCloudflareExecuteProposal } from 'ghostbuild-agent/cloudflare-mcp';
import type { CloudflareMcpResultCandidate } from 'ghostbuild-agent/cloudflare-mcp';

type Messages = GhostbuildMessage[];
type UIMessageChunk = PiStreamChunk;

/** Tools whose execution durably changes the project, for telemetry and the end-of-turn validation guarantee. */
const DURABLE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'edit', 'exec']);

/**
 * How many times one turn may run the canonical validation on the model's behalf. The first run
 * covers a model that finished without validating; the rest cover its repairs of those failures.
 */
const MAX_AUTO_VALIDATION_ATTEMPTS = 3;

interface PiAgentOptions {
  abortSignal?: AbortSignal;
  firstUserMessage: boolean;
  messages: Messages;
  model: WorkersAiModel;
  turnContext?: ChatTurnContext;
  compaction: {
    current: ContextCompaction | null;
    pending: boolean;
    summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
    save: (compaction: ContextCompaction) => void;
    schedule?: () => Promise<void>;
    requestDurableCompaction?: () => void;
  };
  accountCredentials: WorkersAiAccountCredentials;
  sessionAffinity: string;
  workspace: BuilderWorkspaceApi;
  cloudflareMcp?: CloudflareMcpModelToolContext;
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
  steering: PiSteeringQueue;
  onSettled: (budget: BuilderTurnBudgetReport) => void;
}

type PiPreparationStage = 'tool_setup' | 'model_input' | 'prompt_metrics' | 'message_conversion';

/**
 * Every reasoning model thinks at full effort — Ghostbuild builds software, which is exactly the
 * work reasoning is for, and no model family is throttled below the others. Passing a level at all
 * still matters: it serializes to `reasoning_effort` plus the family's thinking parameter, and
 * verified against production Workers AI, GLM 5.3 Flash with no directive (or `thinking: disabled`,
 * which it ignores) reasons until `length` and returns EMPTY content, while `thinking: enabled` +
 * `reasoning_effort` answers with real content. The earlier per-family downgrade to `low` was a
 * workaround for the 24,576-token output cap that no longer exists: a request now gets the whole
 * remainder of the context window, so reasoning and the answer no longer compete for a few
 * thousand tokens.
 */
function builderThinkingLevel(model: { reasoning: boolean }): 'high' | undefined {
  return model.reasoning ? 'high' : undefined;
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

export async function piAgentRunner(options: PiAgentOptions): Promise<ReadableStream<UIMessageChunk>> {
  const {
    abortSignal,
    firstUserMessage,
    messages,
    model,
    turnContext,
    compaction,
    accountCredentials,
    sessionAffinity,
    workspace,
    cloudflareMcp,
    onValidationStage,
    runWithKeepAlive,
    steering,
    onSettled,
  } = options;

  logger.debug('Starting Pi agent runner');
  const startedAt = Date.now();
  const modelId = model.id;
  const handle = getPiModel(accountCredentials, modelId, { model, sessionAffinity });
  // Real signals, so an in-flight model stream is bounded too — not just the gaps between turns.
  const wallClockSignal = AbortSignal.timeout(BUILDER_TURN_WALL_CLOCK_MS);
  const inactivityController = new AbortController();
  const firstProgressController = new AbortController();
  const budgetSignals = [wallClockSignal, inactivityController.signal, firstProgressController.signal];
  const loopSignal = AbortSignal.any(abortSignal ? [abortSignal, ...budgetSignals] : budgetSignals);
  /** Budget exhaustion stays distinct from an owner cancellation or a durable teardown. */
  const exhaustedBudgetReason = (): BuilderTurnBudgetReason | undefined => {
    if (abortSignal?.aborted) {
      return undefined;
    }
    if (firstProgressController.signal.aborted) {
      return 'no_first_progress';
    }
    return inactivityController.signal.aborted ? 'inactivity' : wallClockSignal.aborted ? 'wall_clock' : undefined;
  };
  const budgetErrorForFailure = (error: unknown): unknown => {
    const reason = error instanceof BuilderTurnBudgetExceededError ? undefined : exhaustedBudgetReason();
    return reason ? new BuilderTurnBudgetExceededError(reason) : error;
  };
  const compactionPolicy = modelCompactionPolicy(handle.model.contextWindow);
  const { skillContext, piTools } = await withPreparationStage('tool_setup', async () => {
    const skillContext = createBuilderSkillContext();
    return {
      skillContext,
      piTools: createPiToolBundle(
        workspace,
        { onValidationStage, runWithKeepAlive },
        skillContext.reader,
        cloudflareMcp,
      ),
    };
  });

  const validatedBuildCompletion = getValidatedBuildCompletion(messages);
  if (validatedBuildCompletion && !steering.hasPending()) {
    logger.info('Returning validated build completion without another model turn (pi)');
    steering.close();
    onSettled({
      terminalReason: 'completed',
      stepCount: 0,
      toolCallCount: 0,
      elapsedMs: Date.now() - startedAt,
      toolWallClockMs: 0,
      toolMsByName: {},
      lastValidationState: 'validated',
    });
    return createValidatedBuildCompletionStream(validatedBuildCompletion);
  }

  const instructions = systemPrompt(skillContext.prompt);
  const modelInput = await withPreparationStage('model_input', () =>
    prepareModelInput({
      messages,
      turnContext,
      currentCompaction: compaction.current,
      compactionPending: compaction.pending,
      summarize: compaction.summarize,
      scheduleCompaction: compaction.schedule,
      signal: loopSignal,
      contextWindow: handle.model.contextWindow,
      systemPrompt: instructions,
      tools: piToolsToList(piTools),
      logger,
    }),
  );
  if (modelInput.nextCompaction) {
    compaction.save(modelInput.nextCompaction);
  }

  const promptCharacterCounts = withPreparationStage('prompt_metrics', () =>
    calculatePromptCharacterCounts(modelInput.promptMessages, instructions),
  );
  const piMessages = withPreparationStage('message_conversion', () => modelMessagesToPi(modelInput.messages));
  recordPiStage('prepared', modelId);

  let currentValidatedBuildCompletion: string | undefined;
  const currentRunToolResults: Array<{ toolName: string; result: unknown }> = [];
  const streamedToolCalls = new Map<number, { toolCallId: string; toolName: string }>();
  const completedToolInputs = new Set<string>();
  let recordedFirstResponse = false;
  let terminalAssistant: AssistantMessage | undefined;
  let totalUsage = emptyUsage();
  let currentTurnStreamedContent = false;
  let runtimeContextCompacted = false;
  let runtimeCompactionError: ContextCompactionUnavailableError | undefined;
  let toolBudgetError: BuilderTurnBudgetExceededError | undefined;
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

  /**
   * Reasons the turn must stop that are not the model's own choice: a context it could not compact,
   * a spent tool budget, an indeterminate workspace operation, or an approval the user still owes.
   */
  const turnInterrupted = () =>
    runtimeCompactionError !== undefined ||
    toolBudgetError !== undefined ||
    toolIndeterminateError !== undefined ||
    cloudflareApprovalPending;

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
      toolBudgetError ??= event.isError ? toolBudgetErrorFromResult(event.result) : undefined;
      toolIndeterminateError ??= event.isError ? toolIndeterminateErrorFromResult(event.result) : undefined;
      currentRunToolResults.push({ toolName: event.toolName, result });
      cloudflareApprovalPending ||= cloudflareExecutePausesTurn(
        event.toolName,
        isRecord(result) && typeof result.kind === 'string' ? { kind: result.kind } : null,
      );
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
      currentValidatedBuildCompletion = getValidatedBuildCompletion(messages, currentRunToolResults);
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

  let context: AgentContext = {
    systemPrompt: instructions,
    messages: piMessages,
    tools: piToolsToList(piTools),
  };

  const compactRuntimeContext = async (source: AgentContext): Promise<AgentContext | undefined> => {
    try {
      const compacted = await compactPiContext({
        messages: source.messages,
        summarize: compaction.summarize,
        signal: loopSignal,
      });
      if (!compacted) {
        runtimeCompactionError = new ContextCompactionUnavailableError(
          new Error('The active turn has no safe compaction boundary.'),
        );
        return undefined;
      }
      runtimeContextCompacted = true;
      compaction.requestDurableCompaction?.();
      logger.info('Compacted live Pi context', {
        tokensBefore: compacted.tokensBefore,
        tokensAfter: compacted.tokensAfter,
      });
      return { ...source, messages: compacted.messages };
    } catch (error) {
      loopSignal?.throwIfAborted();
      runtimeCompactionError =
        error instanceof ContextCompactionUnavailableError ? error : new ContextCompactionUnavailableError(error);
      return undefined;
    }
  };

  void (async () => {
    try {
      recordPiStage('loop_start', modelId);
      const loopConfig: AgentLoopConfig & { toolChoice: 'auto' } = {
        model: handle.model,
        // SAFETY: every message in this loop's context originates from `modelMessagesToPi`, the Pi
        // tool adapter, or the Pi stream itself, so the context never holds a custom agent message.
        convertToLlm: (agentMessages) => agentMessages as Message[],
        getSteeringMessages: async () => {
          const messages = await steering.drain();
          if (messages.length > 0) {
            currentValidatedBuildCompletion = undefined;
          }
          return messages;
        },
        prepareNextTurn: async ({ message, context: turnContext }) => {
          const wouldContinue = message.content.some((part) => part.type === 'toolCall');
          if (!wouldContinue || estimatePiContextTokens(turnContext.messages) < compactionPolicy.hardLimitTokens) {
            return undefined;
          }
          const compacted = await compactRuntimeContext(turnContext);
          if (!compacted) {
            return undefined;
          }
          context = compacted;
          return { context: compacted };
        },
        shouldStopAfterTurn: () =>
          turnInterrupted() || (currentValidatedBuildCompletion !== undefined && !steering.hasPending()),
        afterToolCall: async ({ result, isError }) =>
          !isError && !toolResultSucceeded(result.details) ? { isError: true } : undefined,
        maxTokens: handle.model.maxTokens,
        reasoning: builderThinkingLevel(handle.model),
        toolChoice: 'auto',
      };

      /**
       * Deployment and preview recognize only the canonical validation, so a mutated turn the
       * model ends without validating is incomplete: run the validation for it, and give the
       * model the failure to repair inside this same turn while budgets allow.
       */
      const turnNeedsAutoValidation = () =>
        durableMutationStarted &&
        currentValidatedBuildCompletion === undefined &&
        !loopSignal.aborted &&
        !turnInterrupted() &&
        !steering.hasPending() &&
        assistantMessageValue(terminalAssistant)?.stopReason === 'stop';

      /**
       * A durably validated revision needs no transcript receipt: deployment readiness reads the
       * validation record directly, so re-running validation for it would only add minutes.
       */
      const revisionAlreadyValidated = async (): Promise<boolean> => {
        try {
          const checkpoint = await workspace.checkpoint();
          return await workspace.hasSuccessfulValidation(checkpoint.revision);
        } catch {
          return false;
        }
      };

      const runAutoValidation = async (): Promise<void> => {
        const validateTool = piTools.validate;
        if (!validateTool) {
          return;
        }
        const toolCallId = `${AUTO_VALIDATION_TOOL_CALL_ID_PREFIX}${crypto.randomUUID()}`;
        await emit({ type: 'tool_execution_start', toolCallId, toolName: 'validate', args: {} });
        let result: AgentToolResult<unknown>;
        try {
          result = await validateTool.execute(toolCallId, {}, loopSignal, undefined);
        } catch (caught) {
          const text = caught instanceof Error ? caught.message : 'The canonical validation could not be run.';
          result = { content: [{ type: 'text', text }], details: { error: text } };
        }
        const details = piToolResultDetails(result);
        const validation = isRecord(details) ? details.validation : undefined;
        const isError = !toolResultSucceeded(validation ?? details);
        await emit({ type: 'tool_execution_end', toolCallId, toolName: 'validate', result, isError });
        context.messages.push(
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: toolCallId, name: 'validate', arguments: {} }],
            timestamp: Date.now(),
            api: 'openai-completions',
            provider: 'cloudflare-workers-ai',
            model: modelId,
            usage: emptyUsage(),
            stopReason: 'stop',
          },
          {
            role: 'toolResult',
            toolCallId,
            toolName: 'validate',
            content: result.content,
            isError,
            timestamp: Date.now(),
          },
        );
      };

      armInactivityWatchdog();
      // Armed once, when the model request starts: the first meaningful event disarms it for good.
      firstProgressTimer = setTimeout(() => firstProgressController.abort(), BUILDER_TURN_FIRST_PROGRESS_MS);
      let overflowRecoveryAttempted = false;
      let autoValidationAttempts = 0;
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

        if (!turnNeedsAutoValidation() || (await revisionAlreadyValidated())) {
          break;
        }
        autoValidationAttempts += 1;
        await runAutoValidation();
        if (autoValidationAttempts >= MAX_AUTO_VALIDATION_ATTEMPTS || !turnNeedsAutoValidation()) {
          break;
        }
        // Validation failed and a repair round is still allowed: continue the same turn so the
        // model can fix it against the result now in its context.
      }

      recordPiStage('loop_complete', modelId);
      const finalAssistant = assistantMessageValue(terminalAssistant);
      if (runtimeCompactionError) {
        throw runtimeCompactionError;
      }
      if (toolIndeterminateError) {
        throw toolIndeterminateError;
      }
      if (toolBudgetError) {
        throw toolBudgetError;
      }
      const signalBudgetReason = exhaustedBudgetReason();
      if (signalBudgetReason) {
        throw new BuilderTurnBudgetExceededError(signalBudgetReason);
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
        compaction.requestDurableCompaction?.();
      }
      recordWorkersAiFinish({
        usage: totalUsage,
        finishReason: finalAssistant?.stopReason ?? 'stop',
        firstUserMessage,
        contextReduced: modelInput.contextCompacted || runtimeContextCompacted,
        estimatedContextTokens: Math.max(modelInput.estimatedTokens, finalContextTokens),
        promptCharacterCounts,
        providerModel: modelId,
        startedAt,
      });
      terminalReason = abortSignal?.aborted ? 'cancelled' : 'completed';
    } catch (cause) {
      const error = budgetErrorForFailure(cause);
      terminalReason =
        error instanceof BuilderTurnBudgetExceededError ? error.reason : abortSignal?.aborted ? 'cancelled' : 'failed';
      recordPiStage('loop_error', modelId);
      logProviderFailure(logger, 'Pi agent runner failed.', error);
      if (
        (error instanceof BuilderTurnBudgetExceededError ||
          error instanceof WorkspaceToolOperationIndeterminateError ||
          error instanceof ContextCompactionUnavailableError ||
          error instanceof HiddenReasoningExhaustionError) &&
        !abortSignal?.aborted
      ) {
        await writer.write({ type: 'error', errorText: error.message });
      } else if (isWorkersAiFreeAllocationError(error)) {
        await writer.write({ type: 'error', errorText: workersPaidRequiredMessage() });
      } else if (isCloudflareAiFundingError(error)) {
        await writer.write({ type: 'error', errorText: cloudflareAiFundingRequiredMessage() });
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
      const budget: BuilderTurnBudgetReport = {
        terminalReason,
        stepCount,
        toolCallCount,
        elapsedMs: Date.now() - startedAt,
        toolWallClockMs: toolAccounting.wallClockMs(),
        toolMsByName: toolAccounting.byName(),
        lastValidationState: currentValidatedBuildCompletion === undefined ? 'unvalidated' : 'validated',
      };
      recordPiTurnBudget(modelId, budget);
      onSettled(budget);
      await writer.close().catch(() => undefined);
    }
  })();

  const framedStream = new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const reader = readable.getReader();
      controller.enqueue({ type: 'start' });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          controller.enqueue(value);
        }
        controller.enqueue({
          type: 'finish',
          finishReason: terminalAssistant?.stopReason === 'length' ? 'length' : 'stop',
        });
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return normalizeTextPartBoundaries(
    appendDeterministicCompletion(framedStream, () => currentValidatedBuildCompletion),
  );
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

/** A proposal is a completed tool result, but it deliberately ends this Pi run before another model step. */
function cloudflareExecutePausesTurn(toolName: string, result: CloudflareMcpResultCandidate | null): boolean {
  return toolName === 'cloudflare_execute' && isCloudflareExecuteProposal(result);
}

function createValidatedBuildCompletionStream(text: string): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      const id = 'validated-build-completion';
      controller.enqueue({ type: 'start' });
      controller.enqueue({ type: 'text-start', id });
      controller.enqueue({ type: 'text-delta', id, delta: text });
      controller.enqueue({ type: 'text-end', id });
      controller.enqueue({ type: 'finish', finishReason: 'stop' });
      controller.close();
    },
  });
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

function toolBudgetErrorFromResult(result: unknown): BuilderTurnBudgetExceededError | undefined {
  const payload = toolErrorPayload(result);
  return payload?.code === BUILDER_TURN_BUDGET_ERROR_CODE && payload.reason === 'tool_timeout'
    ? new BuilderTurnBudgetExceededError('tool_timeout')
    : undefined;
}

function toolIndeterminateErrorFromResult(result: unknown): WorkspaceToolOperationIndeterminateError | undefined {
  const payload = toolErrorPayload(result);
  return payload?.code === WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE && typeof payload.error === 'string'
    ? new WorkspaceToolOperationIndeterminateError(payload.error)
    : undefined;
}

function toolErrorPayload(result: unknown): { code?: unknown; error?: unknown; reason?: unknown } | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  if (error instanceof ModelInputBudgetExceededError || error instanceof ContextCompactionUnavailableError) {
    throw error;
  }
  throw new PiAgentPreparationError(stage, error);
}
