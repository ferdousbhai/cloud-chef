// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  type BuilderModel,
  type BuilderModelCatalogPayload,
  olderBuilderModelIds,
} from '~/lib/workers-ai-model';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import {
  builderModelCatalogStatusStore,
  builderProviderStore,
  builderRecentModelsStore,
  setBuilderProvider,
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

const MODEL_KEY = 'cloudchef_builder_model_v2';
const SEEN_KEY = 'cloudchef_seen_builder_models_v1';
const RUNTIME_ENDPOINT = 'https://workspace.example';

type CatalogRequest = { url: string; init: RequestInit };

/** Grants a runtime session, and answers each catalog request with what `answer` returns, recording it. */
function serveCatalog(answer: () => Promise<Response>): CatalogRequest[] {
  const requests: CatalogRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === '/api/cloudflare/runtime-session') {
        return Response.json({ endpoint: RUNTIME_ENDPOINT, token: 'token', expiresAt: Date.now() + 60_000 });
      }
      requests.push({ url: String(input), init });
      return answer();
    }),
  );
  return requests;
}

/** What a catalog request asked of the browser's cache, and the answer it accepts. */
function requestedCatalog({ url, init }: CatalogRequest) {
  return { url, cache: init.cache, accept: new Headers(init.headers).get('Accept') };
}

beforeEach(() => {
  // This browser's storage, empty for each test.
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  resetUserRuntimeSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('builder model preference', () => {
  beforeEach(() => {
    installBuilderModelCatalog({ defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] });
    builderModelCatalogStatusStore.set('idle');
    builderNewModelsStore.set([]);
  });

  it('installs the live catalog and restores only a current member', () => {
    localStorage.setItem(MODEL_KEY, alternativeModel.id);
    installBuilderModelCatalog(catalog);
    expect(builderModelStore.get()).toBe(alternativeModel.id);

    localStorage.setItem(MODEL_KEY, '@cf/example/retired');
    loadBuilderModelPreference();
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it("starts on the default the account's catalog names, and a saved model no longer offered falls back to it", () => {
    const teamCatalog = { defaultModelId: claudeModel.id, models: [claudeModel, DEFAULT_WORKERS_AI_MODEL] };

    installBuilderModelCatalog(teamCatalog);
    expect(builderModelStore.get()).toBe(claudeModel.id);

    // Anyone can switch away from the team's default.
    localStorage.setItem(MODEL_KEY, CLOUDFLARE_WORKERS_AI_MODEL);
    installBuilderModelCatalog(teamCatalog);
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);

    // Claude was unlinked since: the saved Claude choice is not offered, so the catalog's default applies.
    localStorage.setItem(MODEL_KEY, claudeModel.id);
    installBuilderModelCatalog(catalog);
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    syncBuilderModelPreference({ key: MODEL_KEY, newValue: claudeModel.id });
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('loads and validates the authenticated runtime catalog', async () => {
    localStorage.setItem(MODEL_KEY, alternativeModel.id);
    const requests = serveCatalog(async () => Response.json(catalog));

    await loadBuilderModelCatalog();

    expect(requests.map(requestedCatalog)).toEqual([
      { url: `${RUNTIME_ENDPOINT}/v1/models`, cache: undefined, accept: 'application/json' },
    ]);
    expect(builderModelCatalogStatusStore.get()).toBe('ready');
    expect(builderModelsStore.get()).toEqual(catalog.models);
    expect(builderModelStore.get()).toBe(alternativeModel.id);
  });

  it('keeps the safe fallback when discovery fails', async () => {
    // Fresh modules, so no catalog has been installed yet.
    vi.resetModules();
    const fresh = await import('./builder-model.client');
    serveCatalog(async () => new Response(null, { status: 503 }));

    await fresh.loadBuilderModelCatalog();

    expect(fresh.builderModelCatalogStatusStore.get()).toBe('error');
    expect(fresh.builderModelsStore.get()).toEqual([DEFAULT_WORKERS_AI_MODEL]);
  });

  it('keeps the installed catalog, and says it is stale, when a refresh fails', async () => {
    serveCatalog(async () => Response.json(catalog));
    await loadBuilderModelCatalog();

    serveCatalog(async () => new Response(null, { status: 503 }));
    await loadBuilderModelCatalog();

    expect(builderModelCatalogStatusStore.get()).toBe('stale');
    expect(builderModelsStore.get()).toEqual(catalog.models);
  });

  it('joins a request in flight, and a reload supersedes it with one of its own', async () => {
    const responses: ((response: Response) => void)[] = [];
    const requests = serveCatalog(() => new Promise<Response>((resolve) => responses.push(resolve)));

    const beforeChange = loadBuilderModelCatalog();
    expect(loadBuilderModelCatalog()).toBe(beforeChange);
    const afterChange = reloadBuilderModelCatalog();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    // Only the reload skips the browser's cached catalog, replacing it; a plain load may use it.
    expect(requests.map(requestedCatalog)).toEqual([
      { url: `${RUNTIME_ENDPOINT}/v1/models`, cache: undefined, accept: 'application/json' },
      { url: `${RUNTIME_ENDPOINT}/v1/models`, cache: 'reload', accept: 'application/json' },
    ]);
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
    const requests = serveCatalog(() => new Promise<Response>((resolve) => responses.push(resolve)));

    const beforeChange = loadBuilderModelCatalog();
    const afterChange = reloadBuilderModelCatalog();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
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
    installBuilderModelCatalog(catalog);

    expect(builderNewModelsStore.get()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null')).toEqual([
      DEFAULT_WORKERS_AI_MODEL.id,
      alternativeModel.id,
    ]);
  });

  it('reports only the ids this browser has never seen', () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify([DEFAULT_WORKERS_AI_MODEL.id]));

    installBuilderModelCatalog(catalog);

    expect(builderNewModelsStore.get()).toEqual([alternativeModel]);
    // Diffing alone must not record the sighting: the user has not been shown anything yet.
    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null')).toEqual([DEFAULT_WORKERS_AI_MODEL.id]);
  });

  it('clears the notice once the models have been seen, and stays clear on the next load', () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify([DEFAULT_WORKERS_AI_MODEL.id]));
    installBuilderModelCatalog(catalog);

    markBuilderModelsSeen();

    expect(builderNewModelsStore.get()).toEqual([]);
    installBuilderModelCatalog(catalog);
    expect(builderNewModelsStore.get()).toEqual([]);
  });

  it('reseeds rather than announcing everything when the stored set is unreadable', () => {
    localStorage.setItem(SEEN_KEY, 'not-json');

    installBuilderModelCatalog(catalog);

    expect(builderNewModelsStore.get()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null')).toEqual([
      DEFAULT_WORKERS_AI_MODEL.id,
      alternativeModel.id,
    ]);
  });

  it('offers every model the catalog lists, with the default first', () => {
    const pro: BuilderModel = { ...alternativeModel, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' };
    const broadCatalog = { defaultModelId: pro.id, models: [alternativeModel, claudeModel, pro] };
    installBuilderModelCatalog(broadCatalog);
    expect(builderModelStore.get()).toBe(pro.id);
    expect(builderModelsStore.get().map(({ id }) => id)).toEqual([alternativeModel.id, claudeModel.id, pro.id]);
    expect(orderBuilderModelsForDisplay(broadCatalog.models, pro.id).map(({ id }) => id)).toEqual([
      pro.id,
      alternativeModel.id,
      claudeModel.id,
    ]);
  });
});

describe('a saved model before the live catalog arrives', () => {
  it('runs at its saved effort, and stands in as itself rather than the default model', async () => {
    // A fresh module, so no catalog has been installed yet.
    vi.resetModules();
    const fresh = await import('./builder-model.client');
    localStorage.setItem(MODEL_KEY, claudeModel.id);
    localStorage.setItem('cloudchef_builder_reasoning_v1', JSON.stringify({ [claudeModel.id]: 'max' }));
    fresh.loadBuilderModelPreference();

    expect(fresh.builderModelStore.get()).toBe(claudeModel.id);
    expect(fresh.builderModelRequestFields()).toEqual({ modelId: claudeModel.id, reasoningLevel: 'max' });
    expect(fresh.builderModelFor(claudeModel.id)).toMatchObject({ id: claudeModel.id, label: claudeModel.id });

    // Once the catalog describes the model, it decides which efforts still apply.
    const opus = { ...claudeModel, reasoningLevels: ['low', 'high'] } satisfies BuilderModel;
    fresh.installBuilderModelCatalog({ ...catalog, models: [...catalog.models, opus] });
    expect(fresh.builderModelFor(claudeModel.id)).toEqual(opus);
    expect(fresh.builderModelRequestFields()).toEqual({ modelId: claudeModel.id });
  });
});

describe('a model chosen in another tab before the live catalog arrives', () => {
  it('is adopted as a saved preference would be, then checked once the catalog arrives', async () => {
    // A fresh module, so no catalog has been installed yet.
    vi.resetModules();
    const fresh = await import('./builder-model.client');

    fresh.syncBuilderModelPreference({ key: MODEL_KEY, newValue: claudeModel.id });
    expect(fresh.builderModelStore.get()).toBe(claudeModel.id);

    localStorage.setItem(MODEL_KEY, claudeModel.id);
    fresh.installBuilderModelCatalog(catalog);
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
    installBuilderModelCatalog({ ...catalog, models: [...catalog.models, opus, gpt] });
    loadBuilderModelPreference();
  });

  it('starts at the provider default, and persists a choice for that model alone', () => {
    expect(builderModelRequestFields(opus.id).reasoningLevel).toBeUndefined();

    setBuilderReasoningLevel(opus.id, 'xhigh');

    expect(builderModelRequestFields(opus.id).reasoningLevel).toBe('xhigh');
    expect(builderModelRequestFields(gpt.id).reasoningLevel).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(REASONING_KEY) ?? 'null')).toEqual({ [opus.id]: 'xhigh' });

    builderReasoningChoicesStore.set({});
    loadBuilderModelPreference();
    expect(builderReasoningChoicesStore.get()).toEqual({ [opus.id]: 'xhigh' });

    setBuilderReasoningLevel(opus.id, undefined);
    expect(builderModelRequestFields(opus.id).reasoningLevel).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(REASONING_KEY) ?? 'null')).toEqual({});
  });

  it("carries the chosen effort in a turn's request, and no effort field at all for the default", () => {
    expect(builderModelRequestFields(opus.id)).toEqual({ modelId: opus.id });
    setBuilderReasoningLevel(opus.id, 'high');
    expect(builderModelRequestFields(opus.id)).toEqual({ modelId: opus.id, reasoningLevel: 'high' });
    expect(builderModelRequestFields(gpt.id)).toEqual({ modelId: gpt.id });
  });

  it('falls back to the provider default when the model no longer offers the saved effort', () => {
    expect(builderReasoningLevelFor(gpt, { [gpt.id]: 'xhigh' })).toBeUndefined();
    expect(builderReasoningLevelFor({ ...opus, reasoningLevels: undefined }, { [opus.id]: 'high' })).toBeUndefined();
    expect(builderReasoningLevelFor(gpt, { [gpt.id]: 'minimal' })).toBe('minimal');
  });

  it('keeps each model its own effort across a switch', () => {
    setBuilderModel(opus.id);
    setBuilderReasoningLevel(opus.id, 'max');
    setBuilderModel(gpt.id);
    expect(builderModelRequestFields(builderModelStore.get()).reasoningLevel).toBeUndefined();
    setBuilderModel(opus.id);
    expect(builderModelRequestFields(builderModelStore.get()).reasoningLevel).toBe('max');
  });

  it('skips unreadable entries one by one, and never reads off', () => {
    localStorage.setItem(
      REASONING_KEY,
      JSON.stringify({ [opus.id]: 'high', [gpt.id]: 'off', 'not a model': 'low', x: 3 }),
    );
    loadBuilderModelPreference();
    expect(builderReasoningChoicesStore.get()).toEqual({ [opus.id]: 'high' });

    localStorage.setItem(REASONING_KEY, '{not json');
    loadBuilderModelPreference();
    expect(builderReasoningChoicesStore.get()).toEqual({});

    syncBuilderModelPreference({ key: REASONING_KEY, newValue: JSON.stringify({ [gpt.id]: 'low' }) });
    expect(builderReasoningChoicesStore.get()).toEqual({ [gpt.id]: 'low' });
  });
});

describe('provider picker preferences', () => {
  it('compares generations within families including names whose version moved', () => {
    const old: BuilderModel = { ...claudeModel, id: 'anthropic/claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const current: BuilderModel = { ...claudeModel, id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' };
    const undated: BuilderModel = { ...claudeModel, id: 'anthropic/experimental', label: 'Experimental' };
    expect([...olderBuilderModelIds([old, current, undated, claudeModel])]).toEqual([old.id]);
  });

  it('keeps the one the catalog added last when two labels read the same, and dates nothing it does not know', () => {
    const earlier: BuilderModel = {
      ...DEFAULT_WORKERS_AI_MODEL,
      id: '@cf/example/coder',
      label: 'Coder 2',
      createdAt: '2026-05-01T00:00:00.000Z',
    };
    const later: BuilderModel = {
      ...earlier,
      id: '@cf/example/coder-v2',
      label: 'Coder-2',
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const undated: BuilderModel = { ...earlier, id: '@cf/example/coder-2', label: 'coder 2', createdAt: undefined };
    expect([...olderBuilderModelIds([earlier, later, undated])]).toEqual([earlier.id]);
  });

  it("keeps only the newest of each family in Pi's labels, by generation and then snapshot", () => {
    // Labels as Pi's catalogs and the Workers AI catalog write them; `true` marks the ones superseded.
    const labels: readonly [BuilderModel['id'], string, boolean][] = [
      ['anthropic/claude-opus-4-7', 'Claude Opus 4.7', true],
      ['anthropic/claude-opus-5', 'Claude Opus 5', true],
      ['anthropic/claude-opus-5-5', 'Claude Opus 5.5', false],
      ['anthropic/claude-haiku-4-5', 'Claude Haiku 4.5', true],
      ['anthropic/claude-haiku-5-5', 'Claude Haiku 5.5', false],
      ['openai/gpt-5.4', 'GPT-5.4', true],
      ['openai/gpt-5.5', 'GPT-5.5', false],
      ['openai/gpt-5-mini', 'GPT-5 Mini', true],
      ['openai/gpt-5.4-mini', 'GPT-5.4 mini', false],
      ['openai/gpt-5.5-pro', 'GPT-5.5 Pro', false],
      ['openai/gpt-6-sol', 'GPT-6 Sol', true],
      ['openai/gpt-6.1-sol', 'GPT-6.1 Sol', false],
      ['openai/gpt-6-luna', 'GPT-6 Luna', false],
      ['openai/o3-mini', 'o3-mini', true],
      ['openai/o4-mini', 'o4-mini', false],
      ['openai/o3', 'o3', false],
      ['openrouter/x-ai/grok-4.20', 'SpaceXAI: Grok 4.20', true],
      ['openrouter/x-ai/grok-4.7', 'SpaceXAI: Grok 4.7', false],
      ['openrouter/openai/gpt-4o', 'OpenAI: GPT-4o', false],
      ['openrouter/openai/gpt-4o-2024-11-20', 'OpenAI: GPT-4o (2024-11-20)', true],
      ['openrouter/deepseek/deepseek-v4-pro', 'DeepSeek: DeepSeek V4 Pro 0423', true],
      ['openrouter/deepseek/deepseek-v4-pro-0813', 'DeepSeek: DeepSeek V4 Pro 0813', false],
      ['openrouter/cohere/command-r-08-2024', 'Cohere: Command R (08-2024)', false],
      ['openrouter/qwen/qwen3.5-27b', 'Qwen: Qwen3.5-27B', true],
      ['openrouter/qwen/qwen3.8-27b', 'Qwen: Qwen3.8 27B', false],
      ['openrouter/qwen/qwen3.6-35b-a3b', 'Qwen: Qwen3.6 35B A3B', false],
      ['openrouter/google/gemma-3-27b-it', 'Google: Gemma 3 27B', false],
      ['openrouter/google/gemma-4-31b-it', 'Google: Gemma 4 31B', false],
      ['openrouter/mistralai/mistral-large', 'Mistral Large', false],
      ['openrouter/mistralai/mistral-large-2407', 'Mistral Large 2407', true],
      ['openrouter/mistralai/mistral-large-2512', 'Mistral: Mistral Large 3 2512', true],
      ['openrouter/mistralai/mistral-large-4-0', 'Mistral: Mistral Large 4', false],
      ['openrouter/mistralai/mixtral-8x22b-instruct', 'Mistral: Mixtral 8x22B Instruct', false],
      ['openrouter/upstage/solar-pro-3', 'Upstage: Solar Pro 3', true],
      ['openrouter/upstage/solar-pro4', 'Upstage: Solar Pro 4', false],
      ['@cf/zai-org/glm-5.2', 'GLM 5.2', true],
      ['@cf/zai-org/glm-5.3', 'GLM 5.3', false],
      ['@cf/zai-org/glm-4.7-flash', 'GLM 4.7 Flash', true],
      ['@cf/zai-org/glm-5.3-flash', 'GLM 5.3 Flash', false],
      ['@cf/moonshotai/kimi-k2.6', 'Kimi K2.6', false],
      ['@cf/moonshotai/kimi-k2.7-code', 'Kimi K2.7 Code', false],
      ['@cf/openai/gpt-oss-20b', 'GPT OSS 20B', false],
      ['@cf/openai/gpt-oss-120b', 'GPT OSS 120B', false],
    ];
    const models = labels.map(([id, label]): BuilderModel => ({ ...claudeModel, id, label }));
    const older = olderBuilderModelIds(models);
    expect(labels.filter(([id]) => older.has(id)).map(([, label]) => label)).toEqual(
      labels.filter(([, , superseded]) => superseded).map(([, label]) => label),
    );
  });

  it('reads OpenRouter labels with or without their vendor, and month-year snapshots by year first', () => {
    const unprefixed: BuilderModel = {
      ...claudeModel,
      id: 'openrouter/qwen/qwen-2.5-72b-instruct',
      label: 'Qwen2.5 72B Instruct',
    };
    const prefixed: BuilderModel = {
      ...claudeModel,
      id: 'openrouter/qwen/qwen-3.8-72b-instruct',
      label: 'Qwen: Qwen3.8 72B Instruct',
    };
    const lastYear: BuilderModel = {
      ...claudeModel,
      id: 'openrouter/cohere/command-r-08-2024',
      label: 'Cohere: Command R (08-2024)',
    };
    const thisYear: BuilderModel = {
      ...claudeModel,
      id: 'openrouter/cohere/command-r-03-2025',
      label: 'Cohere: Command R (03-2025)',
    };
    expect([...olderBuilderModelIds([unprefixed, prefixed, lastYear, thisYear])]).toEqual([unprefixed.id, lastYear.id]);
  });

  it('compares models only within one provider', () => {
    const viaOpenRouter: BuilderModel = {
      ...claudeModel,
      id: 'openrouter/anthropic/claude-opus-5.5',
      label: 'Anthropic: Claude Opus 5.5',
    };
    const direct: BuilderModel = { ...claudeModel, id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' };
    expect([...olderBuilderModelIds([viaOpenRouter, direct])]).toEqual([]);
  });

  it('discards an invalid stored provider and restores Workers AI', () => {
    localStorage.setItem('cloudchef_builder_provider_v1', 'invalid');
    loadBuilderModelPreference();
    expect(builderProviderStore.get()).toBeNull();
    localStorage.setItem('cloudchef_builder_provider_v1', 'workers');
    loadBuilderModelPreference();
    expect(builderProviderStore.get()).toBe('workers');
  });

  it('remembers the tab and deduplicates recent selections in this browser', () => {
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
