import { atom } from 'nanostores';
import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isWorkersAiModelId,
  isSupportedBuilderModel,
  validateWorkersAiModelCatalogPayload,
  workersAiModelCatalogPayloadSchema,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
  type WorkersAiModelId,
} from '~/lib/workers-ai-model';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';

const BUILDER_MODEL_STORAGE_KEY = 'cloudchef_builder_model_v2';
/** Namespaced beside the model preference: same owner, same lifetime, same browser-only scope. */
const BUILDER_SEEN_MODELS_STORAGE_KEY = 'cloudchef_seen_builder_models_v1';
/** One more than the catalog payload's 100-model ceiling, so a full catalog always fits. */
const MAX_SEEN_MODEL_IDS = 101;
let pendingCatalog: Promise<void> | null = null;
/**
 * Until the live catalog arrives, `builderModelsStore` holds only the pinned default, so a
 * membership test would discard every other saved preference — including on the opening turn of a
 * homepage-started build. Before that point only one of the two supported saved ids is trusted; the server
 * still validates availability against the user account catalog.
 */
let catalogInstalled = false;

/**
 * Reading is required; writing is optional so an existing caller that only stubs `getItem` keeps
 * working, and the real `localStorage` is used for the write it did not stub.
 */
type BuilderModelStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>;

const seenModelIdsSchema = z.array(z.string()).max(MAX_SEEN_MODEL_IDS);

export const builderModelStore = atom<WorkersAiModelId>(CLOUDFLARE_WORKERS_AI_MODEL);
export const builderDefaultModelStore = atom<WorkersAiModelId>(CLOUDFLARE_WORKERS_AI_MODEL);
export const builderModelsStore = atom<readonly WorkersAiModel[]>([DEFAULT_WORKERS_AI_MODEL]);
export const builderModelCatalogStatusStore = atom<'idle' | 'loading' | 'ready' | 'error'>('idle');

/**
 * Models Cloudflare has added since this browser last looked. Empty on the first ever catalog
 * load: with nothing recorded there is no "since", so the whole catalog is seeded silently rather
 * than announced as new.
 */
export const builderNewModelsStore = atom<readonly WorkersAiModel[]>([]);

export function loadBuilderModelPreference(storage?: BuilderModelStorage): void {
  applyStoredModelPreference(storage);
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
      const parsed = workersAiModelCatalogPayloadSchema.safeParse(await response.json().catch(() => null));
      const payload = parsed.success ? validateWorkersAiModelCatalogPayload(parsed.data) : null;
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

export function installBuilderModelCatalog(payload: WorkersAiModelCatalogPayload, storage?: BuilderModelStorage): void {
  // Older user runtimes can still return the former broad catalog during an upgrade.
  const models = payload.models.filter(({ id }) => isSupportedBuilderModel(id));
  const defaultModel =
    models.find(({ id }) => id === CLOUDFLARE_WORKERS_AI_MODEL) ?? models[0] ?? DEFAULT_WORKERS_AI_MODEL;
  const supportedModels = models.length > 0 ? models : [defaultModel];
  builderModelsStore.set(supportedModels);
  builderDefaultModelStore.set(defaultModel.id);
  catalogInstalled = true;
  applyStoredModelPreference(storage);
  applyUnseenModels(supportedModels, storage);
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

/** Keep the default first and exclude models returned by older runtime catalogs. */
export function orderBuilderModelsForDisplay(
  models: readonly WorkersAiModel[],
  defaultModelId: WorkersAiModelId,
): readonly WorkersAiModel[] {
  return models
    .filter(({ id }) => isSupportedBuilderModel(id))
    .sort((left, right) => Number(right.id === defaultModelId) - Number(left.id === defaultModelId));
}

export function setBuilderModel(modelId: WorkersAiModelId, storage?: Pick<Storage, 'setItem'>): void {
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
  if (event.key !== BUILDER_MODEL_STORAGE_KEY) {
    return;
  }
  const models = builderModelsStore.get();
  builderModelStore.set(
    isWorkersAiModelId(event.newValue) && models.some(({ id }) => id === event.newValue)
      ? event.newValue
      : builderDefaultModelStore.get(),
  );
}

function applyUnseenModels(models: readonly WorkersAiModel[], storage?: BuilderModelStorage): void {
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
    const persisted = (storage ?? localStorage).getItem(BUILDER_MODEL_STORAGE_KEY);
    builderModelStore.set(
      isWorkersAiModelId(persisted) &&
        isSupportedBuilderModel(persisted) &&
        (!catalogInstalled || models.some(({ id }) => id === persisted))
        ? persisted
        : defaultModel,
    );
  } catch {
    builderModelStore.set(defaultModel);
  }
}
