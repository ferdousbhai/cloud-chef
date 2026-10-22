// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  type BuilderModel,
  type BuilderModelCatalogPayload,
} from '~/lib/workers-ai-model';

import {
  builderModelCatalogStatusStore,
  builderModelStore,
  builderNewModelsStore,
  installBuilderModelCatalog,
  loadBuilderModelCatalog,
  loadBuilderModelPreference,
} from '~/lib/stores/builder-model.client';
import { BuilderModelSelector } from './BuilderModelSelector.client';

const alternativeModel: BuilderModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  label: 'DeepSeek V4.1 Flash 1017',
  description: 'Cloudflare-hosted open-weight reasoning model.',
  vision: false,
};
const catalog: BuilderModelCatalogPayload = {
  defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
  models: [DEFAULT_WORKERS_AI_MODEL, alternativeModel],
};

let root: Root | undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  installBuilderModelCatalog({ defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] });
  loadBuilderModelPreference();
  builderModelCatalogStatusStore.set('ready');
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('BuilderModelSelector', () => {
  it('loads the user catalog and persists a compatible selection', async () => {
    await renderSelector();

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    expect(trigger?.getAttribute('aria-label')).toContain('GLM 5.3 Flash');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain('Workers AI');
    expect(document.querySelectorAll('#builder-provider-models [role="menuitemradio"]')).toHaveLength(2);
    const alternative = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('DeepSeek V4.1 Flash 1017'),
    );

    await act(async () => alternative?.click());

    expect(builderModelStore.get()).toBe(alternativeModel.id);
    expect(localStorage.getItem('cloudchef_builder_model_v2')).toBe(alternativeModel.id);
  });

  it('badges an unseen model, dates it, and records the sighting when the picker opens', async () => {
    localStorage.setItem('cloudchef_seen_builder_models_v1', JSON.stringify([CLOUDFLARE_WORKERS_AI_MODEL]));
    await renderSelector(datedCatalog);
    expect(builderNewModelsStore.get().map(({ id }) => id)).toEqual([alternativeModel.id]);

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    const alternative = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('DeepSeek V4.1 Flash 1017'),
    );
    expect(alternative?.textContent).toContain('New');
    expect(alternative?.textContent).toContain('added Aug 26');
    // The pinned default keeps the top row even though the other model is newer.
    expect(document.querySelectorAll('[role="menuitemradio"]')[0]?.textContent).toContain('GLM 5.3 Flash');
    expect(builderNewModelsStore.get()).toEqual([]);
    expect(JSON.parse(localStorage.getItem('cloudchef_seen_builder_models_v1') ?? 'null')).toEqual([
      CLOUDFLARE_WORKERS_AI_MODEL,
      alternativeModel.id,
    ]);
  });

  it("lists a gateway provider's models apart from Workers AI when the account offers them, and switches to one", async () => {
    const claude: BuilderModel = { ...alternativeModel, id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' };
    await renderSelector({ ...catalog, models: [...catalog.models, claude] });

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      'Workers AI',
      'Anthropic',
    ]);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Workers AI');
    // Providers without a key share one link to Settings, after the tabs.
    expect(document.querySelector('a[href="/settings#models"]')?.getAttribute('aria-label')).toBe(
      'Add a key for OpenAI or xAI or OpenRouter in Settings',
    );
    await chooseTab('Anthropic');

    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((element) =>
      element.textContent?.includes('Claude Opus 5.5'),
    );
    await act(async () => item?.click());

    expect(builderModelStore.get()).toBe('anthropic/claude-opus-5-5');
    expect(localStorage.getItem('cloudchef_builder_model_v2')).toBe('anthropic/claude-opus-5-5');
  });

  it('shows the reasoning effort beside the model, offers the efforts the model lists, and keeps each per model', async () => {
    const claude: BuilderModel = {
      ...alternativeModel,
      id: 'anthropic/claude-opus-5-5',
      label: 'Claude Opus 5.5',
      reasoningLevels: ['low', 'high', 'max'],
    };
    await renderSelector({ ...catalog, models: [...catalog.models, claude] });
    const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    const open = async () =>
      act(async () => {
        trigger()?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      });
    const efforts = () => [
      ...document.querySelectorAll<HTMLElement>(
        '[aria-labelledby="builder-reasoning-effort-label"] [role="menuitemradio"]',
      ),
    ];

    // GLM has no efforts listed here, so the picker shows none.
    expect(trigger()?.textContent).not.toContain('·');
    await open();
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Reasoning effort');
    await chooseTab('Anthropic');
    const claudeItem = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('Claude Opus 5.5'),
    );
    await act(async () => claudeItem?.click());

    expect(trigger()?.textContent).toContain('· Default');
    expect(trigger()?.getAttribute('aria-label')).toContain('reasoning effort Default');
    await open();
    expect(efforts().map((item) => item.textContent)).toEqual(['Default', 'Low', 'High', 'Max']);
    // Older Claude models have no default effort of their own, so "Default" says what they get.
    expect(efforts()[0]?.getAttribute('title')).toContain('High for a Claude model');
    expect(efforts()[0]?.getAttribute('aria-checked')).toBe('true');
    await act(async () => efforts()[2]?.click());

    expect(trigger()?.textContent).toContain('· High');
    expect(JSON.parse(localStorage.getItem('cloudchef_builder_reasoning_v1') ?? 'null')).toEqual({
      'anthropic/claude-opus-5-5': 'high',
    });
    // Choosing an effort leaves the menu open on the model list.
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(efforts()[2]?.getAttribute('aria-checked')).toBe('true');
  });

  it('opens on the current provider, lists only the newest of each family, searches across providers, and clears search before closing', async () => {
    const claude: BuilderModel = { ...alternativeModel, id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' };
    const old: BuilderModel = { ...claude, id: 'anthropic/claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' };
    const extras: BuilderModel[] = Array.from({ length: 6 }, (_, index) => ({
      ...alternativeModel,
      id: `openai/model-${index}`,
      label: `Other ${'ABCDEF'.charAt(index)}`,
    }));
    localStorage.setItem('cloudchef_builder_model_v2', claude.id);
    await renderSelector({ ...catalog, models: [...catalog.models, claude, old, ...extras] });
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    expect(trigger?.textContent).toBe('AClaude Sonnet 4.6');
    await act(async () => trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Anthropic');
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Claude 3.7 Sonnet');
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Older models');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    const searchFor = async (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    // Search finds only what the list offers: the older Sonnet is superseded there too.
    await searchFor('sonnet');
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
      expect.stringContaining('Claude Sonnet 4.6'),
    ]);
    await searchFor('openai/model-2');
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
      expect.stringContaining('Other C'),
    ]);
    await act(async () =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })),
    );
    expect(document.activeElement?.textContent).toContain('Other C');
    await act(async () =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    );
    expect(input?.value).toBe('');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps listing a selected model a newer one supersedes, and shows no description line for a model without one', async () => {
    const newest: BuilderModel = {
      ...alternativeModel,
      id: 'anthropic/claude-opus-5-5',
      label: 'Claude Opus 5.5',
      description: '',
    };
    const chosen: BuilderModel = { ...newest, id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' };
    const superseded: BuilderModel = { ...newest, id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' };
    const extras: BuilderModel[] = Array.from({ length: 6 }, (_, index) => ({
      ...alternativeModel,
      id: `openai/model-${index}`,
      label: `Other ${'ABCDEF'.charAt(index)}`,
    }));
    localStorage.setItem('cloudchef_builder_model_v2', chosen.id);
    await renderSelector({ ...catalog, models: [...catalog.models, newest, chosen, superseded, ...extras] });
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    expect(trigger?.title).toBe('Claude Opus 4.7 — anthropic/claude-opus-4-7');
    await act(async () => trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    const listed = () =>
      [...document.querySelectorAll<HTMLElement>('#builder-provider-models [role="menuitemradio"]')].map(
        (item) => item.textContent,
      );
    expect(listed()).toEqual([expect.stringContaining('Claude Opus 5.5'), expect.stringContaining('Claude Opus 4.7')]);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'opus');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(listed()).toEqual([expect.stringContaining('Claude Opus 5.5'), expect.stringContaining('Claude Opus 4.7')]);
    // A row with no description and no date is its label and badges alone.
    const row = [...document.querySelectorAll<HTMLElement>('#builder-provider-models [role="menuitemradio"]')][0];
    expect(row?.querySelectorAll('.line-clamp-2')).toHaveLength(0);
  });

  it('dates a model without a description with no separator before the date', async () => {
    await renderSelector({
      ...catalog,
      models: [
        DEFAULT_WORKERS_AI_MODEL,
        { ...alternativeModel, description: '', createdAt: '2026-08-26T00:00:00.000Z' },
      ],
    });
    await act(async () =>
      document
        .querySelector('button[aria-label^="Builder model"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    const row = [...document.querySelectorAll<HTMLElement>('#builder-provider-models [role="menuitemradio"]')].find(
      (item) => item.textContent?.includes('DeepSeek V4.1 Flash 1017'),
    );
    expect(row?.querySelector('.line-clamp-2')?.textContent).toBe('added Aug 26');
  });

  it('pins only the default when no other recent model remains', async () => {
    localStorage.setItem('cloudchef_builder_recents_v1', JSON.stringify([CLOUDFLARE_WORKERS_AI_MODEL]));
    await renderSelector();
    await act(async () =>
      document.querySelector('button')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    const pins = [...document.querySelectorAll('[aria-label="Quick switch"] [role="menuitemradio"]')];
    expect(pins.map((pin) => pin.getAttribute('aria-label'))).toEqual(['GLM 5.3 Flash, team default']);
  });

  it('pins the default and recent models and restores the last provider tab', async () => {
    localStorage.setItem(
      'cloudchef_builder_recents_v1',
      JSON.stringify([alternativeModel.id, CLOUDFLARE_WORKERS_AI_MODEL]),
    );
    localStorage.setItem('cloudchef_builder_provider_v1', 'anthropic');
    const claude: BuilderModel = { ...alternativeModel, id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' };
    await renderSelector({ ...catalog, models: [...catalog.models, claude] });
    await act(async () =>
      document.querySelector('button')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })),
    );
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Anthropic');
    const pins = [...document.querySelectorAll('[aria-label="Quick switch"] [role="menuitemradio"]')];
    expect(pins.map((pin) => pin.getAttribute('aria-label'))).toEqual([
      'GLM 5.3 Flash, team default',
      'DeepSeek V4.1 Flash 1017, recent',
    ]);
    // The provider list stays whole: the restored Anthropic tab lists its own models.
    expect(
      [...document.querySelectorAll('#builder-provider-models [role="menuitemradio"]')].map((item) => item.textContent),
    ).toEqual([expect.stringContaining('Claude Opus 5.5')]);
  });

  it('closes the menu and prevents changes when a turn becomes active', async () => {
    await renderSelector();

    const enabledTrigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    await act(async () => {
      enabledTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => root?.render(<BuilderModelSelector disabled />));

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.title).toContain('Stop or wait');
    expect(trigger?.getAttribute('aria-label')).toContain('before switching models');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('keeps listing the installed catalog, and says it is not current, when a refresh fails', async () => {
    installBuilderModelCatalog(catalog);
    await renderSelector({ status: 503 });

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    expect(document.querySelectorAll('#builder-provider-models [role="menuitemradio"]')).toHaveLength(2);
    const status = document.querySelector('[role="status"]')?.textContent;
    expect(status).toContain('could not be refreshed just now, so these are the models it last listed');
    expect(status).not.toContain('Only the default model is available');
  });
});

describe('BuilderModelSelector without a catalog', () => {
  it('lists the saved model, selected, and says turns still use it when the catalog fails to load', async () => {
    // Fresh modules, so no catalog has been installed yet; React is fresh with them so the picker
    // and the renderer share one copy.
    vi.resetModules();
    const { createElement, act: freshAct } = await import('react');
    const { createRoot: freshCreateRoot } = await import('react-dom/client');
    const fresh = await import('~/lib/stores/builder-model.client');
    const { BuilderModelSelector: FreshSelector } = await import('./BuilderModelSelector.client');
    const savedModel = 'anthropic/claude-opus-5-5';
    localStorage.setItem('cloudchef_builder_model_v2', savedModel);
    serveCatalog({ status: 503 });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const freshRoot = freshCreateRoot(container);
    try {
      await freshAct(async () => {
        freshRoot.render(createElement(FreshSelector));
        await fresh.loadBuilderModelCatalog();
      });
      expect(fresh.builderModelCatalogStatusStore.get()).toBe('error');
      expect(fresh.builderModelRequestFields()).toEqual({ modelId: savedModel });

      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
      expect(trigger?.title).not.toContain('Loading the model catalog');
      expect(trigger?.title).toContain('checked when a turn starts');
      await freshAct(async () => {
        trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      });

      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      expect(items.map((item) => [item.textContent?.includes(savedModel), item.getAttribute('aria-checked')])).toEqual(
        expect.arrayContaining([[true, 'true']]),
      );
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        `Turns still use your saved model, ${savedModel}`,
      );

      const defaultItem = items.find((item) => item.textContent?.includes('GLM 5.3 Flash'));
      await freshAct(async () => defaultItem?.click());
      expect(fresh.builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    } finally {
      await freshAct(async () => freshRoot.unmount());
      container.remove();
      localStorage.removeItem('cloudchef_builder_model_v2');
    }
  });
});

type CatalogAnswer = BuilderModelCatalogPayload | { status: number };

/** Renders the picker against a workspace that answers its catalog request with `answer`. */
async function renderSelector(answer: CatalogAnswer = catalog) {
  serveCatalog(answer);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<BuilderModelSelector />);
    await loadBuilderModelCatalog();
  });
}

/** Grants a runtime session, then answers the workspace's catalog request with `answer`: the catalog, or a failing status. */
function serveCatalog(answer: CatalogAnswer): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/cloudflare/runtime-session') {
        return Response.json({ endpoint: 'https://workspace.example', token: 'token', expiresAt: Date.now() + 60_000 });
      }
      return 'models' in answer ? Response.json(answer) : new Response(null, { status: answer.status });
    }),
  );
}

const datedCatalog: BuilderModelCatalogPayload = {
  ...catalog,
  models: [DEFAULT_WORKERS_AI_MODEL, { ...alternativeModel, createdAt: '2026-08-26T00:00:00.000Z' }],
};

async function chooseTab(label: string) {
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === label)?.click(),
  );
}
