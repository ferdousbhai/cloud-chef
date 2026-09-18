import { decideConversationCompaction, type ConversationCompactionAction } from '~/lib/compaction';
import type { ModelMessage } from './message-conversion';
import { estimateStringTokens } from 'agents/experimental/memory/utils';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { modelTokenEstimateSafetyTokens } from 'cloudchef-agent/context-limits';
import type { ChatTurnContext } from 'cloudchef-agent/turn-context';
import {
  assembleCompactedContext,
  compactContext,
  CONTEXT_COMPACTION_KEEP_RECENT_TOKENS,
  type ContextCompaction,
} from './context-compaction';
import { cleanupAssistantMessages } from './message-conversion';
import { injectTurnContext } from './turn-context';

type ModelInputLogger = {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
};

type PreparedModelInput = {
  messages: ModelMessage[];
  promptMessages: CloudChefMessage[];
  estimatedTokens: number;
  contextCompacted: boolean;
  nextCompaction: ContextCompaction | null;
  compactionAction: ConversationCompactionAction;
};

/**
 * Output headroom the input budget holds back so a turn that has filled its context can still
 * answer at length. Proportional to the window rather than a fixed number of tokens: the provider
 * rejects `input + requested output > contextWindow`, so a flat reserve would hand a million-token
 * model's entire advantage to input and leave its answers no longer than a 128k model's.
 */
const COMPACTION_OUTPUT_RESERVE_FRACTION = 0.125;
const COMPACTION_OUTPUT_RESERVE_FLOOR_TOKENS = 16_384;

/**
 * The conversation's input budget, derived from the model's real context window — there is no
 * fixed ceiling on top of it. A 1M-token model is allowed to use its million tokens; the only
 * deductions are the output reserve above and the estimator safety margin, both explicit.
 */
export function modelCompactionPolicy(contextWindow: number) {
  const outputReserveTokens = Math.max(
    COMPACTION_OUTPUT_RESERVE_FLOOR_TOKENS,
    Math.ceil(contextWindow * COMPACTION_OUTPUT_RESERVE_FRACTION),
  );
  const hardLimitTokens = Math.max(
    // Compaction always keeps the recent tail, so a limit at or below it could never be satisfied.
    CONTEXT_COMPACTION_KEEP_RECENT_TOKENS + 1,
    contextWindow - outputReserveTokens - modelTokenEstimateSafetyTokens(contextWindow),
  );
  return {
    proactiveTokens: Math.max(1, hardLimitTokens - CONTEXT_COMPACTION_KEEP_RECENT_TOKENS),
    hardLimitTokens,
  };
}

export class ModelInputBudgetExceededError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly maximumEstimatedTokens: number,
  ) {
    super(
      `The system instructions, tools, and current turn need approximately ${estimatedTokens} input tokens; ` +
        `the conservative limit is ${maximumEstimatedTokens}. Shorten the current request or attached file changes.`,
    );
    this.name = 'ModelInputBudgetExceededError';
  }
}

export class ContextCompactionUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('This conversation needs automatic compaction, but its summary could not be generated. Please retry.');
    this.name = 'ContextCompactionUnavailableError';
  }
}

/** Build provider input, replacing older prompt messages with a summary as the configured limits approach. */
export async function prepareModelInput(args: {
  messages: CloudChefMessage[];
  turnContext?: ChatTurnContext;
  currentCompaction?: ContextCompaction | null;
  compactionPending?: boolean;
  summarize: (prompt: string, signal?: AbortSignal) => Promise<string>;
  scheduleCompaction?: () => Promise<void>;
  signal?: AbortSignal;
  contextWindow: number;
  systemPrompt: string;
  tools: AgentTool[];
  logger?: ModelInputLogger;
}): Promise<PreparedModelInput> {
  let assembled = assembleCompactedContext(args.messages, args.currentCompaction);
  let promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  let modelInput = await assembleModelInput(promptMessages, args);
  const policy = modelCompactionPolicy(args.contextWindow);
  const compactionAction = decideConversationCompaction({
    estimatedTokens: modelInput.estimatedTokens,
    pending: args.compactionPending,
    policy,
  });

  if (compactionAction !== 'blocking') {
    if (compactionAction === 'background') {
      await args.scheduleCompaction?.();
    }
    return {
      ...modelInput,
      promptMessages,
      contextCompacted: assembled.overlayApplied,
      nextCompaction: null,
      compactionAction,
    };
  }

  args.logger?.info('Starting automatic CloudChef context compaction', {
    estimatedTokens: modelInput.estimatedTokens,
    messageCount: assembled.messages.length,
  });

  let nextCompaction: ContextCompaction | null;
  try {
    nextCompaction = await compactContext({
      messages: args.messages,
      current: args.currentCompaction,
      summarize: args.summarize,
      signal: args.signal,
    });
  } catch (error) {
    args.signal?.throwIfAborted();
    args.logger?.warn('Automatic context compaction failed; preserving the full transcript', {
      error: error instanceof Error ? error.message : String(error),
      estimatedTokens: modelInput.estimatedTokens,
    });
    throw new ContextCompactionUnavailableError(error);
  }

  if (!nextCompaction) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, policy.hardLimitTokens);
  }

  const tokensBefore = modelInput.estimatedTokens;
  const messagesBefore = assembled.messages.length;
  assembled = assembleCompactedContext(args.messages, nextCompaction);
  promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  modelInput = await assembleModelInput(promptMessages, args);
  if (modelInput.estimatedTokens >= policy.hardLimitTokens) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, policy.hardLimitTokens);
  }

  args.logger?.info('Automatically compacted CloudChef context', {
    tokensBefore,
    tokensAfter: modelInput.estimatedTokens,
    messagesBefore,
    messagesAfter: assembled.messages.length,
  });

  return {
    ...modelInput,
    promptMessages,
    contextCompacted: true,
    nextCompaction,
    compactionAction,
  };
}

async function assembleModelInput(
  uiMessages: CloudChefMessage[],
  args: Pick<Parameters<typeof prepareModelInput>[0], 'systemPrompt' | 'tools'>,
): Promise<{ messages: ModelMessage[]; estimatedTokens: number }> {
  const messages = cleanupAssistantMessages(uiMessages);
  const estimatedTokens = estimateStringTokens(
    JSON.stringify({
      instructions: args.systemPrompt,
      messages,
      tools: args.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      toolChoice: 'auto',
    }),
  );
  return { messages, estimatedTokens };
}
