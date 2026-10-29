import type { Message } from '@earendil-works/pi-ai';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { modelTokenEstimateSafetyTokens } from 'cloudchef-agent/context-limits';
import type { ChatTurnContext } from 'cloudchef-agent/turn-context';
import {
  assembleCompactedContext,
  compactContext,
  PROACTIVE_COMPACTION_MARGIN_TOKENS,
  estimateTextTokens,
  type ContextCompaction,
} from './context-compaction';
import { transcriptToPiMessages } from './message-conversion';
import { injectTurnContext } from './turn-context';

type PreparedModelInput = {
  messages: Message[];
  promptMessages: CloudChefMessage[];
  estimatedTokens: number;
  contextCompacted: boolean;
  nextCompaction: ContextCompaction | null;
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
    2,
    contextWindow - outputReserveTokens - modelTokenEstimateSafetyTokens(contextWindow),
  );
  return {
    proactiveTokens: Math.max(1, hardLimitTokens - PROACTIVE_COMPACTION_MARGIN_TOKENS),
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

/** Build provider input, replacing older prompt messages with a recovery record as the configured limits approach. */
export async function prepareModelInput(args: {
  messages: CloudChefMessage[];
  turnContext?: ChatTurnContext;
  currentCompaction: ContextCompaction | null;
  scheduleCompaction: () => Promise<void>;
  signal?: AbortSignal;
  contextWindow: number;
  systemPrompt: string;
  tools: AgentTool[];
}): Promise<PreparedModelInput> {
  let assembled = assembleCompactedContext(args.messages, args.currentCompaction);
  let promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  let modelInput = assembleModelInput(promptMessages, args);
  const policy = modelCompactionPolicy(args.contextWindow);
  if (modelInput.estimatedTokens < policy.hardLimitTokens) {
    if (modelInput.estimatedTokens >= policy.proactiveTokens) {
      await args.scheduleCompaction();
    }
    return {
      ...modelInput,
      promptMessages,
      contextCompacted: assembled.overlayApplied,
      nextCompaction: null,
    };
  }

  const nextCompaction = compactContext({
    messages: args.messages,
    current: args.currentCompaction,
    signal: args.signal,
  });

  if (!nextCompaction) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, policy.hardLimitTokens);
  }

  assembled = assembleCompactedContext(args.messages, nextCompaction);
  promptMessages = injectTurnContext(assembled.messages, args.turnContext);
  modelInput = assembleModelInput(promptMessages, args);
  if (modelInput.estimatedTokens >= policy.hardLimitTokens) {
    throw new ModelInputBudgetExceededError(modelInput.estimatedTokens, policy.hardLimitTokens);
  }

  return {
    ...modelInput,
    promptMessages,
    contextCompacted: true,
    nextCompaction,
  };
}

function assembleModelInput(
  uiMessages: CloudChefMessage[],
  args: Pick<Parameters<typeof prepareModelInput>[0], 'systemPrompt' | 'tools'>,
) {
  const messages = transcriptToPiMessages(uiMessages);
  const estimatedTokens = estimateTextTokens(
    JSON.stringify({
      instructions: args.systemPrompt,
      // A replayed message's timestamp and usage bookkeeping never reach the provider, and a thinking
      // block's signature is not counted as input.
      messages: messages.map(withoutThinkingSignatures).map(({ role, content }) => ({ role, content })),
      tools: args.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      toolChoice: 'auto',
    }),
  );
  return { messages, estimatedTokens };
}

/** A replayed message as its input is counted: a thinking block by its text, without its signature. */
function withoutThinkingSignatures(message: Message): Message {
  if (message.role !== 'assistant') {
    return message;
  }
  const content = message.content.map((block) =>
    block.type === 'thinking' ? { type: block.type, thinking: block.redacted ? '' : block.thinking } : block,
  );
  return { ...message, content };
}
