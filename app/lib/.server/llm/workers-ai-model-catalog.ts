import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  CLOUDFLARE_ALTERNATIVE_BUILDER_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  isSupportedBuilderModel,
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
      !isSupportedBuilderModel(entry.name) ||
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
    // reviewed against CloudChef's tool protocol, so it still runs from its reviewed literal;
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
  throw new Response('The selected Workers AI model is not compatible with the CloudChef builder.', {
    status: 400,
  });
}

/** Never promote an unrelated model when the preferred default disappears. */
export function resolveBuilderDefaultModel(models: readonly WorkersAiModel[]): WorkersAiModel {
  const pinned = models.find(({ id }) => id === CLOUDFLARE_WORKERS_AI_MODEL);
  if (pinned) {
    return pinned;
  }
  const alternative = models.find(({ id }) => id === CLOUDFLARE_ALTERNATIVE_BUILDER_MODEL);
  const chosen = alternative ?? DEFAULT_WORKERS_AI_MODEL;
  console.warn({
    event: 'workers_ai_default_model_retired',
    pinned: CLOUDFLARE_WORKERS_AI_MODEL,
    replacement: chosen.id,
    rule: alternative ? 'selected_alternative' : 'reviewed_literal',
  });
  return chosen;
}

export function workersAiModelCatalogPayload(models: WorkersAiModel[]): WorkersAiModelCatalogPayload {
  // The default's label, window, and capabilities are Cloudflare's current truth about it, not a
  // hand-written copy that drifts. It stays first so the picker's top row does not move whenever
  // Cloudflare publishes something newer.
  const defaultModel = resolveBuilderDefaultModel(models);
  return {
    defaultModelId: defaultModel.id,
    models: [defaultModel, ...models.filter(({ id }) => isSupportedBuilderModel(id) && id !== defaultModel.id)],
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
    .replace(/\bDeepseek\b/g, 'DeepSeek')
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bOss\b/g, 'OSS')
    .replace(/\bFp8\b/g, 'FP8');
}
