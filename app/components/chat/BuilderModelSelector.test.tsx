// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
} from '~/lib/workers-ai-model';

import {
  builderModelStore,
  builderNewModelsStore,
  installBuilderModelCatalog,
  loadBuilderModelPreference,
} from '~/lib/stores/builder-model.client';
import { BuilderModelSelector } from './BuilderModelSelector.client';

const alternativeModel: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
  label: 'DeepSeek V4 Flash 0731',
  description: 'Cloudflare-hosted open-weight reasoning model.',
  vision: false,
};
const catalog: WorkersAiModelCatalogPayload = {
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
  });
  installBuilderModelCatalog(
    { defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] },
    { getItem: () => null },
  );
  loadBuilderModelPreference({ getItem: () => null });
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
    expect(menu?.textContent).toContain('Cloudflare Workers AI');
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
    const alternative = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('DeepSeek V4 Flash 0731'),
    );

    await act(async () => alternative?.click());

    expect(builderModelStore.get()).toBe(alternativeModel.id);
    expect(localStorage.getItem('cloudchef_builder_model_v2')).toBe(alternativeModel.id);
  });

  it('badges an unseen model, dates it, and records the sighting when the picker opens', async () => {
    localStorage.setItem('cloudchef_seen_builder_models_v1', JSON.stringify([CLOUDFLARE_WORKERS_AI_MODEL]));
    await renderSelector(installDatedCatalog);
    expect(builderNewModelsStore.get().map(({ id }) => id)).toEqual([alternativeModel.id]);

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    const alternative = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes('DeepSeek V4 Flash 0731'),
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

  it('closes the menu and prevents changes when a turn becomes active', async () => {
    await renderSelector();

    const enabledTrigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    await act(async () => {
      enabledTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => root?.render(<BuilderModelSelector disabled catalogLoader={installTestCatalog} />));

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Builder model"]');
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.title).toContain('Stop or wait');
    expect(trigger?.getAttribute('aria-label')).toContain('before switching models');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });
});

async function renderSelector(catalogLoader: () => void = installTestCatalog) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<BuilderModelSelector catalogLoader={catalogLoader} />);
    await Promise.resolve();
  });
}

function installTestCatalog(): void {
  installBuilderModelCatalog(catalog);
}

function installDatedCatalog(): void {
  installBuilderModelCatalog({
    ...catalog,
    models: [DEFAULT_WORKERS_AI_MODEL, { ...alternativeModel, createdAt: '2026-08-26T00:00:00.000Z' }],
  });
}
