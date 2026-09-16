import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  newestPreferredFallbackWorkersAiModel,
  workersAiModelPublishedTime,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
  type WorkersAiModelId,
} from '~/lib/workers-ai-model';

const MAX_CATALOG_MODELS = 100;

type WorkersAiCatalogBinding = Pick<Ai, 'models'>;

export class WorkersAiModelCatalogUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The Cloudflare Workers AI model catalog is temporarily unavailable.', { cause });
    this.name = 'WorkersAiModelCatalogUnavailableError';
  }
}

/** Read the current account-visible catalog through its AI binding, never control-plane credentials. */
export async function readWorkersAiBuilderModelCatalog(binding: WorkersAiCatalogBinding): Promise<WorkersAiModel[]> {
  let catalog: AiModelsSearchObject[];
  try {
    catalog = await binding.models({
      task: 'Text Generation',
      hide_experimental: true,
      page: 1,
      per_page: MAX_CATALOG_MODELS,
    });
  } catch (error) {
    throw new WorkersAiModelCatalogUnavailableError(error);
  }

  const models = new Map<WorkersAiModelId, WorkersAiModel>();
  for (const entry of catalog) {
    const properties = new Map(entry.properties.map(({ property_id, value }) => [property_id, value]));
    const contextTokens = numericProperty(properties.get('context_window'));
    if (
      entry.source !== 1 ||
      entry.task.name !== 'Text Generation' ||
      !isWorkersAiModelId(entry.name) ||
      properties.get('function_calling') !== 'true' ||
      contextTokens < MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS
    ) {
      continue;
    }
    const model: WorkersAiModel = {
      id: entry.name,
      label: workersAiModelLabel(entry.name),
      description: boundedDescription(entry.description),
      contextTokens,
      requiresPaid: properties.get('require_workers_paid') === 'true',
      reasoning: properties.get('reasoning') === 'true',
      vision: properties.get('vision') === 'true',
    };
    const createdAt = catalogEntryCreatedAt(entry);
    if (createdAt !== undefined) {
      model.createdAt = createdAt;
    }
    models.set(entry.name, model);
  }
  return [...models.values()];
}

export async function requireWorkersAiBuilderModel(
  binding: WorkersAiCatalogBinding,
  modelId: WorkersAiModelId,
): Promise<WorkersAiModel> {
  let models: WorkersAiModel[];
  try {
    models = await readWorkersAiBuilderModelCatalog(binding);
  } catch (error) {
    // Discovery being down must not change which model a build runs on. The pinned model was
    // reviewed against Ghostbuild's tool protocol, so it still runs from its reviewed literal;
    // any other id is a claim only the catalog can confirm, so the outage surfaces instead.
    if (error instanceof WorkersAiModelCatalogUnavailableError && modelId === CLOUDFLARE_WORKERS_AI_MODEL) {
      return DEFAULT_WORKERS_AI_MODEL;
    }
    throw error;
  }
  const model = models.find(({ id }) => id === modelId);
  if (model) {
    return model;
  }
  // A successful read that omits the pin is a retirement, not an outage. Returning the reviewed
  // literal here would send every build to a model the account can no longer serve, and the first
  // sign of it would be an invoke-time failure in every user's build at once.
  if (modelId === CLOUDFLARE_WORKERS_AI_MODEL) {
    return resolveBuilderDefaultModel(models);
  }
  throw new Response('The selected Workers AI model is not compatible with the Ghostbuild builder.', {
    status: 400,
  });
}

/**
 * The default the builder actually runs, given what the account can currently serve. The pin wins
 * whenever discovery still offers it: the catalog can say what a model is, never what a Ghostbuild
 * build needs from it, so the choice stays human.
 *
 * Below the pin the order is deliberate — the owner's stated second choice first, the ranked
 * heuristic only after it. The heuristic reasons from catalog properties, and properties are not
 * evidence a model can serve a Ghostbuild turn: measured against production it would choose
 * `@cf/qwen/qwen3.8-27b` on its vision flag, which is the one model known to reject the reasoning
 * effort a builder request would carry — see `retryWithinSupportedReasoningEffort` in
 * `pi-ai-models.ts`. The DeepSeek family answered the builder's request shape with a 200 and real
 * reasoning. See `newestPreferredFallbackWorkersAiModel`.
 * The heuristic stays as the layer below, for the day the account offers neither.
 *
 * Nothing narrows the candidates beyond what catalog membership already proves — function calling
 * and `MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS`, both enforced in `readWorkersAiBuilderModelCatalog`.
 * There used to be a further gate that refused any reasoning model outside a short list of family
 * prefixes, justified as knowing how to serialize that family's thinking. That justification did
 * not survive measurement: Workers AI ignores every vendor-native thinking dialect, so the prefix
 * named a set this repository had looked at rather than a capability it had. Its one concrete
 * effect was to exclude `@cf/openai/gpt-oss-120b` — the fastest builder model this project has
 * verified end to end, 17m13s against the pin's 26m26s — from ever being promoted. The protection
 * that does real work is the ordering above it: the human pin first, then a family measured against
 * the builder's own request shape, and only then a guess.
 */
export function resolveBuilderDefaultModel(models: readonly WorkersAiModel[]): WorkersAiModel {
  const pinned = models.find(({ id }) => id === CLOUDFLARE_WORKERS_AI_MODEL);
  if (pinned) {
    return pinned;
  }
  const preferred = newestPreferredFallbackWorkersAiModel(models);
  // Copied before sorting: `models` belongs to the caller, and the picker reads the same array to
  // build its rows, so ranking must not reorder it underneath them.
  const replacement = preferred ?? [...models].sort(byBuilderDefaultPreference)[0];
  // Nothing discovered at all: the reviewed literal is still the best-understood configuration,
  // and letting the request reach the binding surfaces a named provider error rather than an
  // invented substitute nobody reviewed.
  const chosen = replacement ?? DEFAULT_WORKERS_AI_MODEL;
  let rule: 'newest_preferred_family' | 'ranked_preference' | 'reviewed_literal';
  if (preferred) {
    rule = 'newest_preferred_family';
  } else if (replacement) {
    rule = 'ranked_preference';
  } else {
    rule = 'reviewed_literal';
  }
  // Retirement is rare and consequential, and nothing else in the request tells an operator that
  // the reviewed pin is gone — the build simply runs on a model nobody chose. The model that is
  // actually returned is logged unconditionally, because a build always runs on one; the rule is
  // logged beside it because "which model" alone does not say whether a reviewed second choice was
  // available, the ranking had to invent one, or the literal had to stand in.
  console.warn({
    event: 'workers_ai_default_model_retired',
    pinned: CLOUDFLARE_WORKERS_AI_MODEL,
    replacement: chosen.id,
    rule,
  });
  return chosen;
}

/**
 * Ranked by what a Ghostbuild build actually consumes: images first, because a builder that cannot
 * read a screenshot loses a whole class of work; then window, because it bounds the transcript
 * before compaction; then publication date, since a newer model of equal shape is the closer
 * replacement. Undated entries rank last — an unknown date is not a claim to be old, but it is not
 * a claim to be new either — and `sort` being stable leaves catalog order as the final tiebreak.
 */
function byBuilderDefaultPreference(left: WorkersAiModel, right: WorkersAiModel): number {
  if (left.vision !== right.vision) {
    return left.vision ? -1 : 1;
  }
  if (left.contextTokens !== right.contextTokens) {
    return right.contextTokens - left.contextTokens;
  }
  const leftPublished = workersAiModelPublishedTime(left);
  const rightPublished = workersAiModelPublishedTime(right);
  return leftPublished === rightPublished ? 0 : rightPublished - leftPublished;
}

export function workersAiModelCatalogPayload(models: WorkersAiModel[]): WorkersAiModelCatalogPayload {
  // The default's label, window, and capabilities are Cloudflare's current truth about it, not a
  // hand-written copy that drifts. It stays first so the picker's top row does not move whenever
  // Cloudflare publishes something newer.
  const defaultModel = resolveBuilderDefaultModel(models);
  return {
    defaultModelId: defaultModel.id,
    models: [defaultModel, ...models.filter(({ id }) => id !== defaultModel.id)],
  };
}

/**
 * Cloudflare's catalog dates each entry, but `AiModelsSearchObject` does not declare the field, so
 * it is read as data rather than asserted onto the generated type.
 */
const catalogEntryDateSchema = z.looseObject({ created_at: z.string().min(1).max(64).optional().catch(undefined) });

function catalogEntryCreatedAt(entry: AiModelsSearchObject): string | undefined {
  const parsed = catalogEntryDateSchema.safeParse(entry).data?.created_at;
  return parsed !== undefined && !Number.isNaN(Date.parse(parsed)) ? new Date(parsed).toISOString() : undefined;
}

function numericProperty(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function boundedDescription(value: string): string {
  const description = value.replace(/\s+/g, ' ').trim().slice(0, 1_000);
  return description || 'Cloudflare-hosted model with function calling support.';
}

function workersAiModelLabel(modelId: WorkersAiModelId): string {
  return modelId
    .slice(modelId.lastIndexOf('/') + 1)
    .split('-')
    .map((part) => (/^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bOss\b/g, 'OSS')
    .replace(/\bFp8\b/g, 'FP8');
}
