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
 * The deliberately pinned default; catalog discovery may add choices but never silently changes
 * it. The owner pins GLM 5.3 Flash: it is the fastest Workers AI model that reasons, reads images,
 * and holds a million-token window, which is the shape a Ghostbuild build actually needs.
 *
 * The earlier canary failures no longer describe the runtime that drives it. Those runs asked for
 * a fixed 24,576-token output ceiling, and a reasoning model spends that ceiling on hidden
 * reasoning before it ever writes a tool call. Requests now carry `reasoning_effort: high` with an
 * uncapped per-request output budget — whatever the window has left once the input is counted —
 * so reasoning and the answer no longer compete for the same few thousand tokens. See
 * `builderThinkingLevel` in `.server/llm/pi-agent-runner.ts` and `requestOutputTokens` in
 * `.server/llm/pi-ai-models.ts`.
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

export function getWorkersAiModel(modelId: WorkersAiModelId, models: readonly WorkersAiModel[]): WorkersAiModel {
  return models.find(({ id }) => id === modelId) ?? DEFAULT_WORKERS_AI_MODEL;
}
