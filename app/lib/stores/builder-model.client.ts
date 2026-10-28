import { atom } from 'nanostores';
import { z } from 'zod';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isBuilderModelId,
  MAX_BUILDER_CATALOG_MODELS,
  validateBuilderModelCatalogPayload,
  builderModelCatalogPayloadSchema,
  builderReasoningLevelSchema,
  compatibleBuilderModelsPayloadSchema,
  getBuilderModel,
  gatewayModelProvider,
  GATEWAY_PROVIDER_SLUGS,
  type GatewayProviderSlug,
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
/** The provider tab the picker last showed. */
const BUILDER_PROVIDER_STORAGE_KEY = 'cloudchef_builder_provider_v1';
/** The models most recently chosen, newest first, which the picker pins beside the default. */
const BUILDER_RECENTS_STORAGE_KEY = 'cloudchef_builder_recents_v1';
/** How many recently chosen models are kept. */
const MAX_RECENT_MODELS = 2;
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
/** Why the account's catalog was refused, when it said: the admin's allowed models can't run. Null otherwise. */
export const builderModelCatalogRefusalStore = atom<string | null>(null);

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

export function loadBuilderModelPreference(): void {
  applyStoredModelPreference();
  try {
    const tab = localStorage.getItem(BUILDER_PROVIDER_STORAGE_KEY);
    builderProviderStore.set(tab === 'workers' ? tab : (GATEWAY_PROVIDER_SLUGS.find((slug) => slug === tab) ?? null));
    const recents = z
      .array(z.string())
      .safeParse(JSON.parse(localStorage.getItem(BUILDER_RECENTS_STORAGE_KEY) ?? '[]'));
    builderRecentModelsStore.set(
      recents.success ? recents.data.filter(isBuilderModelId).slice(0, MAX_RECENT_MODELS) : [],
    );
  } catch {
    // Browser storage is optional.
  }
  builderReasoningChoicesStore.set(readReasoningChoices());
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

/**
 * The model fields every builder turn's request carries: the model, and the effort chosen for it —
 * no `reasoningLevel` at all for the provider's default, so nothing is sent that could override it.
 */
export function builderModelRequestFields(modelId: BuilderModelId = builderModelStore.get()): {
  modelId: BuilderModelId;
  reasoningLevel?: BuilderReasoningLevel;
} {
  const reasoningLevel = builderReasoningLevelFor(builderModelFor(modelId));
  return reasoningLevel === undefined ? { modelId } : { modelId, reasoningLevel };
}

/** Records the effort chosen for one model; `undefined` returns it to the provider's default. */
export function setBuilderReasoningLevel(modelId: BuilderModelId, level: BuilderReasoningLevel | undefined): void {
  const { [modelId]: _previous, ...others } = builderReasoningChoicesStore.get();
  const next = level === undefined ? others : { ...others, [modelId]: level };
  builderReasoningChoicesStore.set(next);
  try {
    localStorage.setItem(BUILDER_REASONING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The in-memory choice still applies when browser storage is unavailable.
  }
}

/**
 * Loads the account's catalog, joining a request already in flight. After a change to what the
 * account offers (a key linked or unlinked) call `reloadBuilderModelCatalog`, whose request starts
 * after that change rather than being one sent before it.
 */
export function loadBuilderModelCatalog(): Promise<void> {
  return pendingCatalog ?? requestBuilderModelCatalog({});
}

/**
 * Loads the account's catalog with a request of its own. A request still in flight is superseded:
 * whatever it fetches is discarded, and it settles when this one does. The runtime lets the browser
 * keep its catalog for a minute, so this request skips that cache to see the change and replaces the
 * cached catalog with it, so a plain load in the next minute cannot bring the old one back.
 */
export function reloadBuilderModelCatalog(): Promise<void> {
  return requestBuilderModelCatalog({ cache: 'reload' });
}

function requestBuilderModelCatalog(init: RequestInit): Promise<void> {
  const requestNumber = ++catalogRequests;
  const superseded = () => requestNumber !== catalogRequests;
  builderModelCatalogStatusStore.set('loading');
  let answered = false;
  const operation: Promise<void> = fetchUserRuntime('/v1/models', { ...init, headers: { Accept: 'application/json' } })
    .then(async (response) => {
      answered = true;
      const body: unknown = await response.json().catch(() => null);
      const parsed = builderModelCatalogPayloadSchema.safeParse(body);
      const payload = parsed.success ? validateBuilderModelCatalogPayload(parsed.data) : null;
      if (superseded()) {
        return;
      }
      // A refusal that says why (none of the allowed models can run) is kept to show, not only a failure.
      builderModelCatalogRefusalStore.set(
        response.status === 409 ? (z.object({ error: z.string().max(500) }).safeParse(body).data?.error ?? null) : null,
      );
      if (!response.ok || payload === null) {
        throw new Error('The Workers AI model catalog response is invalid.');
      }
      installBuilderModelCatalog(payload);
      builderModelCatalogStatusStore.set('ready');
    })
    .catch(() => {
      if (!superseded()) {
        // A fetch that never answered says nothing about an earlier refusal, which may be fixed by now.
        if (!answered) {
          builderModelCatalogRefusalStore.set(null);
        }
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

/**
 * Installs a catalog `validateBuilderModelCatalogPayload` accepted: its default, the one the account's
 * admin chose while it is still offered, is one of its models.
 */
export function installBuilderModelCatalog(payload: BuilderModelCatalogPayload): void {
  // Before the first catalog of this page, the list held only the built-in default, not anything this account offered.
  const previousModels = catalogInstalled ? builderModelsStore.get() : [];
  builderModelsStore.set(payload.models);
  builderDefaultModelStore.set(payload.defaultModelId);
  catalogInstalled = true;
  applyStoredModelPreference();
  applyUnavailableModelNotice(readSavedModelId(), previousModels);
  applyUnseenModels(payload.models);
}

/**
 * The saved model the catalog no longer offers — its admin no longer allows it, its provider's key was
 * removed, or Cloudflare retired it — which new turns have stopped using for the catalog's default.
 */
type UnavailableBuilderModel = { label: string; replacementLabel: string };

export const builderModelUnavailableStore = atom<UnavailableBuilderModel | null>(null);

/**
 * Says so when the saved model is one the catalog stopped offering while this page was open (a refused turn
 * or Settings reloads the list), so that switch to the default is not silent. Its name comes from the list
 * this page had before, where it was still offered. On a fresh page there is no earlier list of this
 * account's to compare with, so nothing is said.
 */
function applyUnavailableModelNotice(saved: string | null, previousModels: readonly BuilderModel[]): void {
  const models = builderModelsStore.get();
  // Said only when this account's own list offered the saved model and no longer does. The saved model is the
  // browser's, so one picked in Personal is simply not offered in a team, which is no change worth saying.
  const previous = previousModels.find(({ id }) => id === saved);
  if (!isBuilderModelId(saved) || models.some(({ id }) => id === saved) || !previous) {
    builderModelUnavailableStore.set(null);
    return;
  }
  const replacement = models.find(({ id }) => id === builderModelStore.get());
  builderModelUnavailableStore.set({
    label: previous.label,
    replacementLabel: replacement?.label ?? builderModelStore.get(),
  });
}

/** The person has read the notice: the model now in use becomes the saved one, so it is not said again. */
export function dismissUnavailableBuilderModel(): void {
  builderModelUnavailableStore.set(null);
  setBuilderModel(builderModelStore.get());
}

function readSavedModelId(): string | null {
  try {
    return localStorage.getItem(BUILDER_MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Every model the account could offer, whatever its admin allows, for Settings to show what there is to
 * allow. Asked fresh each time, since it follows a key just linked.
 */
export async function fetchCompatibleBuilderModels(): Promise<BuilderModel[]> {
  const response = await fetchUserRuntime('/v1/models/compatible', {
    cache: 'reload',
    headers: { Accept: 'application/json' },
  });
  const parsed = compatibleBuilderModelsPayloadSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) {
    throw new Error('The account’s models could not be listed just now.');
  }
  return parsed.data.models;
}

/**
 * The user has now been shown what is new — because the picker opened, or because the notice was
 * dismissed — so the current catalog becomes the baseline the next load is compared against.
 */
export function markBuilderModelsSeen(): void {
  if (builderNewModelsStore.get().length === 0) {
    return;
  }
  builderNewModelsStore.set([]);
  // Added to what was seen before, not in its place: models an admin leaves out for now were still seen.
  writeSeenModelIds([...new Set([...builderModelsStore.get().map(({ id }) => id), ...(readSeenModelIds() ?? [])])]);
}

/** Keep the default first. */
export function orderBuilderModelsForDisplay(
  models: readonly BuilderModel[],
  defaultModelId: BuilderModelId,
): readonly BuilderModel[] {
  return [...models].sort((left, right) => Number(right.id === defaultModelId) - Number(left.id === defaultModelId));
}

export function setBuilderModel(modelId: BuilderModelId): void {
  if (!builderModelsStore.get().some(({ id }) => id === modelId)) {
    return;
  }
  if (modelId !== builderDefaultModelStore.get()) {
    builderRecentModelsStore.set(
      [
        modelId,
        ...builderRecentModelsStore.get().filter((id) => id !== modelId && id !== builderDefaultModelStore.get()),
      ].slice(0, MAX_RECENT_MODELS),
    );
  }
  builderModelStore.set(modelId);
  builderModelUnavailableStore.set(null);
  try {
    localStorage.setItem(BUILDER_MODEL_STORAGE_KEY, modelId);
    localStorage.setItem(BUILDER_RECENTS_STORAGE_KEY, JSON.stringify(builderRecentModelsStore.get()));
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
  // The same trust as a saved preference on load.
  builderModelStore.set(savedModelOrDefault(event.newValue));
}

/**
 * A saved model id while it may be used (before the catalog arrives any well-formed id, see
 * `catalogInstalled`; after it, one the catalog offers), and the catalog's default otherwise.
 */
function savedModelOrDefault(saved: string | null): BuilderModelId {
  return isBuilderModelId(saved) && (!catalogInstalled || builderModelsStore.get().some(({ id }) => id === saved))
    ? saved
    : builderDefaultModelStore.get();
}

function readReasoningChoices(): BuilderReasoningChoices {
  try {
    return parseReasoningChoices(localStorage.getItem(BUILDER_REASONING_STORAGE_KEY));
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

function applyUnseenModels(models: readonly BuilderModel[]): void {
  const seen = readSeenModelIds();
  if (seen === null) {
    // Nothing recorded yet: this browser has no "before", so today's catalog is the baseline.
    builderNewModelsStore.set([]);
    writeSeenModelIds(models.map(({ id }) => id));
    return;
  }
  builderNewModelsStore.set(models.filter(({ id }) => !seen.has(id)));
}

function readSeenModelIds(): Set<string> | null {
  try {
    const persisted = localStorage.getItem(BUILDER_SEEN_MODELS_STORAGE_KEY);
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

function writeSeenModelIds(modelIds: readonly string[]): void {
  try {
    localStorage.setItem(BUILDER_SEEN_MODELS_STORAGE_KEY, JSON.stringify(modelIds.slice(0, MAX_SEEN_MODEL_IDS)));
  } catch {
    // Nothing is recorded when browser storage is unavailable; the next load simply reseeds.
  }
}

function applyStoredModelPreference(): void {
  try {
    builderModelStore.set(savedModelOrDefault(localStorage.getItem(BUILDER_MODEL_STORAGE_KEY)));
  } catch {
    builderModelStore.set(builderDefaultModelStore.get());
  }
}

export type BuilderProvider = GatewayProviderSlug | 'workers';
export const builderProviderStore = atom<BuilderProvider | null>(null);
export const builderRecentModelsStore = atom<readonly BuilderModelId[]>([]);

export function setBuilderProvider(provider: BuilderProvider): void {
  builderProviderStore.set(provider);
  try {
    localStorage.setItem(BUILDER_PROVIDER_STORAGE_KEY, provider);
  } catch {
    // The tab still changes when storage is unavailable.
  }
}

export function builderProviderFor(model: BuilderModel): BuilderProvider {
  return gatewayModelProvider(model.id) ?? 'workers';
}
