import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';

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

/** Logs one model response, content-free, and returns its token counts: whether the provider read it from its cache. */
export function recordModelResponse(message: AssistantMessage): ModelTurnUsage {
  const tokens = turnUsage(message.usage);
  console.info({
    event: 'workers_ai_finished',
    model: message.model,
    finishReason: message.stopReason,
    usage: {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      totalTokens: normalizeUsage(message.usage.totalTokens),
    },
    durationMs: message.durationMs,
    promptCache: {
      attempted: true,
      status: tokens.cachedTokens > 0 ? 'hit' : 'miss',
      cachedInputTokens: tokens.cachedTokens,
    },
  });
  return tokens;
}

export function recordPiStage(stage: string, modelId: string, status?: number): void {
  const entry = { event: 'cloudchef_pi_stage', stage, modelId };
  console.info(status === undefined ? entry : { ...entry, status });
}

function normalizeUsage(usage: number | undefined): number {
  return usage === undefined || !Number.isFinite(usage) || usage < 0 ? 0 : usage;
}
