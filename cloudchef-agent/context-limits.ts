/**
 * Headroom held back from a model's context window because every token count CloudChef computes
 * is a ~4-characters-per-token heuristic rather than the provider's own tokenizer. Workers AI
 * rejects any request whose input tokens plus requested output exceed the context window, so a
 * budget built on an over-confident estimate fails the whole turn. A tenth of the window, never
 * below the floor.
 */
const MODEL_TOKEN_ESTIMATE_SAFETY_FRACTION = 0.1;
const MODEL_TOKEN_ESTIMATE_SAFETY_FLOOR_TOKENS = 8_192;

export function modelTokenEstimateSafetyTokens(contextWindow: number): number {
  return Math.max(
    MODEL_TOKEN_ESTIMATE_SAFETY_FLOOR_TOKENS,
    Math.ceil(contextWindow * MODEL_TOKEN_ESTIMATE_SAFETY_FRACTION),
  );
}

/** Turn-local workspace hints are paths, not a duplicate project snapshot. */
export const MAX_EPHEMERAL_CONTEXT_CHARACTERS = 64_000;

/** User-authored prompt text is bounded independently from generated workspace context. */
export const MAX_USER_MESSAGE_CHARACTERS = 256_000;
