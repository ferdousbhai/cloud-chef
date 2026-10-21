import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  GATEWAY_PROVIDERS,
  gatewayModelProvider,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  NO_ACCOUNT_MODEL_SETTINGS,
  type AccountModelSettings,
  type BuilderModel,
  type BuilderModelCatalogPayload,
  type BuilderModelId,
  type BuilderReasoningLevel,
  type GatewayKey,
  type WorkersAiModelId,
} from '~/lib/workers-ai-model';
import { gatewayBuilderModels, piGatewayModel, piWorkersAiModel, withReasoningLevels } from './pi-model-catalog';

const MAX_CATALOG_MODELS = 100;

type WorkersAiCatalogBinding = Pick<Ai, 'models'>;

export class WorkersAiModelCatalogUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('The Cloudflare Workers AI model catalog is temporarily unavailable.', { cause });
    this.name = 'WorkersAiModelCatalogUnavailableError';
  }
}

/**
 * Read the current account-visible catalog through its AI binding, never control-plane credentials,
 * keeping the models that can drive the builder: native, function calling, a large enough window,
 * and listed by Pi, since a model Pi does not list would be spoken to with a guessed request shape.
 */
export async function readWorkersAiBuilderModelCatalog(binding: WorkersAiCatalogBinding): Promise<BuilderModel[]> {
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

  const models = new Map<WorkersAiModelId, BuilderModel>();
  for (const entry of catalog) {
    const properties = new Map(entry.properties.map(({ property_id, value }) => [property_id, value]));
    const contextTokens = numericProperty(properties.get('context_window'));
    const piModel = isWorkersAiModelId(entry.name) ? piWorkersAiModel(entry.name) : undefined;
    if (
      entry.source !== 1 ||
      entry.task.name !== 'Text Generation' ||
      !isWorkersAiModelId(entry.name) ||
      piModel === undefined ||
      properties.get('function_calling') !== 'true' ||
      contextTokens < MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS
    ) {
      continue;
    }
    const reasoning = properties.get('reasoning') === 'true';
    const model: BuilderModel = {
      id: entry.name,
      label: workersAiModelLabel(entry.name),
      description: boundedDescription(entry.description),
      contextTokens,
      requiresPaid: properties.get('require_workers_paid') === 'true',
      reasoning,
      vision: properties.get('vision') === 'true',
      // The efforts Pi's catalog lists for the model, offered only while Cloudflare says it reasons.
      ...(reasoning ? withReasoningLevels(piModel) : {}),
    };
    const createdAt = catalogEntryCreatedAt(entry);
    if (createdAt !== undefined) {
      model.createdAt = createdAt;
    }
    models.set(entry.name, model);
  }
  return [...models.values()];
}

/**
 * The model a builder turn runs on, confirmed against what the account can serve now: a Workers AI
 * model against the account's live catalog; a gateway provider's model against Pi's catalog and the
 * account's keys on its default gateway, which are asked about only for such a turn. A gateway model
 * comes with the alias of the account's key for its provider, which its requests name.
 */
export async function requireBuilderModel(
  binding: WorkersAiCatalogBinding,
  modelId: BuilderModelId,
  gatewayKeys: () => Promise<GatewayKey[]>,
): Promise<{ model: BuilderModel; gatewayKeyAlias?: string }> {
  const provider = gatewayModelProvider(modelId);
  if (provider === null) {
    return { model: await requireWorkersAiBuilderModel(binding, modelId) };
  }
  const model = piGatewayModel(modelId)?.builderModel;
  if (!model) {
    throw new Response('The selected model is not compatible with the CloudChef builder.', { status: 400 });
  }
  // Fail closed: a provider's model is sent only while the account's gateway holds its own key for it.
  // A lookup that failed says nothing about whether the key is there, so it is reported as a check
  // that could not be made — retryable — rather than as a key an admin has to go and link.
  const { label } = GATEWAY_PROVIDERS[provider];
  let keys: GatewayKey[];
  try {
    keys = await gatewayKeys();
  } catch (error) {
    console.warn({ event: 'gateway_key_lookup_failed', provider, error: String(error) });
    throw new Response(`CloudChef could not check this account's ${label} key just now. Try again in a moment.`, {
      status: 503,
      headers: { 'retry-after': '5' },
    });
  }
  const key = keys.find((candidate) => candidate.provider === provider);
  if (!key) {
    throw new Response(
      `${label} is not set up for this account. An admin can link a ${label} key in Settings, under Models.`,
      { status: 409 },
    );
  }
  return { model, gatewayKeyAlias: key.alias };
}

/**
 * The reasoning effort a turn runs at: none chosen means the provider's default, and a chosen one
 * must be an effort the model offers. A level the picker could not have offered for this model is
 * refused rather than mapped to something else, so a turn never runs at an effort nobody chose.
 */
export function requireBuilderReasoningLevel(
  model: BuilderModel,
  level: BuilderReasoningLevel | undefined,
): BuilderReasoningLevel | undefined {
  if (level === undefined) {
    return undefined;
  }
  if (!model.reasoningLevels?.includes(level)) {
    throw new Response(
      `${model.label} does not offer the "${level}" reasoning effort. Choose another in the model picker.`,
      {
        status: 400,
      },
    );
  }
  return level;
}

export async function requireWorkersAiBuilderModel(
  binding: WorkersAiCatalogBinding,
  modelId: BuilderModelId,
): Promise<BuilderModel> {
  let models: BuilderModel[];
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

/**
 * The pinned model while the account serves it. Once it is retired, the first model the account
 * offers takes its place; only an account offering none keeps the reviewed literal.
 */
export function resolveBuilderDefaultModel(models: readonly BuilderModel[]): BuilderModel {
  const pinned = models.find(({ id }) => id === CLOUDFLARE_WORKERS_AI_MODEL);
  if (pinned) {
    return pinned;
  }
  const offered = models.at(0);
  const chosen = offered ?? DEFAULT_WORKERS_AI_MODEL;
  console.warn({
    event: 'workers_ai_default_model_retired',
    pinned: CLOUDFLARE_WORKERS_AI_MODEL,
    replacement: chosen.id,
    rule: offered ? 'first_offered' : 'reviewed_literal',
  });
  return chosen;
}

/**
 * The picker's catalog: the account's Workers AI models, and Pi's models of each gateway provider
 * the account's default gateway holds a key for. The default is the one the account's admin chose
 * while it is still offered, and otherwise the pinned model.
 */
export function builderModelCatalogPayload(
  workersAiModels: BuilderModel[],
  settings: AccountModelSettings = NO_ACCOUNT_MODEL_SETTINGS,
): BuilderModelCatalogPayload {
  const offered = [...workersAiModels, ...gatewayBuilderModels(settings.gatewayKeys.map(({ provider }) => provider))];
  // The default's label, window, and capabilities are Cloudflare's current truth about it, not a
  // hand-written copy that drifts. It stays first so the picker's top row does not move whenever
  // Cloudflare publishes something newer.
  const defaultModel =
    offered.find(({ id }) => id === settings.defaultModelId) ?? resolveBuilderDefaultModel(workersAiModels);
  return {
    defaultModelId: defaultModel.id,
    models: [defaultModel, ...offered.filter(({ id }) => id !== defaultModel.id)],
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
