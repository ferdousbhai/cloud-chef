// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  type BuilderModel,
  type BuilderModelCatalogPayload,
} from '~/lib/workers-ai-model';
import {
  builderModelCatalogStatusStore,
  builderProviderStore,
  builderRecentModelsStore,
  setBuilderProvider,
  olderBuilderModelIds,
  orderBuilderProviders,
  builderModelsStore,
  builderModelStore,
  builderModelRequestFields,
  builderNewModelsStore,
  builderReasoningChoicesStore,
  builderReasoningLevelFor,
  installBuilderModelCatalog,
  loadBuilderModelCatalog,
  loadBuilderModelPreference,
  markBuilderModelsSeen,
  orderBuilderModelsForDisplay,
  reloadBuilderModelCatalog,
  setBuilderModel,
  setBuilderReasoningLevel,
  syncBuilderModelPreference,
} from './builder-model.client';

const alternativeModel: BuilderModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  label: 'DeepSeek V4 Flash 0731',
  contextTokens: 128_000,
  requiresPaid: false,
  vision: false,
};
const claudeModel: BuilderModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: 'anthropic/claude-opus-5-5',
  label: 'Claude Opus 5.5',
  contextTokens: 1_000_000,
  requiresPaid: false,
};
const catalog: BuilderModelCatalogPayload = {
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

  it('installs the live catalog and restores only a current member', () => {
    installBuilderModelCatalog(catalog, { getItem: () => alternativeModel.id });
    expect(builderModelStore.get()).toBe(alternativeModel.id);

    loadBuilderModelPreference({ getItem: () => '@cf/example/retired' });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it("starts on the default the account's catalog names, and a saved model no longer offered falls back to it", () => {
    const teamCatalog = { defaultModelId: claudeModel.id, models: [claudeModel, DEFAULT_WORKERS_AI_MODEL] };

    installBuilderModelCatalog(teamCatalog, { getItem: () => null });
    expect(builderModelStore.get()).toBe(claudeModel.id);

    // Anyone can switch away from the team's default.
    installBuilderModelCatalog(teamCatalog, { getItem: () => CLOUDFLARE_WORKERS_AI_MODEL });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);

    // Claude was unlinked since: the saved Claude choice is not offered, so the catalog's default applies.
    installBuilderModelCatalog(catalog, { getItem: () => claudeModel.id });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    syncBuilderModelPreference({ key: 'cloudchef_builder_model_v2', newValue: claudeModel.id });
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
    // Fresh modules, so no catalog has been installed yet.
    vi.resetModules();
    const fresh = await import('./builder-model.client');

    await fresh.loadBuilderModelCatalog(async () => new Response(null, { status: 503 }));

    expect(fresh.builderModelCatalogStatusStore.get()).toBe('error');
    expect(fresh.builderModelsStore.get()).toEqual([DEFAULT_WORKERS_AI_MODEL]);
  });

  it('keeps the installed catalog, and says it is stale, when a refresh fails', async () => {
    await loadBuilderModelCatalog(async () => Response.json(catalog), memoryStorage());

    await loadBuilderModelCatalog(async () => new Response(null, { status: 503 }));

    expect(builderModelCatalogStatusStore.get()).toBe('stale');
    expect(builderModelsStore.get()).toEqual(catalog.models);
  });

  it('joins a request in flight, and a reload supersedes it with one of its own', async () => {
    const responses: ((response: Response) => void)[] = [];
    const request = vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve)));
    const storage = memoryStorage();

    const beforeChange = loadBuilderModelCatalog(request, storage);
    expect(loadBuilderModelCatalog(request, storage)).toBe(beforeChange);
    const afterChange = reloadBuilderModelCatalog(request, storage);
    expect(request).toHaveBeenCalledTimes(2);
    // Only the reload skips the browser's cached catalog, replacing it; a plain load may use it.
    expect(request).toHaveBeenNthCalledWith(1, '/v1/models', { headers: { Accept: 'application/json' } });
    expect(request).toHaveBeenNthCalledWith(2, '/v1/models', {
      cache: 'reload',
      headers: { Accept: 'application/json' },
    });
    let beforeChangeSettled = false;
    void beforeChange.then(() => {
      beforeChangeSettled = true;
    });

    // The request sent before the change answers last, with the catalog as it was.
    responses[1]?.(Response.json({ defaultModelId: claudeModel.id, models: [claudeModel, DEFAULT_WORKERS_AI_MODEL] }));
    await afterChange;
    responses[0]?.(Response.json(catalog));
    await beforeChange;

    expect(beforeChangeSettled).toBe(true);
    expect(builderModelsStore.get()).toEqual([claudeModel, DEFAULT_WORKERS_AI_MODEL]);
    expect(builderModelCatalogStatusStore.get()).toBe('ready');
  });

  it('settles a superseded request only once the reload that superseded it has', async () => {
    const responses: ((response: Response) => void)[] = [];
    const request = vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve)));

    const beforeChange = loadBuilderModelCatalog(request, memoryStorage());
    const afterChange = reloadBuilderModelCatalog(request, memoryStorage());
    let beforeChangeSettled = false;
    void beforeChange.then(() => {
      beforeChangeSettled = true;
    });
    responses[0]?.(Response.json(catalog));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(beforeChangeSettled).toBe(false);
    expect(builderModelsStore.get()).toEqual([DEFAULT_WORKERS_AI_MODEL]);

    responses[1]?.(Response.json(catalog));
    await afterChange;
    await beforeChange;
    expect(builderModelsStore.get()).toEqual(catalog.models);
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

  it('offers every model the catalog lists, with the default first', () => {
    const pro: BuilderModel = { ...alternativeModel, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' };
    const broadCatalog = { defaultModelId: pro.id, models: [alternativeModel, claudeModel, pro] };
    installBuilderModelCatalog(broadCatalog, { getItem: () => null });
    expect(builderModelStore.get()).toBe(pro.id);
    expect(builderModelsStore.get().map(({ id }) => id)).toEqual([alternativeModel.id, claudeModel.id, pro.id]);
    expect(orderBuilderModelsForDisplay(broadCatalog.models, pro.id).map(({ id }) => id)).toEqual([
      pro.id,
      alternativeModel.id,
      claudeModel.id,
    ]);
  });
});

describe('a Claude preference saved under its old bare id', () => {
  it('restores the same model under its anthropic/ id', () => {
    const storage = memoryStorage({ cloudchef_builder_model_v2: 'claude-opus-5-5' });
    installBuilderModelCatalog({ ...catalog, models: [...catalog.models, claudeModel] }, storage);
    expect(builderModelStore.get()).toBe('anthropic/claude-opus-5-5');

    syncBuilderModelPreference({ key: 'cloudchef_builder_model_v2', newValue: 'claude-opus-5-5' });
    expect(builderModelStore.get()).toBe('anthropic/claude-opus-5-5');
  });
});

describe('a saved model before the live catalog arrives', () => {
  it('runs at its saved effort, and stands in as itself rather than the default model', async () => {
    // A fresh module, so no catalog has been installed yet.
    vi.resetModules();
    const fresh = await import('./builder-model.client');
    const storage = memoryStorage({
      cloudchef_builder_model_v2: claudeModel.id,
      cloudchef_builder_reasoning_v1: JSON.stringify({ [claudeModel.id]: 'max' }),
    });
    fresh.loadBuilderModelPreference(storage);

    expect(fresh.builderModelStore.get()).toBe(claudeModel.id);
    expect(fresh.builderModelRequestFields()).toEqual({ modelId: claudeModel.id, reasoningLevel: 'max' });
    expect(fresh.builderModelFor(claudeModel.id)).toMatchObject({ id: claudeModel.id, label: claudeModel.id });

    // Once the catalog describes the model, it decides which efforts still apply.
    const opus = { ...claudeModel, reasoningLevels: ['low', 'high'] } satisfies BuilderModel;
    fresh.installBuilderModelCatalog({ ...catalog, models: [...catalog.models, opus] }, storage);
    expect(fresh.builderModelFor(claudeModel.id)).toEqual(opus);
    expect(fresh.builderModelRequestFields()).toEqual({ modelId: claudeModel.id });
  });
});

describe('a model chosen in another tab before the live catalog arrives', () => {
  it('is adopted as a saved preference would be, then checked once the catalog arrives', async () => {
    // A fresh module, so no catalog has been installed yet.
    vi.resetModules();
    const fresh = await import('./builder-model.client');

    fresh.syncBuilderModelPreference({ key: 'cloudchef_builder_model_v2', newValue: claudeModel.id });
    expect(fresh.builderModelStore.get()).toBe(claudeModel.id);

    fresh.installBuilderModelCatalog(catalog, memoryStorage({ cloudchef_builder_model_v2: claudeModel.id }));
    expect(fresh.builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });
});

describe('the reasoning effort chosen per model', () => {
  const REASONING_KEY = 'cloudchef_builder_reasoning_v1';
  const opus: BuilderModel = { ...claudeModel, reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] };
  const gpt: BuilderModel = {
    ...claudeModel,
    id: 'openai/gpt-5',
    label: 'GPT-5',
    reasoningLevels: ['minimal', 'low', 'medium', 'high'],
  };

  beforeEach(() => {
    installBuilderModelCatalog({ ...catalog, models: [...catalog.models, opus, gpt] }, memoryStorage());
    loadBuilderModelPreference(memoryStorage());
  });

  it('starts at the provider default, and persists a choice for that model alone', () => {
    const storage = memoryStorage();
    expect(builderModelRequestFields(opus.id).reasoningLevel).toBeUndefined();

    setBuilderReasoningLevel(opus.id, 'xhigh', storage);

    expect(builderModelRequestFields(opus.id).reasoningLevel).toBe('xhigh');
    expect(builderModelRequestFields(gpt.id).reasoningLevel).toBeUndefined();
    expect(JSON.parse(storage.read(REASONING_KEY) ?? 'null')).toEqual({ [opus.id]: 'xhigh' });

    loadBuilderModelPreference(storage);
    expect(builderReasoningChoicesStore.get()).toEqual({ [opus.id]: 'xhigh' });

    setBuilderReasoningLevel(opus.id, undefined, storage);
    expect(builderModelRequestFields(opus.id).reasoningLevel).toBeUndefined();
    expect(JSON.parse(storage.read(REASONING_KEY) ?? 'null')).toEqual({});
  });

  it("carries the chosen effort in a turn's request, and no effort field at all for the default", () => {
    expect(builderModelRequestFields(opus.id)).toEqual({ modelId: opus.id });
    setBuilderReasoningLevel(opus.id, 'high', memoryStorage());
    expect(builderModelRequestFields(opus.id)).toEqual({ modelId: opus.id, reasoningLevel: 'high' });
    expect(builderModelRequestFields(gpt.id)).toEqual({ modelId: gpt.id });
  });

  it('falls back to the provider default when the model no longer offers the saved effort', () => {
    expect(builderReasoningLevelFor(gpt, { [gpt.id]: 'xhigh' })).toBeUndefined();
    expect(builderReasoningLevelFor({ ...opus, reasoningLevels: undefined }, { [opus.id]: 'high' })).toBeUndefined();
    expect(builderReasoningLevelFor(gpt, { [gpt.id]: 'minimal' })).toBe('minimal');
  });

  it('keeps each model its own effort across a switch', () => {
    const storage = memoryStorage();
    setBuilderModel(opus.id, storage);
    setBuilderReasoningLevel(opus.id, 'max', storage);
    setBuilderModel(gpt.id, storage);
    expect(builderModelRequestFields(builderModelStore.get()).reasoningLevel).toBeUndefined();
    setBuilderModel(opus.id, storage);
    expect(builderModelRequestFields(builderModelStore.get()).reasoningLevel).toBe('max');
  });

  it('skips unreadable entries one by one, and never reads off', () => {
    loadBuilderModelPreference(
      memoryStorage({
        [REASONING_KEY]: JSON.stringify({ [opus.id]: 'high', [gpt.id]: 'off', 'not a model': 'low', x: 3 }),
      }),
    );
    expect(builderReasoningChoicesStore.get()).toEqual({ [opus.id]: 'high' });

    loadBuilderModelPreference(memoryStorage({ [REASONING_KEY]: '{not json' }));
    expect(builderReasoningChoicesStore.get()).toEqual({});

    syncBuilderModelPreference({ key: REASONING_KEY, newValue: JSON.stringify({ [gpt.id]: 'low' }) });
    expect(builderReasoningChoicesStore.get()).toEqual({ [gpt.id]: 'low' });
  });
});

describe('provider picker preferences', () => {
  it('orders the default provider before keyed providers, Workers AI, and keyless providers', () => {
    const openai: BuilderModel = { ...claudeModel, id: 'openai/gpt-5', label: 'GPT 5' };
    expect(orderBuilderProviders([DEFAULT_WORKERS_AI_MODEL, claudeModel, openai], claudeModel)).toEqual([
      'anthropic',
      'openai',
      'workers',
      'grok',
      'openrouter',
    ]);
  });

  it('compares generations within families including names whose version moved', () => {
    const old: BuilderModel = { ...claudeModel, id: 'anthropic/claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const current: BuilderModel = { ...claudeModel, id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' };
    const undated: BuilderModel = { ...claudeModel, id: 'anthropic/experimental', label: 'Experimental' };
    expect([...olderBuilderModelIds([old, current, undated, claudeModel])]).toEqual([old.id]);
  });

  it('discards an invalid stored provider and restores Workers AI', () => {
    loadBuilderModelPreference({ getItem: () => 'invalid', setItem: () => undefined });
    expect(builderProviderStore.get()).toBeNull();
    loadBuilderModelPreference({
      getItem: (key) => (key === 'cloudchef_builder_provider_v1' ? 'workers' : null),
      setItem: () => undefined,
    });
    expect(builderProviderStore.get()).toBe('workers');
  });

  it('remembers the tab and deduplicates recent selections in this browser', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    installBuilderModelCatalog({ ...catalog, models: [...catalog.models, claudeModel] });
    setBuilderProvider('anthropic');
    setBuilderModel(claudeModel.id);
    setBuilderModel(alternativeModel.id);
    setBuilderModel(claudeModel.id);
    builderProviderStore.set(null);
    builderRecentModelsStore.set([]);
    loadBuilderModelPreference();
    expect(builderProviderStore.get()).toBe('anthropic');
    expect(builderRecentModelsStore.get()).toEqual([claudeModel.id, alternativeModel.id]);
  });
});
