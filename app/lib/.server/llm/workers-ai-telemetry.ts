import type { PromptCharacterCounts } from 'cloudchef-agent/context-message-metrics';
import type { Usage } from '@earendil-works/pi-ai';
import type { BuilderTurnReport } from './builder-turn-limits';

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
    cachedTokens: Math.min(inputTokens, normalizeUsage(usage.cacheRead)),
  };
}

/** Logs a finished model turn and returns its token counts. */
export function recordWorkersAiFinish(options: FinishTelemetryOptions): ModelTurnUsage {
  const tokens = turnUsage(options.usage);
  console.info({
    event: 'workers_ai_finished',
    firstUserMessage: options.firstUserMessage,
    model: options.providerModel,
    finishReason: options.finishReason,
    usage: {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      totalTokens: normalizeUsage(options.usage.totalTokens),
    },
    contextReduced: options.contextReduced,
    estimatedContextTokens: options.estimatedContextTokens,
    promptCharacterCounts: options.promptCharacterCounts,
    durationMs: Date.now() - options.startedAt,
    promptCache: {
      attempted: true,
      status: tokens.cachedTokens > 0 ? 'hit' : 'miss',
      cachedInputTokens: tokens.cachedTokens,
    },
  });
  return tokens;
}

export function recordPiStage(stage: string, modelId: string, status?: number): void {
  console.info({ event: 'cloudchef_pi_stage', stage, modelId, ...(status === undefined ? {} : { status }) });
}

export function recordPiTurnReport(modelId: string, report: BuilderTurnReport): void {
  console.info({ event: 'cloudchef_pi_turn_budget', modelId, ...report });
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
