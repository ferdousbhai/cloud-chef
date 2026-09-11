import { atom } from 'nanostores';
import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isWorkersAiModelId,
  validateWorkersAiModelCatalogPayload,
  workersAiModelCatalogPayloadSchema,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
  type WorkersAiModelId,
} from '~/lib/workers-ai-model';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';

const BUILDER_MODEL_STORAGE_KEY = 'ghostbuild_builder_model_v2';
/** Namespaced beside the model preference: same owner, same lifetime, same browser-only scope. */
const BUILDER_SEEN_MODELS_STORAGE_KEY = 'ghostbuild_seen_builder_models_v1';
/** One more than the catalog payload's own ceiling, so a full catalog always fits. */
const MAX_SEEN_MODEL_IDS = 101;
let pendingCatalog: Promise<void> | null = null;
/**
 * Until the live catalog arrives, `builderModelsStore` holds only the pinned default, so a
 * membership test would discard every other saved preference — including on the opening turn of a
 * homepage-started build. Before that point a shape-valid saved id is trusted; the server is the
 * authority on which ids are usable and rejects an unknown one.
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

export function initializeBuilderModelPreference(storage?: BuilderModelStorage): void {
  applyStoredModelPreference(storage);
}

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
  builderModelsStore.set(payload.models);
  builderDefaultModelStore.set(payload.defaultModelId);
  catalogInstalled = true;
  applyStoredModelPreference(storage);
  applyUnseenModels(payload.models, storage);
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

/**
 * Newest first, with the pinned default always first regardless of its date: it is the choice
 * Ghostbuild stands behind, and a picker whose first row moves whenever Cloudflare publishes a
 * model is a picker nobody can learn. Undated models keep their catalog order, after the dated
 * ones, because an unknown date is not a claim to be old.
 */
export function orderBuilderModelsForDisplay(
  models: readonly WorkersAiModel[],
  defaultModelId: WorkersAiModelId,
): readonly WorkersAiModel[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      if (left.model.id === defaultModelId || right.model.id === defaultModelId) {
        return left.model.id === defaultModelId ? (right.model.id === defaultModelId ? 0 : -1) : 1;
      }
      const leftTime = modelPublishedTime(left.model);
      const rightTime = modelPublishedTime(right.model);
      return leftTime === rightTime ? left.index - right.index : rightTime - leftTime;
    })
    .map(({ model }) => model);
}

function modelPublishedTime(model: WorkersAiModel): number {
  const parsed = model.createdAt === undefined ? Number.NaN : Date.parse(model.createdAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
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
      isWorkersAiModelId(persisted) && (!catalogInstalled || models.some(({ id }) => id === persisted))
        ? persisted
        : defaultModel,
    );
  } catch {
    builderModelStore.set(defaultModel);
  }
}
