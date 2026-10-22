import { z } from 'zod';

const WORKERS_AI_MODEL_ID_PATTERN = /^@cf\/[a-z0-9][a-z0-9-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * The AI Gateway providers whose models CloudChef offers when the account has its own key for one on
 * its default gateway (BYOK), by the provider's AI Gateway slug. Which models each offers, and how
 * each is spoken to, is Pi's (`app/lib/.server/llm/pi-model-catalog.ts`); adding a provider is a row
 * here and its catalog there.
 */
export const GATEWAY_PROVIDERS = {
  anthropic: { label: 'Anthropic', mark: 'A' },
  openai: { label: 'OpenAI', mark: 'O' },
  grok: { label: 'xAI', mark: 'x' },
  openrouter: { label: 'OpenRouter', mark: 'OR' },
} as const;

export type GatewayProviderSlug = keyof typeof GATEWAY_PROVIDERS;

function isGatewayProviderSlug(value: string): value is GatewayProviderSlug {
  return value in GATEWAY_PROVIDERS;
}

/** The providers' slugs in `GATEWAY_PROVIDERS` order. */
export const GATEWAY_PROVIDER_SLUGS: readonly GatewayProviderSlug[] =
  Object.keys(GATEWAY_PROVIDERS).filter(isGatewayProviderSlug);

const GATEWAY_MODEL_ID_PATTERN = new RegExp(
  `^(?:${GATEWAY_PROVIDER_SLUGS.join('|')})/[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$`,
);

export type WorkersAiModelId = `@cf/${string}/${string}`;

/**
 * A model served through the account's default AI Gateway with the account's own key for its
 * provider: the provider's slug, then the provider's own model id (`anthropic/claude-opus-5-5`).
 */
export type GatewayModelId = `${GatewayProviderSlug}/${string}`;

/** A model the builder can run on: a Workers AI model, or a provider's model when the account has a key. */
export type BuilderModelId = WorkersAiModelId | GatewayModelId;

/**
 * The reasoning efforts a person can choose for a model, weakest first, in Pi's vocabulary. "Off" is
 * never one of them: CloudChef does not turn a reasoning model's reasoning off, and choosing nothing
 * — "Default" — sends no level at all, so the provider applies its own default effort (an older
 * Claude model, which has none, thinks at the "high" budget).
 */
export const BUILDER_REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type BuilderReasoningLevel = (typeof BUILDER_REASONING_LEVELS)[number];

export const builderReasoningLevelSchema = z.enum(BUILDER_REASONING_LEVELS);

export type BuilderModel = {
  id: BuilderModelId;
  label: string;
  description: string;
  contextTokens: number;
  requiresPaid: boolean;
  reasoning: boolean;
  vision: boolean;
  /**
   * The efforts the person may choose for this model, from Pi's catalog, weakest first. Absent for a
   * model with none to choose: the picker then offers no effort control and the provider's default
   * applies.
   */
  reasoningLevels?: BuilderReasoningLevel[];
  /**
   * When Cloudflare added this model to the account-visible catalog, as an ISO timestamp. Optional
   * because Cloudflare does not date every entry: absence means "unknown", never "old".
   */
  createdAt?: string;
};

/** GLM is the default when a team has not chosen another. */
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
export const DEFAULT_WORKERS_AI_MODEL: BuilderModel = {
  id: CLOUDFLARE_WORKERS_AI_MODEL,
  label: 'GLM 5.3 Flash',
  description: 'Latest fast GLM model for coding, reasoning, and tool-driven builds.',
  contextTokens: 1_310_720,
  requiresPaid: true,
  reasoning: true,
  vision: true,
};

const workersAiModelIdSchema: z.ZodType<WorkersAiModelId> = z
  .templateLiteral(['@cf/', z.string(), '/', z.string()])
  .refine((modelId) => WORKERS_AI_MODEL_ID_PATTERN.test(modelId));

const gatewayProviderSlugSchema = z.enum(GATEWAY_PROVIDER_SLUGS);

const gatewayModelIdSchema: z.ZodType<GatewayModelId> = z
  .templateLiteral([gatewayProviderSlugSchema, '/', z.string()])
  .refine((modelId) => GATEWAY_MODEL_ID_PATTERN.test(modelId));

export const builderModelIdSchema: z.ZodType<BuilderModelId> = z.union([workersAiModelIdSchema, gatewayModelIdSchema]);

/** Workers AI's 100-model catalog page plus every chat model Pi lists for every gateway provider, with room. */
export const MAX_BUILDER_CATALOG_MODELS = 1_000;

const builderModelSchema = z.object({
  id: builderModelIdSchema,
  label: z.string().min(1).max(128),
  description: z.string().min(1).max(1_000),
  contextTokens: z.number().int().min(MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS),
  requiresPaid: z.boolean(),
  reasoning: z.boolean(),
  vision: z.boolean(),
  reasoningLevels: z.array(builderReasoningLevelSchema).max(BUILDER_REASONING_LEVELS.length).optional(),
  // Cloudflare does not date every model, so an undated one stays valid.
  createdAt: z.string().min(1).max(64).optional(),
});

export const builderModelCatalogPayloadSchema = z.object({
  defaultModelId: builderModelIdSchema,
  models: z.array(builderModelSchema).min(1).max(MAX_BUILDER_CATALOG_MODELS),
});

export type BuilderModelCatalogPayload = {
  defaultModelId: BuilderModelId;
  models: BuilderModel[];
};

export function isWorkersAiModelId(value: string | null | undefined): value is WorkersAiModelId {
  return value !== null && value !== undefined && workersAiModelIdSchema.safeParse(value).success;
}

export function isBuilderModelId(value: string | null | undefined): value is BuilderModelId {
  return value !== null && value !== undefined && builderModelIdSchema.safeParse(value).success;
}

/** The gateway provider a model is served by, or null for a Workers AI model. */
export function gatewayModelProvider(modelId: BuilderModelId): GatewayProviderSlug | null {
  return gatewayProviderSlugSchema.safeParse(modelId.slice(0, modelId.indexOf('/'))).data ?? null;
}

/**
 * A provider key on the account's default gateway, as a runtime needs it: which provider, and the
 * alias it is stored under, which a request names unless it is the provider's default, and which key
 * that is, as Cloudflare last changed it (its id and modification time), so what one key was refused
 * isn't held against another put under the same alias. Absent from an older control plane's answer.
 */
export type GatewayKey = { provider: GatewayProviderSlug; alias: string; revision?: string };

/**
 * The aliases CloudChef links a pasted key under; any other alias is a key added outside CloudChef.
 * There are two so a replacement goes on under the one not in use before the key it replaces is
 * removed: a key Cloudflare refuses never leaves the provider without one.
 */
export const CLOUDCHEF_KEY_ALIASES = ['cloudchef', 'cloudchef-2'] as const;

export function isCloudChefKeyAlias(alias: string): boolean {
  return CLOUDCHEF_KEY_ALIASES.some((candidate) => candidate === alias);
}

/** The CloudChef alias a replacement for a key under `alias` goes on under; null for any other alias. */
export function otherCloudChefKeyAlias(alias: string): string | null {
  return isCloudChefKeyAlias(alias) ? (CLOUDCHEF_KEY_ALIASES.find((candidate) => candidate !== alias) ?? null) : null;
}

export const gatewayKeysSchema = z.array(
  z.object({
    provider: gatewayProviderSlugSchema,
    alias: z.string().min(1).max(128),
    revision: z.string().max(256).optional(),
  }),
);

/** What the control plane says about an account's models, asked by its runtimes. */
export type AccountModelSettings = {
  /** The model the account's admin chose as everyone's default, if any. */
  defaultModelId: string | null;
  /** The provider keys on the account's default AI Gateway, one per provider: those providers' models can run. */
  gatewayKeys: GatewayKey[];
};

/** Nothing learned: no chosen default, and no provider keys, so only Workers AI models run. */
export const NO_ACCOUNT_MODEL_SETTINGS: AccountModelSettings = { defaultModelId: null, gatewayKeys: [] };

export function validateBuilderModelCatalogPayload(
  payload: BuilderModelCatalogPayload,
): BuilderModelCatalogPayload | null {
  const { defaultModelId, models } = payload;
  if (!models.some(({ id }) => id === defaultModelId) || new Set(models.map(({ id }) => id)).size !== models.length) {
    return null;
  }
  return { defaultModelId, models };
}

/**
 * Publication time as a sortable number, with "undated" meaning unknown rather than old: an entry
 * Cloudflare did not date must never outrank a dated one, so it sorts to the bottom and keeps its
 * catalog position there.
 */
export function builderModelPublishedTime(model: BuilderModel): number {
  const parsed = model.createdAt === undefined ? Number.NaN : Date.parse(model.createdAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function getBuilderModel(modelId: BuilderModelId, models: readonly BuilderModel[]): BuilderModel {
  return models.find(({ id }) => id === modelId) ?? DEFAULT_WORKERS_AI_MODEL;
}
