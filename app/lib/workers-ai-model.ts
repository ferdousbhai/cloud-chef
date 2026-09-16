import { z } from 'zod';

const WORKERS_AI_MODEL_ID_PATTERN = /^@cf\/[a-z0-9][a-z0-9-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type WorkersAiModelId = `@cf/${string}/${string}`;

export type WorkersAiModel = {
  id: WorkersAiModelId;
  label: string;
  description: string;
  contextTokens: number;
  requiresPaid: boolean;
  reasoning: boolean;
  vision: boolean;
  /**
   * When Cloudflare added this model to the account-visible catalog, as an ISO timestamp. Optional
   * on purpose: a user-owned runtime built before this field existed still serves a valid catalog,
   * and Cloudflare itself does not date every entry. Absence means "unknown", never "old".
   */
  createdAt?: string;
};

/**
 * The deliberately pinned default. Catalog discovery may add choices, and it supplies this entry's
 * own metadata, but it never changes which model a build runs on while the pin is still offered —
 * and when Cloudflare retires it, the failover is logged rather than silent (see
 * `resolveBuilderDefaultModel`). The owner pins GLM 5.3 Flash: it is the fastest Workers AI model
 * that reasons, reads images, and holds a million-token window, which is the shape a Ghostbuild
 * build actually needs.
 *
 * The earlier canary failures no longer describe the runtime that drives it. Those runs asked for
 * a fixed 24,576-token output ceiling, and a reasoning model spends that ceiling on hidden
 * reasoning before it ever writes a tool call. Requests now carry an uncapped per-request output
 * budget — whatever the window has left once the input is counted — so reasoning and the answer no
 * longer compete for the same few thousand tokens. See `requestOutputTokens` in
 * `.server/llm/pi-ai-models.ts`; the reasoning directive that rides alongside it is
 * `builderThinkingLevel` in `.server/llm/pi-agent-runner.ts`, which currently sends none.
 */
export const CLOUDFLARE_WORKERS_AI_MODEL = '@cf/zai-org/glm-5.3-flash' satisfies WorkersAiModelId;

/**
 * Titles must come from a model that speaks the OpenAI completions response shape, because every
 * Ghostbuild request goes through the Pi `openai-completions` adapter, which reads only
 * `choices[].delta`. Small Workers AI models such as `@cf/meta/llama-3.2-1b-instruct` answer in
 * Cloudflare's native `{ response, usage }` shape instead: the adapter parses no text, the title
 * comes back empty, and every chat silently keeps its heuristic prompt-derived name. Do not move
 * this to a native-shape model. Llama 4 Scout answers in the OpenAI shape, in about half a second,
 * and already backs `CLOUDFLARE_CONTEXT_SUMMARY_MODEL`.
 */
export const CLOUDFLARE_PROJECT_TITLE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct' satisfies WorkersAiModelId;

/**
 * Context-compaction summaries must come from a fast, large-context model that never spends its
 * output budget on hidden reasoning: GLM 5.3 Flash produced 24s empty "summaries" (all
 * reasoning_content, finish_reason length), and a failed summary aborts the whole builder turn.
 * Unlike a builder turn, a summary asks for a small explicit output budget rather than the whole
 * remaining window, so a reasoning model can still exhaust it here even though it no longer can
 * as the builder. This stays on a non-reasoning, OpenAI-shaped model regardless of the default.
 */
export const CLOUDFLARE_CONTEXT_SUMMARY_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct' satisfies WorkersAiModelId;
export type WorkersAiRuntimeModelId = WorkersAiModelId;

/**
 * The smallest context window Ghostbuild will drive a builder model with. An explicit floor, not a
 * derived one: the input budget and the per-request output ceiling both scale with whatever window
 * a model actually has, so this only has to exclude windows too small to hold the system prompt,
 * the tool schemas, and a working transcript at once.
 */
export const MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS = 32_768;

/**
 * The pinned model's metadata as reviewed by hand, used only when discovery is unavailable. Every
 * other path reads the pin's label, window, and capabilities from the live catalog, so this literal
 * is a last resort rather than a second copy of the truth: a hand-maintained window or `vision` flag
 * that drifts from Cloudflare's would size request budgets against a model that no longer exists.
 */
export const DEFAULT_WORKERS_AI_MODEL: WorkersAiModel = {
  id: CLOUDFLARE_WORKERS_AI_MODEL,
  label: 'GLM 5.3 Flash',
  description: 'Latest fast GLM model for coding, reasoning, and tool-driven builds.',
  contextTokens: 1_048_576,
  requiresPaid: true,
  reasoning: true,
  vision: true,
};

export const workersAiModelIdSchema: z.ZodType<WorkersAiModelId> = z
  .templateLiteral(['@cf/', z.string(), '/', z.string()])
  .refine((modelId) => WORKERS_AI_MODEL_ID_PATTERN.test(modelId));

const workersAiModelSchema = z.object({
  id: workersAiModelIdSchema,
  label: z.string().min(1).max(128),
  description: z.string().min(1).max(1_000),
  contextTokens: z.number().int().min(MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS),
  requiresPaid: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  // A runtime that predates this field simply omits it, so an absent value must stay valid.
  createdAt: z.string().min(1).max(64).optional(),
});

export const workersAiModelCatalogPayloadSchema = z.object({
  defaultModelId: workersAiModelIdSchema,
  models: z.array(workersAiModelSchema).min(1).max(101),
});

export type WorkersAiModelCatalogPayload = {
  defaultModelId: WorkersAiModelId;
  models: WorkersAiModel[];
};

export function isWorkersAiModelId(value: string | null | undefined): value is WorkersAiModelId {
  return value !== null && value !== undefined && workersAiModelIdSchema.safeParse(value).success;
}

export function validateWorkersAiModelCatalogPayload(
  payload: WorkersAiModelCatalogPayload,
): WorkersAiModelCatalogPayload | null {
  const { defaultModelId, models } = payload;
  if (!models.some(({ id }) => id === defaultModelId) || new Set(models.map(({ id }) => id)).size !== models.length) {
    return null;
  }
  return { defaultModelId, models };
}

/**
 * How a model family serializes reasoning, for the families Pi's own Workers AI catalog does not
 * cover (glm-5.3-flash is absent from it).
 *
 * What it buys is narrower than this comment used to claim. It once said that without the right
 * format a model reasons unboundedly and returns empty content at the token limit; measured against
 * production, Cloudflare ignores the `thinking` block these formats produce. Toggling
 * `thinking: { type: 'disabled' }` moved the returned reasoning not at all — glm-5.3-flash 43ch
 * against a 43ch baseline, qwen3.8-27b 108 against 150, deepseek-v4-pro 103 against 97 — while
 * `chat_template_kwargs.enable_thinking = false` took all three to 0ch. So a known format is
 * evidence Ghostbuild has looked at a family, not a lever over how much that family thinks.
 *
 * It lives here, beside the model type and away from the Pi SDK, because two callers need it from
 * opposite sides of the bundle: the request path turns it into Pi compat flags, and catalog
 * discovery uses it to decide whether Ghostbuild could actually drive a model it has never been
 * configured for.
 */
export function workersAiThinkingFormat(modelId: string): 'zai' | 'qwen' | 'deepseek' | undefined {
  if (modelId.startsWith('@cf/zai-org/')) {
    return 'zai';
  }
  if (modelId.startsWith('@cf/qwen/')) {
    return 'qwen';
  }
  if (modelId.startsWith('@cf/deepseek-ai/')) {
    return 'deepseek';
  }
  return undefined;
}

/**
 * The second model the owner stands behind, expressed as a family rather than an id. When the
 * pinned GLM default is gone — retired by Cloudflare, or absent from an account's catalog — the
 * builder falls to the newest DeepSeek the account can currently serve.
 *
 * Why a family and not a pin: a pinned id is one more literal to hand-maintain, and it goes stale
 * the day Cloudflare publishes the next DeepSeek. What makes auto-selecting *within* the family
 * defensible is that both DeepSeek v4 models were measured answering the builder's own request
 * shape with a 200 and real reasoning — not any claim about directing their thinking, which on this
 * provider nothing does.
 *
 * Why this outranks the ranked heuristic in `resolveBuilderDefaultModel`: measured against
 * production, the heuristic's vision-first rule would choose `@cf/qwen/qwen3.8-27b`, and that is
 * precisely the model whose reasoning-effort vocabulary a builder request has to be repaired around
 * — see `retryWithinSupportedReasoningEffort` in `.server/llm/pi-ai-models.ts`. DeepSeek v4 answered
 * the builder's request shape with a 200 and real reasoning. A heuristic that picks a model nobody
 * has run is worse than a family that has been verified end to end.
 *
 * Shared here, beside the model type, because both sides of the bundle need the same answer: the
 * server resolves the failover default, and the picker puts the same model in its second row.
 */
const PREFERRED_FALLBACK_WORKERS_AI_MODEL_PREFIX = '@cf/deepseek-ai/';

export function newestPreferredFallbackWorkersAiModel(models: readonly WorkersAiModel[]): WorkersAiModel | undefined {
  // Strictly newer wins, so equal or undated entries keep the earlier catalog position rather than
  // letting an unknown date displace a model already chosen.
  return models
    .filter(({ id }) => id.startsWith(PREFERRED_FALLBACK_WORKERS_AI_MODEL_PREFIX))
    .reduce<WorkersAiModel | undefined>(
      (newest, model) =>
        newest === undefined || workersAiModelPublishedTime(model) > workersAiModelPublishedTime(newest)
          ? model
          : newest,
      undefined,
    );
}

/**
 * Publication time as a sortable number, with "undated" meaning unknown rather than old: an entry
 * Cloudflare did not date must never outrank a dated one, so it sorts to the bottom and keeps its
 * catalog position there.
 */
export function workersAiModelPublishedTime(model: WorkersAiModel): number {
  const parsed = model.createdAt === undefined ? Number.NaN : Date.parse(model.createdAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function getWorkersAiModel(modelId: WorkersAiModelId, models: readonly WorkersAiModel[]): WorkersAiModel {
  return models.find(({ id }) => id === modelId) ?? DEFAULT_WORKERS_AI_MODEL;
}
