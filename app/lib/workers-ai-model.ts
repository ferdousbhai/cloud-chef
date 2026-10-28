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
type GatewayModelId = `${GatewayProviderSlug}/${string}`;

/** A model the builder can run on: a Workers AI model, or a provider's model when the account has a key. */
export type BuilderModelId = WorkersAiModelId | GatewayModelId;

/**
 * The reasoning efforts a person can choose for a model, weakest first, in Pi's vocabulary. "Off" is
 * never one of them: CloudChef does not turn a reasoning model's reasoning off, and choosing nothing
 * — "Default" — sends no level at all, so the provider applies its own default effort (an older
 * Claude model, which has none, thinks at the "high" budget).
 */
const BUILDER_REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

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

/** DeepSeek V4.1 Flash is the default when a team has not chosen another. */
export const CLOUDFLARE_WORKERS_AI_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017' satisfies WorkersAiModelId;

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
  label: 'DeepSeek V4.1 Flash',
  description: 'Fast DeepSeek model for coding, reasoning, and tool-driven builds, with a million-token window.',
  contextTokens: 1_048_576,
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
  // Empty where the label says it all: Pi's catalogs describe no gateway model.
  description: z.string().max(1_000),
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

/**
 * Every model the account could offer, whatever its admin allows, for Settings to show what there is
 * to allow: Workers AI's compatible models, and those of each provider the account has a key for.
 */
export const compatibleBuilderModelsPayloadSchema = z.object({
  models: z.array(builderModelSchema).max(MAX_BUILDER_CATALOG_MODELS),
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
 * A provider key on the account's default gateway, as a runtime needs it: which provider, and which key it is, as
 * Cloudflare last changed it (its id and modification time), so what one key was refused isn't held against
 * another put in its place.
 */
export type GatewayKey = { provider: GatewayProviderSlug; revision: string };

/**
 * The only alias a provider key is used under. CloudChef's runtimes reach the gateway through their Workers AI
 * binding, and on those requests Cloudflare uses the provider's key aliased `default` and ignores
 * `cf-aig-byok-alias`; a key under any other alias stays on the gateway, unused by CloudChef.
 */
export const GATEWAY_KEY_ALIAS = 'default';

export const gatewayKeysSchema = z.array(
  z.object({
    provider: gatewayProviderSlugSchema,
    revision: z.string().max(256),
  }),
);

/** What the control plane says about an account's models, asked by its runtimes. */
export type AccountModelSettings = {
  /** The model the account's admin chose as everyone's default, if any. */
  defaultModelId: string | null;
  /** The provider keys on the account's default AI Gateway, one per provider: those providers' models can run. */
  gatewayKeys: GatewayKey[];
  /**
   * The models the account's admin allows in the model picker; null while the admin has not chosen,
   * which offers every compatible model, including ones added later. Once chosen, a model not listed
   * (one added later among them) is neither offered nor run.
   */
  allowedModelIds: string[] | null;
};

/** Nothing chosen: no default, no provider keys (so only Workers AI models run), and every model allowed. */
export const NO_ACCOUNT_MODEL_SETTINGS: AccountModelSettings = {
  defaultModelId: null,
  gatewayKeys: [],
  allowedModelIds: null,
};

/** The models an admin allows, as Settings saves them: null for every compatible model. */
export const allowedBuilderModelIdsSchema = z.array(builderModelIdSchema).max(MAX_BUILDER_CATALOG_MODELS).nullable();

/** Whether the account's admin allows `modelId`, in the picker and for a turn. */
export function isBuilderModelAllowed(
  settings: Pick<AccountModelSettings, 'allowedModelIds'>,
  modelId: string,
): boolean {
  return settings.allowedModelIds === null || settings.allowedModelIds.includes(modelId);
}

/**
 * The model new chats start on: the one the admin chose, or else CloudChef's pinned model. The
 * models an admin allows always include it.
 */
export function effectiveDefaultModelId(defaultModelId: string | null): string {
  return defaultModelId ?? CLOUDFLARE_WORKERS_AI_MODEL;
}

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

/** A readable name made from a model's id (its last part, words capitalized), for a model no catalog names now. */
export function modelIdLabel(modelId: string): string {
  const name = modelId.slice(modelId.lastIndexOf('/') + 1);
  // A variant after a colon (gemma-4-31b-it:free) reads in brackets, as the catalogs write it.
  const [base = name, variant] = name.split(':');
  const label = base
    // A version written with dashes (claude-opus-5-5) reads as one number (5.5); a date (2024-11-20, or 02-15
    // with its leading zero) stays apart.
    .replace(/(?<=(?:^|-)[1-9]\d?)(?<!\d{4}-\d{1,2})-(?=[1-9]?\d(?:-|$))/g, '.')
    .split('-')
    .map(modelIdWord)
    .join(' ')
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bDeepseek\b/g, 'DeepSeek')
    .replace(/\bMinimax\b/g, 'MiniMax')
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bOss\b/g, 'OSS')
    .replace(/\bFp8\b/g, 'FP8');
  return variant ? `${label} (${variant})` : label;
}

/**
 * One part of a model's id as a word: a size (120b, 16e, a4b, 8x22b), a version with a letter (4.5v), "it"
 * (instruction-tuned) and "vl" (vision-language) in capitals; OpenAI's o-series (o3) and other parts starting with
 * a digit (4o) as they are; anything else capitalized.
 */
function modelIdWord(part: string): string {
  if (/^\d+x\d+[bekmt]$/i.test(part)) {
    return part.slice(0, -1) + part.slice(-1).toUpperCase();
  }
  if (/^a?\d+(?:\.\d+)?[bekmt]$/i.test(part) || /^\d+(?:\.\d+)?v$/i.test(part) || /^(?:it|vl)$/i.test(part)) {
    return part.toUpperCase();
  }
  if (/^\d/.test(part) || /^o\d/.test(part)) {
    return part;
  }
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/**
 * A token that dates a snapshot of a model rather than naming a different one, standing alone or in
 * parentheses: `(2024-05-13)`, `(08-2024)`, `06-05`, `0731`, `2512`, `(0902)`.
 */
const SNAPSHOT_TOKEN = /(?<=^|\s)\(?(\d{4}-\d{2}-\d{2}|\d{2}-\d{4}|\d{2}-\d{2}|\d{4})\)?(?=\s|$)/g;
/** What follows a number that says how big the model is (`27B`, `2.4T`, `A3B`, `8x22B`, `16E`), not which generation it is. */
const SIZE_UNIT = /^(?:[xX]\d|[bBtTmMeE](?![a-zA-Z]))/;

type ModelLineage = {
  /** The provider and the label's words without its generation or snapshot: `anthropic/claude opus`. */
  family: string;
  /** The label's first version number, each part after the first read as a decimal: 4.20 is 4.2. */
  generation: readonly number[] | null;
  /** The snapshot's date as one number (MM-YYYY reordered to YYYYMM), or null for the undated name. */
  snapshot: number | null;
};

function modelLineage(model: BuilderModel): ModelLineage {
  let snapshot: number | null = null;
  const name = model.label
    // OpenRouter labels lead with the vendor ("OpenAI: GPT-5.5"), though not all of them.
    .replace(/^[^:]*:\s*/, '')
    .replace(SNAPSHOT_TOKEN, (_token, date: string) => {
      const parts = date.split('-');
      const digits = parts.length === 2 && parts[1]?.length === 4 ? `${parts[1]}${parts[0]}` : parts.join('');
      snapshot = Math.max(snapshot ?? 0, Number(digits));
      return ' ';
    });
  const version = [...name.matchAll(/\d+(?:\.\d+)*/g)].find(
    (match) => !SIZE_UNIT.test(name.slice(match.index + match[0].length)),
  );
  const words = version ? `${name.slice(0, version.index)} ${name.slice(version.index + version[0].length)}` : name;
  return {
    family: `${gatewayModelProvider(model.id) ?? 'workers'}/${words
      .toLowerCase()
      .replace(/[^a-z0-9+]+/g, ' ')
      .trim()}`,
    generation: version
      ? version[0].split('.').map((part, index) => (index === 0 ? Number(part) : Number(`0.${part}`)))
      : null,
    snapshot,
  };
}

function compareGenerations(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * The models a newer one of the same family supersedes, which the picker leaves out. Pi exposes no
 * release dates, so this reads labels, per provider:
 *
 * - A label's family is its words without its generation and snapshot, ignoring case, punctuation,
 *   and an OpenRouter vendor prefix; parameter sizes and qualifiers stay in it. So "Claude Opus 4.7"
 *   and "Claude Opus 5.5" are one family, as are "Claude 3.7 Sonnet" and "Claude Sonnet 4.6", while
 *   "GPT-5.2" and "GPT-5.2 mini", "Kimi K2.6" and "Kimi K2.7 Code", or "Gemma 3 12B" and "Gemma 3 27B"
 *   are not.
 * - Its generation is its first number that is not a size or a date; the highest in a family stays.
 *   Parts after the first are decimals, so "Grok 4.20" is older than "Grok 4.7".
 * - Snapshots of one generation (dated labels) collapse to the undated name, which providers point at
 *   their newest snapshot, or else to the newest date: "GPT-4o" over "GPT-4o (2024-11-20)", "DeepSeek
 *   V4 Flash 0731" over "DeepSeek V4 Flash 0423".
 * - A label with no generation ("GPT OSS 120B", "Mistral Large") is never superseded by one with a
 *   generation, only by its own undated name or a newer snapshot.
 * - Labels that read the same once normalized (name, generation and snapshot) keep only the one the
 *   catalog added last, when the catalog dates them (Workers AI does; Pi doesn't date the others).
 */
export function olderBuilderModelIds(models: readonly BuilderModel[]): ReadonlySet<BuilderModelId> {
  const lineages = models.map((model) => ({ id: model.id, added: addedAt(model), ...modelLineage(model) }));
  const newestGeneration = new Map<string, readonly number[]>();
  for (const { family, generation } of lineages) {
    const newest = newestGeneration.get(family);
    if (generation && (!newest || compareGenerations(generation, newest) > 0)) {
      newestGeneration.set(family, generation);
    }
  }
  const release = ({ family, generation }: ModelLineage) => `${family}@${generation?.join('.') ?? ''}`;
  // Per release, the snapshot that stays: null once an undated name is listed.
  const newestSnapshot = new Map<string, number | null>();
  for (const lineage of lineages) {
    const key = release(lineage);
    const newest = newestSnapshot.get(key);
    newestSnapshot.set(
      key,
      lineage.snapshot === null || newest === null ? null : Math.max(lineage.snapshot, newest ?? 0),
    );
  }
  // Models whose labels say the same name, generation and snapshot: the catalog's date, where there is one, tells
  // which was added last.
  const sameName = (lineage: ModelLineage) => `${release(lineage)}#${lineage.snapshot ?? ''}`;
  const newestAdded = new Map<string, number>();
  for (const lineage of lineages) {
    if (lineage.added !== null) {
      newestAdded.set(sameName(lineage), Math.max(lineage.added, newestAdded.get(sameName(lineage)) ?? 0));
    }
  }
  return new Set(
    lineages
      .filter((lineage) => {
        const newest = newestGeneration.get(lineage.family);
        const superseded =
          lineage.generation !== null && newest !== undefined && compareGenerations(lineage.generation, newest) < 0;
        const olderSnapshot = lineage.snapshot !== null && newestSnapshot.get(release(lineage)) !== lineage.snapshot;
        const addedEarlier = lineage.added !== null && lineage.added < (newestAdded.get(sameName(lineage)) ?? 0);
        return superseded || olderSnapshot || addedEarlier;
      })
      .map(({ id }) => id),
  );
}

/** When the catalog added `model`, as milliseconds, or null when it doesn't say. */
function addedAt(model: BuilderModel): number | null {
  const added = model.createdAt ? Date.parse(model.createdAt) : Number.NaN;
  return Number.isFinite(added) ? added : null;
}
