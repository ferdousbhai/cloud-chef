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

/** GLM is the default; only the explicitly selected Flash alternative is offered. */
export const CLOUDFLARE_WORKERS_AI_MODEL = '@cf/zai-org/glm-5.3-flash' satisfies WorkersAiModelId;

/**
 * Titles must come from a model that speaks the OpenAI completions response shape, because every
 * CloudChef request goes through the Pi `openai-completions` adapter, which reads only
 * `choices[].delta`. Small Workers AI models such as `@cf/meta/llama-3.2-1b-instruct` answer in
 * Cloudflare's native `{ response, usage }` shape instead: the adapter parses no text, the title
 * comes back empty, and every chat silently keeps its heuristic prompt-derived name. Do not move
 * this to a native-shape model. Llama 4 Scout answers in the OpenAI shape, in about half a second.
 */
export const CLOUDFLARE_PROJECT_TITLE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct' satisfies WorkersAiModelId;

export type WorkersAiRuntimeModelId = WorkersAiModelId;

/**
 * The smallest context window CloudChef will drive a builder model with. An explicit floor, not a
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
  contextTokens: 1_310_720,
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

export const CLOUDFLARE_ALTERNATIVE_BUILDER_MODEL = '@cf/deepseek-ai/deepseek-v4-flash-0731' satisfies WorkersAiModelId;

export function isSupportedBuilderModel(modelId: string): modelId is WorkersAiModelId {
  return modelId === CLOUDFLARE_WORKERS_AI_MODEL || modelId === CLOUDFLARE_ALTERNATIVE_BUILDER_MODEL;
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
