import { atom } from 'nanostores';
import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isBuilderModelId,
  MAX_BUILDER_CATALOG_MODELS,
  upgradeLegacyBuilderModelId,
  validateBuilderModelCatalogPayload,
  builderModelCatalogPayloadSchema,
  builderReasoningLevelSchema,
  getBuilderModel,
  type BuilderModel,
  type BuilderModelCatalogPayload,
  type BuilderModelId,
  type BuilderReasoningLevel,
} from '~/lib/workers-ai-model';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';

const BUILDER_MODEL_STORAGE_KEY = 'cloudchef_builder_model_v2';
/** Namespaced beside the model preference: same owner, same lifetime, same browser-only scope. */
const BUILDER_SEEN_MODELS_STORAGE_KEY = 'cloudchef_seen_builder_models_v1';
/** The reasoning effort chosen for each model, so switching models never carries a level across. */
const BUILDER_REASONING_STORAGE_KEY = 'cloudchef_builder_reasoning_v1';
/** One more than the catalog payload's ceiling, so a full catalog always fits. */
const MAX_SEEN_MODEL_IDS = MAX_BUILDER_CATALOG_MODELS + 1;
let pendingCatalog: Promise<void> | null = null;
/**
 * Until the live catalog arrives, `builderModelsStore` holds only the pinned default, so a
 * membership test would discard every other saved preference — including on the opening turn of a
 * homepage-started build. Before that point any well-formed saved id is trusted; the server still
 * validates availability against the account's catalog, and once the catalog arrives a saved model
 * it no longer offers falls back to the catalog's default (the team's, where its admin chose one).
 */
let catalogInstalled = false;

/**
 * Reading is required; writing is optional so an existing caller that only stubs `getItem` keeps
 * working, and the real `localStorage` is used for the write it did not stub.
 */
type BuilderModelStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>;

const seenModelIdsSchema = z.array(z.string()).max(MAX_SEEN_MODEL_IDS);
/** Unreadable entries are skipped one by one, so a single bad value never discards every choice. */
const reasoningChoicesSchema = z.record(z.string(), z.unknown());

export const builderModelStore = atom<BuilderModelId>(CLOUDFLARE_WORKERS_AI_MODEL);
export const builderDefaultModelStore = atom<BuilderModelId>(CLOUDFLARE_WORKERS_AI_MODEL);
export const builderModelsStore = atom<readonly BuilderModel[]>([DEFAULT_WORKERS_AI_MODEL]);
export const builderModelCatalogStatusStore = atom<'idle' | 'loading' | 'ready' | 'error'>('idle');

/** The reasoning effort chosen per model id, as this browser keeps it. */
type BuilderReasoningChoices = Readonly<Record<string, BuilderReasoningLevel>>;

/**
 * The reasoning effort this browser chose per model id. A model with no entry runs at its provider's
 * default effort ("Provider default"), which is also what an entry the model no longer offers means.
 */
export const builderReasoningChoicesStore = atom<BuilderReasoningChoices>({});

/**
 * Models Cloudflare has added since this browser last looked. Empty on the first ever catalog
 * load: with nothing recorded there is no "since", so the whole catalog is seeded silently rather
 * than announced as new.
 */
export const builderNewModelsStore = atom<readonly BuilderModel[]>([]);

export function loadBuilderModelPreference(storage?: BuilderModelStorage): void {
  applyStoredModelPreference(storage);
  builderReasoningChoicesStore.set(readReasoningChoices(storage));
}

/**
 * The effort a turn on `model` asks for: the one chosen for it while the model still offers it, and
 * otherwise none — the provider's default — so a level never outlives the model that offered it.
 */
export function builderReasoningLevelFor(
  model: Pick<BuilderModel, 'id' | 'reasoningLevels'>,
  choices: BuilderReasoningChoices = builderReasoningChoicesStore.get(),
): BuilderReasoningLevel | undefined {
  const chosen = choices[model.id];
  return chosen !== undefined && model.reasoningLevels?.includes(chosen) ? chosen : undefined;
}

/** The effort the current turn's model asks for, as the request body carries it. */
function currentBuilderReasoningLevel(modelId: BuilderModelId): BuilderReasoningLevel | undefined {
  return builderReasoningLevelFor(getBuilderModel(modelId, builderModelsStore.get()));
}

/**
 * The model fields every builder turn's request carries: the model, and the effort chosen for it —
 * no `reasoningLevel` at all for the provider's default, so nothing is sent that could override it.
 */
export function builderModelRequestFields(modelId: BuilderModelId = builderModelStore.get()): {
  modelId: BuilderModelId;
  reasoningLevel?: BuilderReasoningLevel;
} {
  const reasoningLevel = currentBuilderReasoningLevel(modelId);
  return reasoningLevel === undefined ? { modelId } : { modelId, reasoningLevel };
}

/** Records the effort chosen for one model; `undefined` returns it to the provider's default. */
export function setBuilderReasoningLevel(
  modelId: BuilderModelId,
  level: BuilderReasoningLevel | undefined,
  storage?: Pick<Storage, 'setItem'>,
): void {
  const { [modelId]: _previous, ...others } = builderReasoningChoicesStore.get();
  const next = level === undefined ? others : { ...others, [modelId]: level };
  builderReasoningChoicesStore.set(next);
  try {
    (storage ?? localStorage).setItem(BUILDER_REASONING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The in-memory choice still applies when browser storage is unavailable.
  }
}

export function loadBuilderModelCatalog(
  request: typeof fetchUserRuntime = fetchUserRuntime,
  storage?: BuilderModelStorage,
): Promise<void> {
  if (pendingCatalog) {
    return pendingCatalog;
  }
  builderModelCatalogStatusStore.set('loading');
  const operation = request('/v1/models', { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      const parsed = builderModelCatalogPayloadSchema.safeParse(await response.json().catch(() => null));
      const payload = parsed.success ? validateBuilderModelCatalogPayload(parsed.data) : null;
      if (!response.ok || payload === null) {
        throw new Error('The Workers AI model catalog response is invalid.');
      }
      installBuilderModelCatalog(payload, storage);
      builderModelCatalogStatusStore.set('ready');
    })
    .catch(() => {
      builderModelCatalogStatusStore.set('error');
    })
    .finally(() => {
      if (pendingCatalog === operation) {
        pendingCatalog = null;
      }
    });
  pendingCatalog = operation;
  return operation;
}

export function installBuilderModelCatalog(payload: BuilderModelCatalogPayload, storage?: BuilderModelStorage): void {
  // The runtime names the default: the one the account's admin chose, while it is still offered.
  const models = payload.models;
  const defaultModel = models.find(({ id }) => id === payload.defaultModelId) ?? models[0] ?? DEFAULT_WORKERS_AI_MODEL;
  const offeredModels = models.length > 0 ? models : [defaultModel];
  builderModelsStore.set(offeredModels);
  builderDefaultModelStore.set(defaultModel.id);
  catalogInstalled = true;
  applyStoredModelPreference(storage);
  applyUnseenModels(offeredModels, storage);
}

/**
 * The user has now been shown what is new — because the picker opened, or because the notice was
 * dismissed — so the current catalog becomes the baseline the next load is compared against.
 */
export function markBuilderModelsSeen(storage?: BuilderModelStorage): void {
  if (builderNewModelsStore.get().length === 0) {
    return;
  }
  builderNewModelsStore.set([]);
  writeSeenModelIds(
    builderModelsStore.get().map(({ id }) => id),
    storage,
  );
}

/** Keep the default first. */
export function orderBuilderModelsForDisplay(
  models: readonly BuilderModel[],
  defaultModelId: BuilderModelId,
): readonly BuilderModel[] {
  return [...models].sort((left, right) => Number(right.id === defaultModelId) - Number(left.id === defaultModelId));
}

export function setBuilderModel(modelId: BuilderModelId, storage?: Pick<Storage, 'setItem'>): void {
  if (!builderModelsStore.get().some(({ id }) => id === modelId)) {
    return;
  }
  builderModelStore.set(modelId);
  try {
    (storage ?? localStorage).setItem(BUILDER_MODEL_STORAGE_KEY, modelId);
  } catch {
    // The in-memory preference still applies when browser storage is unavailable.
  }
}

export function syncBuilderModelPreference(event: Pick<StorageEvent, 'key' | 'newValue'>): void {
  if (event.key === BUILDER_REASONING_STORAGE_KEY) {
    builderReasoningChoicesStore.set(parseReasoningChoices(event.newValue));
    return;
  }
  if (event.key !== BUILDER_MODEL_STORAGE_KEY) {
    return;
  }
  const models = builderModelsStore.get();
  const saved = readSavedModelId(event.newValue);
  builderModelStore.set(
    saved !== null && models.some(({ id }) => id === saved) ? saved : builderDefaultModelStore.get(),
  );
}

function readSavedModelId(value: string | null): BuilderModelId | null {
  const upgraded = upgradeLegacyBuilderModelId(value);
  return isBuilderModelId(upgraded) ? upgraded : null;
}

function readReasoningChoices(storage?: BuilderModelStorage): BuilderReasoningChoices {
  try {
    return parseReasoningChoices((storage ?? localStorage).getItem(BUILDER_REASONING_STORAGE_KEY));
  } catch {
    return {};
  }
}

function parseReasoningChoices(value: string | null): BuilderReasoningChoices {
  if (value === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  const record = reasoningChoicesSchema.safeParse(parsed);
  if (!record.success) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record.data).flatMap(([modelId, level]) => {
      const parsedLevel = builderReasoningLevelSchema.safeParse(level);
      return isBuilderModelId(modelId) && parsedLevel.success ? [[modelId, parsedLevel.data] as const] : [];
    }),
  );
}

function applyUnseenModels(models: readonly BuilderModel[], storage?: BuilderModelStorage): void {
  const seen = readSeenModelIds(storage);
  if (seen === null) {
    // Nothing recorded yet: this browser has no "before", so today's catalog is the baseline.
    builderNewModelsStore.set([]);
    writeSeenModelIds(
      models.map(({ id }) => id),
      storage,
    );
    return;
  }
  builderNewModelsStore.set(models.filter(({ id }) => !seen.has(id)));
}

function readSeenModelIds(storage?: BuilderModelStorage): Set<string> | null {
  try {
    const persisted = (storage ?? localStorage).getItem(BUILDER_SEEN_MODELS_STORAGE_KEY);
    if (persisted === null) {
      return null;
    }
    const parsed = seenModelIdsSchema.safeParse(JSON.parse(persisted));
    // Unreadable storage is treated as unrecorded, so a corrupt value reseeds instead of
    // announcing the entire catalog as new.
    return parsed.success ? new Set(parsed.data) : null;
  } catch {
    return null;
  }
}

function writeSeenModelIds(modelIds: readonly string[], storage?: BuilderModelStorage): void {
  try {
    const write = storage?.setItem?.bind(storage) ?? localStorage.setItem.bind(localStorage);
    write(BUILDER_SEEN_MODELS_STORAGE_KEY, JSON.stringify(modelIds.slice(0, MAX_SEEN_MODEL_IDS)));
  } catch {
    // Nothing is recorded when browser storage is unavailable; the next load simply reseeds.
  }
}

function applyStoredModelPreference(storage?: BuilderModelStorage): void {
  const defaultModel = builderDefaultModelStore.get();
  const models = builderModelsStore.get();
  try {
    const persisted = readSavedModelId((storage ?? localStorage).getItem(BUILDER_MODEL_STORAGE_KEY));
    builderModelStore.set(
      persisted !== null && (!catalogInstalled || models.some(({ id }) => id === persisted)) ? persisted : defaultModel,
    );
  } catch {
    builderModelStore.set(defaultModel);
  }
}
