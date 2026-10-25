import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  GATEWAY_PROVIDERS,
  gatewayModelProvider,
  isBuilderModelAllowed,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  modelIdLabel,
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

const NO_ALLOWED_MODEL_MESSAGE =
  "None of the models allowed in this account can run right now. Others can be allowed in Settings, under Models, by the team's admins, or by you in Personal.";

/** The account's admin allows models, but none of them can run in the account now. */
export class NoAllowedBuilderModelError extends Error {
  constructor() {
    super(NO_ALLOWED_MODEL_MESSAGE);
    this.name = 'NoAllowedBuilderModelError';
  }
}

/** The account's model settings, which a turn cannot be checked without. */
const UNCHECKED_SETTINGS_MESSAGE =
  'CloudChef could not check which models this account allows just now. Try again in a moment.';

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
      label: modelIdLabel(entry.name),
      description: boundedDescription(entry.description),
      contextTokens,
      requiresPaid: properties.get('require_workers_paid') === 'true',
      reasoning,
      vision: properties.get('vision') === 'true',
    };
    // The efforts Pi's catalog lists for the model, offered only while Cloudflare says it reasons.
    if (reasoning) {
      Object.assign(model, withReasoningLevels(piModel));
    }
    const createdAt = catalogEntryCreatedAt(entry);
    if (createdAt !== undefined) {
      model.createdAt = createdAt;
    }
    models.set(entry.name, model);
  }
  return [...models.values()];
}

/**
 * The model a builder turn runs on, confirmed against what the account allows and can serve now: the
 * account's admin must allow it; a Workers AI model is checked against the account's live catalog; a
 * gateway provider's model against Pi's catalog and the account's keys on its default gateway. A
 * gateway model comes with the alias of the account's key for its provider, which its requests name.
 *
 * Fail closed: settings that could not be learned (null, or a lookup that threw) say nothing about
 * what the admin allows or which keys are there, so the turn is refused as a check that could not be
 * made — retryable — rather than run on a model the admin may have taken out of the picker. A model
 * the admin does not allow is refused, as a retired one is, rather than swapped for another the
 * person did not choose: the picker no longer lists it, and starts on the account's default instead.
 */
export async function requireBuilderModel(
  binding: WorkersAiCatalogBinding,
  modelId: BuilderModelId,
  accountSettings: () => Promise<AccountModelSettings | null>,
): Promise<{ model: BuilderModel; gatewayKeyAlias?: string; gatewayKeyRevision?: string }> {
  let settings: AccountModelSettings | null;
  try {
    settings = await accountSettings();
  } catch (error) {
    console.warn({ event: 'account_model_settings_lookup_failed', error: String(error) });
    settings = null;
  }
  if (settings === null) {
    throw new Response(UNCHECKED_SETTINGS_MESSAGE, { status: 503, headers: { 'retry-after': '5' } });
  }
  if (!isBuilderModelAllowed(settings, modelId)) {
    throw new Response(
      `${knownModelLabel(modelId)} isn't allowed in this account. Choose another model in the model picker; the models it offers are chosen in Settings, under Models, by the team's admins, or by you in Personal.`,
      { status: 403 },
    );
  }
  const provider = gatewayModelProvider(modelId);
  if (provider === null) {
    return { model: await requireWorkersAiBuilderModel(binding, modelId, settings) };
  }
  const model = piGatewayModel(modelId)?.builderModel;
  if (!model) {
    throw new Response('The selected model is not compatible with the CloudChef builder.', { status: 400 });
  }
  // A provider's model is sent only while the account's gateway holds its own key for it.
  const { label } = GATEWAY_PROVIDERS[provider];
  const key = settings.gatewayKeys.find((candidate) => candidate.provider === provider);
  if (!key) {
    throw new Response(
      `${label} is not set up for this account. An admin can link a ${label} key in Settings, under Models.`,
      { status: 409 },
    );
  }
  return { model, gatewayKeyAlias: key.alias, gatewayKeyRevision: key.revision };
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

/**
 * A Workers AI model confirmed against the account's live catalog. `settings` is the account's, for a
 * turn the person chose a model for: when the pinned model has been retired, the model that takes its
 * place is one the admin allows.
 */
export async function requireWorkersAiBuilderModel(
  binding: WorkersAiCatalogBinding,
  modelId: BuilderModelId,
  settings: Pick<AccountModelSettings, 'allowedModelIds'> = NO_ACCOUNT_MODEL_SETTINGS,
): Promise<BuilderModel> {
  let models: BuilderModel[];
  try {
    models = await readWorkersAiBuilderModelCatalog(binding);
  } catch (error) {
    // Discovery being down must not change which model a build runs on. The pinned model was
    // reviewed against CloudChef's tool protocol, so it still runs from its reviewed literal;
    // any other id is a claim only the catalog can confirm, so the outage surfaces instead.
    if (error instanceof WorkersAiModelCatalogUnavailableError && modelId === CLOUDFLARE_WORKERS_AI_MODEL) {
      return reviewedDefaultModel();
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
    const allowed = models.filter(({ id }) => isBuilderModelAllowed(settings, id));
    if (allowed.length === 0 && settings.allowedModelIds !== null) {
      // Only Workers AI models stand in for the pin; other allowed models may still run, picked by the person.
      throw new Response(
        "CloudChef's default model isn't offered any more. Choose another model in the model picker.",
        { status: 409 },
      );
    }
    return resolveBuilderDefaultModel(allowed);
  }
  throw new Response('The selected Workers AI model is not compatible with the CloudChef builder.', {
    status: 400,
  });
}

/**
 * The pinned model's reviewed literal, with the reasoning efforts Pi's catalog lists for it, as the
 * live catalog would offer them: an effort the person chose stands while the catalog is unreachable.
 */
function reviewedDefaultModel(): BuilderModel {
  const piModel = piWorkersAiModel(DEFAULT_WORKERS_AI_MODEL.id);
  return piModel && DEFAULT_WORKERS_AI_MODEL.reasoning
    ? { ...DEFAULT_WORKERS_AI_MODEL, ...withReasoningLevels(piModel) }
    : DEFAULT_WORKERS_AI_MODEL;
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
  const chosen = offered ?? reviewedDefaultModel();
  console.warn({
    event: 'workers_ai_default_model_retired',
    pinned: CLOUDFLARE_WORKERS_AI_MODEL,
    replacement: chosen.id,
    rule: offered ? 'first_offered' : 'reviewed_literal',
  });
  return chosen;
}

/**
 * Every model the account could offer, whatever its admin allows: its Workers AI models, and Pi's
 * models of each gateway provider the account's default gateway holds a key for.
 */
export function compatibleBuilderModels(
  workersAiModels: readonly BuilderModel[],
  gatewayKeys: readonly Pick<GatewayKey, 'provider'>[],
): BuilderModel[] {
  return [...workersAiModels, ...gatewayBuilderModels(gatewayKeys.map(({ provider }) => provider))];
}

/**
 * The picker's catalog: the compatible models (see `compatibleBuilderModels`) the account's admin
 * allows. The default is the one the admin chose while it is still offered, and otherwise the pinned
 * model; with an allowlist, the pinned model only while it is allowed, and else the first allowed
 * model. Throws `NoAllowedBuilderModelError` when the admin allows none the account can run.
 */
export function builderModelCatalogPayload(
  workersAiModels: BuilderModel[],
  settings: AccountModelSettings = NO_ACCOUNT_MODEL_SETTINGS,
): BuilderModelCatalogPayload {
  const offered = compatibleBuilderModels(workersAiModels, settings.gatewayKeys).filter(({ id }) =>
    isBuilderModelAllowed(settings, id),
  );
  // The default's label, window, and capabilities are Cloudflare's current truth about it, not a
  // hand-written copy that drifts. It stays first so the picker's top row does not move whenever
  // Cloudflare publishes something newer.
  const defaultModel =
    offered.find(({ id }) => id === settings.defaultModelId) ??
    (settings.allowedModelIds === null
      ? resolveBuilderDefaultModel(workersAiModels)
      : (offered.find(({ id }) => id === CLOUDFLARE_WORKERS_AI_MODEL) ?? offered.at(0)));
  if (defaultModel === undefined) {
    throw new NoAllowedBuilderModelError();
  }
  return {
    defaultModelId: defaultModel.id,
    models: [defaultModel, ...offered.filter(({ id }) => id !== defaultModel.id)],
  };
}

/**
 * The runtime's `/v1/models`, the picker's catalog of the models the account's admin allows, and,
 * with `compatible`, `/v1/models/compatible`: every model the account could offer, for Settings to
 * show the admin what there is to allow. Settings that cannot be learned fail the request (what the
 * admin allows is unknown, so nothing is offered on a guess), as does a catalog Cloudflare cannot list.
 */
export async function builderModelCatalogResponse(
  binding: WorkersAiCatalogBinding,
  accountSettings: () => Promise<AccountModelSettings | null>,
  { compatible = false }: { compatible?: boolean } = {},
): Promise<Response> {
  let models: BuilderModel[];
  let settings: AccountModelSettings | null;
  try {
    [models, settings] = await Promise.all([readWorkersAiBuilderModelCatalog(binding), accountSettings()]);
  } catch (error) {
    console.warn('Workers AI model catalog could not be loaded', error);
    return Response.json({ error: 'The Workers AI model catalog is temporarily unavailable.' }, { status: 503 });
  }
  if (settings === null) {
    return Response.json({ error: UNCHECKED_SETTINGS_MESSAGE }, { status: 503, headers: { 'retry-after': '5' } });
  }
  // Short, so a newly linked key, chosen default, or allowed model reaches open tabs soon.
  const headers = { 'Cache-Control': 'private, max-age=60' };
  if (compatible) {
    return Response.json({ models: compatibleBuilderModels(models, settings.gatewayKeys) }, { headers });
  }
  try {
    return Response.json(builderModelCatalogPayload(models, settings), { headers });
  } catch (error) {
    if (error instanceof NoAllowedBuilderModelError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
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

/** A model's name as Pi lists it, for a message about a model that may not be in the account's catalog. */
export function knownModelLabel(modelId: BuilderModelId): string {
  return gatewayModelProvider(modelId) !== null
    ? (piGatewayModel(modelId)?.builderModel.label ?? modelIdLabel(modelId))
    : modelIdLabel(modelId);
}

function numericProperty(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function boundedDescription(value: string): string {
  const description = value.replace(/\s+/g, ' ').trim().slice(0, 1_000);
  return description || 'Cloudflare-hosted model with function calling support.';
}
