// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
} from '~/lib/workers-ai-model';
import {
  builderDefaultModelStore,
  builderModelCatalogStatusStore,
  builderModelsStore,
  builderModelStore,
  builderNewModelsStore,
  installBuilderModelCatalog,
  loadBuilderModelCatalog,
  loadBuilderModelPreference,
  markBuilderModelsSeen,
  orderBuilderModelsForDisplay,
} from './builder-model.client';

const alternativeModel: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  label: 'DeepSeek V4 Flash 0731',
  contextTokens: 128_000,
  requiresPaid: false,
  vision: false,
};
const catalog: WorkersAiModelCatalogPayload = {
  defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
  models: [DEFAULT_WORKERS_AI_MODEL, alternativeModel],
};

function memoryStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    read: (key: string) => values.get(key) ?? null,
  };
}

const SEEN_KEY = 'cloudchef_seen_builder_models_v1';

describe('builder model preference', () => {
  beforeEach(() => {
    installBuilderModelCatalog(
      { defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] },
      memoryStorage(),
    );
    builderModelCatalogStatusStore.set('idle');
    builderNewModelsStore.set([]);
  });

  it('uses the pinned GLM 5.3 Flash default before discovery', () => {
    loadBuilderModelPreference({ getItem: () => null });

    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    expect(builderDefaultModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    expect(builderModelsStore.get()).toEqual([DEFAULT_WORKERS_AI_MODEL]);
  });

  it('installs the live catalog and restores only a current member', () => {
    installBuilderModelCatalog(catalog, { getItem: () => alternativeModel.id });
    expect(builderModelStore.get()).toBe(alternativeModel.id);

    loadBuilderModelPreference({ getItem: () => '@cf/example/retired' });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('loads and validates the authenticated runtime catalog', async () => {
    const request = vi.fn(async () => Response.json(catalog));

    await loadBuilderModelCatalog(request, { getItem: () => alternativeModel.id });

    expect(request).toHaveBeenCalledWith('/v1/models', { headers: { Accept: 'application/json' } });
    expect(builderModelCatalogStatusStore.get()).toBe('ready');
    expect(builderModelsStore.get()).toEqual(catalog.models);
    expect(builderModelStore.get()).toBe(alternativeModel.id);
  });

  it('keeps the safe fallback when discovery fails', async () => {
    await loadBuilderModelCatalog(async () => new Response(null, { status: 503 }));

    expect(builderModelCatalogStatusStore.get()).toBe('error');
    expect(builderModelsStore.get()).toEqual([DEFAULT_WORKERS_AI_MODEL]);
  });
});

describe('new Workers AI models', () => {
  beforeEach(() => {
    builderNewModelsStore.set([]);
  });

  it('seeds the first ever catalog silently instead of announcing every model', () => {
    const storage = memoryStorage();

    installBuilderModelCatalog(catalog, storage);

    expect(builderNewModelsStore.get()).toEqual([]);
    expect(JSON.parse(storage.read(SEEN_KEY) ?? 'null')).toEqual([DEFAULT_WORKERS_AI_MODEL.id, alternativeModel.id]);
  });

  it('reports only the ids this browser has never seen', () => {
    const storage = memoryStorage({ [SEEN_KEY]: JSON.stringify([DEFAULT_WORKERS_AI_MODEL.id]) });

    installBuilderModelCatalog(catalog, storage);

    expect(builderNewModelsStore.get()).toEqual([alternativeModel]);
    // Diffing alone must not record the sighting: the user has not been shown anything yet.
    expect(JSON.parse(storage.read(SEEN_KEY) ?? 'null')).toEqual([DEFAULT_WORKERS_AI_MODEL.id]);
  });

  it('clears the notice once the models have been seen, and stays clear on the next load', () => {
    const storage = memoryStorage({ [SEEN_KEY]: JSON.stringify([DEFAULT_WORKERS_AI_MODEL.id]) });
    installBuilderModelCatalog(catalog, storage);

    markBuilderModelsSeen(storage);

    expect(builderNewModelsStore.get()).toEqual([]);
    installBuilderModelCatalog(catalog, storage);
    expect(builderNewModelsStore.get()).toEqual([]);
  });

  it('reseeds rather than announcing everything when the stored set is unreadable', () => {
    const storage = memoryStorage({ [SEEN_KEY]: 'not-json' });

    installBuilderModelCatalog(catalog, storage);

    expect(builderNewModelsStore.get()).toEqual([]);
    expect(JSON.parse(storage.read(SEEN_KEY) ?? 'null')).toEqual([DEFAULT_WORKERS_AI_MODEL.id, alternativeModel.id]);
  });

  it('keeps only GLM and DeepSeek Flash even with an older broad catalog and saved Pro preference', () => {
    const pro: WorkersAiModel = { ...alternativeModel, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' };
    const oldCatalog = { defaultModelId: pro.id, models: [pro, alternativeModel, DEFAULT_WORKERS_AI_MODEL] };
    installBuilderModelCatalog(oldCatalog, { getItem: () => pro.id });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    expect(builderModelsStore.get().map(({ id }) => id)).toEqual([alternativeModel.id, CLOUDFLARE_WORKERS_AI_MODEL]);
    expect(orderBuilderModelsForDisplay(oldCatalog.models, CLOUDFLARE_WORKERS_AI_MODEL).map(({ id }) => id)).toEqual([
      CLOUDFLARE_WORKERS_AI_MODEL,
      alternativeModel.id,
    ]);
  });
});
