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
/** The most recent catalog request, which alone may install what it fetched. */
let latestCatalog: Promise<void> = Promise.resolve();
let catalogRequests = 0;
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
/**
 * `error` is a catalog that never loaded, so only the default model is known; `stale` is a refresh
 * that failed while an earlier catalog is installed, which still stands.
 */
type BuilderModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';
export const builderModelCatalogStatusStore = atom<BuilderModelCatalogStatus>('idle');

/** The reasoning effort chosen per model id, as this browser keeps it. */
type BuilderReasoningChoices = Readonly<Record<string, BuilderReasoningLevel>>;

/**
 * The reasoning effort this browser chose per model id. A model with no entry runs at its provider's
 * default effort ("Default"), which is also what an entry the model no longer offers means.
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

/**
 * The model a turn on `modelId` runs on, as this browser knows it. Before the live catalog arrives a
 * saved model is trusted by its id alone (see `catalogInstalled`), so it stands in as that id at its
 * saved effort rather than as the default model; the server checks both against the account's catalog.
 * A catalog that failed to load leaves it standing in, and its description says so.
 */
export function builderModelFor(
  modelId: BuilderModelId,
  models: readonly BuilderModel[] = builderModelsStore.get(),
  choices: BuilderReasoningChoices = builderReasoningChoicesStore.get(),
  catalogStatus: BuilderModelCatalogStatus = builderModelCatalogStatusStore.get(),
): BuilderModel {
  const listed = models.find(({ id }) => id === modelId);
  if (listed !== undefined || catalogInstalled) {
    return listed ?? getBuilderModel(modelId, models);
  }
  const saved = choices[modelId];
  const standIn: BuilderModel = {
    id: modelId,
    label: modelId,
    description:
      catalogStatus === 'error'
        ? 'Your saved model. The catalog could not be loaded, so it is checked when a turn starts.'
        : 'Loading the model catalog.',
    contextTokens: 0,
    requiresPaid: false,
    reasoning: saved !== undefined,
    vision: false,
  };
  if (saved !== undefined) {
    standIn.reasoningLevels = [saved];
  }
  return standIn;
}

/** The effort the current turn's model asks for, as the request body carries it. */
function currentBuilderReasoningLevel(modelId: BuilderModelId): BuilderReasoningLevel | undefined {
  return builderReasoningLevelFor(builderModelFor(modelId));
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

/**
 * Loads the account's catalog, joining a request already in flight. After a change to what the
 * account offers (a key linked or unlinked) call `reloadBuilderModelCatalog`, whose request starts
 * after that change rather than being one sent before it.
 */
export function loadBuilderModelCatalog(
  request: typeof fetchUserRuntime = fetchUserRuntime,
  storage?: BuilderModelStorage,
): Promise<void> {
  return pendingCatalog ?? requestBuilderModelCatalog(request, storage);
}

/**
 * Loads the account's catalog with a request of its own. A request still in flight is superseded:
 * whatever it fetches is discarded, and it settles when this one does. The runtime lets the browser
 * keep its catalog for a minute, so this request bypasses that cache to see the change.
 */
export function reloadBuilderModelCatalog(
  request: typeof fetchUserRuntime = fetchUserRuntime,
  storage?: BuilderModelStorage,
): Promise<void> {
  return requestBuilderModelCatalog(request, storage, { cache: 'no-store' });
}

function requestBuilderModelCatalog(
  request: typeof fetchUserRuntime,
  storage?: BuilderModelStorage,
  init: RequestInit = {},
): Promise<void> {
  const requestNumber = ++catalogRequests;
  const superseded = () => requestNumber !== catalogRequests;
  builderModelCatalogStatusStore.set('loading');
  const operation: Promise<void> = request('/v1/models', { ...init, headers: { Accept: 'application/json' } })
    .then(async (response) => {
      const parsed = builderModelCatalogPayloadSchema.safeParse(await response.json().catch(() => null));
      const payload = parsed.success ? validateBuilderModelCatalogPayload(parsed.data) : null;
      if (superseded()) {
        return;
      }
      if (!response.ok || payload === null) {
        throw new Error('The Workers AI model catalog response is invalid.');
      }
      installBuilderModelCatalog(payload, storage);
      builderModelCatalogStatusStore.set('ready');
    })
    .catch(() => {
      if (!superseded()) {
        builderModelCatalogStatusStore.set(catalogInstalled ? 'stale' : 'error');
      }
    })
    .finally(() => {
      if (pendingCatalog === operation) {
        pendingCatalog = null;
      }
    })
    .then(() => (superseded() ? latestCatalog : undefined));
  pendingCatalog = operation;
  latestCatalog = operation;
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
  // The same trust as a saved preference on load: before the catalog arrives, any well-formed id.
  builderModelStore.set(
    saved !== null && (!catalogInstalled || models.some(({ id }) => id === saved))
      ? saved
      : builderDefaultModelStore.get(),
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
