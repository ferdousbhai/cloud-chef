import type { PromptCharacterCounts } from 'cloudchef-agent/context-message-metrics';
import type { Usage } from '@earendil-works/pi-ai';

interface FinishTelemetryOptions {
  usage: Usage;
  finishReason: string;
  firstUserMessage: boolean;
  contextReduced: boolean;
  estimatedContextTokens?: number;
  promptCharacterCounts: PromptCharacterCounts;
  providerModel: string;
  startedAt: number;
}

/** One finished model turn's token counts, as reported to an organization's admins. */
export type ModelTurnUsage = { inputTokens: number; outputTokens: number; cachedTokens: number };

/** A turn's token counts so far, whether it finished or failed. */
export function turnUsage(usage: Usage): ModelTurnUsage {
  const inputTokens = normalizeUsage(usage.input);
  return {
    inputTokens,
    outputTokens: normalizeUsage(usage.output),
    cachedTokens: workersAiPromptCacheTelemetry(usage, inputTokens).cachedInputTokens,
  };
}

/** Logs a finished model turn and returns its token counts. */
export function recordWorkersAiFinish(options: FinishTelemetryOptions): ModelTurnUsage {
  const usage = {
    inputTokens: normalizeUsage(options.usage.input),
    outputTokens: normalizeUsage(options.usage.output),
    totalTokens: normalizeUsage(options.usage.totalTokens),
  };
  const promptCache = workersAiPromptCacheTelemetry(options.usage, usage.inputTokens);
  console.info({
    event: 'workers_ai_finished',
    firstUserMessage: options.firstUserMessage,
    model: options.providerModel,
    finishReason: options.finishReason,
    usage,
    contextReduced: options.contextReduced,
    estimatedContextTokens: options.estimatedContextTokens,
    promptCharacterCounts: options.promptCharacterCounts,
    durationMs: Date.now() - options.startedAt,
    promptCache,
  });
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: promptCache.cachedInputTokens,
  };
}

type WorkersAiPromptCacheTelemetry = {
  attempted: true;
  status: 'hit' | 'miss';
  cachedInputTokens: number;
};

function workersAiPromptCacheTelemetry(usage: Usage, inputTokens: number): WorkersAiPromptCacheTelemetry {
  const cachedInputTokens = Math.min(normalizeUsage(inputTokens), normalizeUsage(usage.cacheRead));
  return {
    attempted: true,
    status: cachedInputTokens > 0 ? 'hit' : 'miss',
    cachedInputTokens,
  };
}

export function recordFirstWorkersAiResponse(startedAt: number): void {
  console.info({
    event: 'workers_ai_first_response',
    timeToFirstResponseMs: Date.now() - startedAt,
    platform: 'Cloudflare AI',
  });
}

/** First visible text or tool activity — the moment the watchdog treats the model as alive. */
export function recordFirstMeaningfulWorkersAiProgress(startedAt: number): void {
  console.info({
    event: 'workers_ai_first_meaningful_progress',
    timeToFirstMeaningfulProgressMs: Date.now() - startedAt,
    platform: 'Cloudflare AI',
  });
}

/** First workspace-mutating tool execution of the turn. Content-free: only the tool name and timing. */
export function recordFirstBuilderMutation(startedAt: number, toolName: string): void {
  console.info({
    event: 'builder_first_mutation',
    toolName,
    timeToFirstMutationMs: Date.now() - startedAt,
  });
}

function normalizeUsage(usage: number | undefined): number {
  return usage === undefined || !Number.isFinite(usage) || usage < 0 ? 0 : usage;
}
