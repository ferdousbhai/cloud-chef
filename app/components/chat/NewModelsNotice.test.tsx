// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL, type BuilderModel } from '~/lib/workers-ai-model';
import {
  builderModelStore,
  builderNewModelsStore,
  installBuilderModelCatalog,
} from '~/lib/stores/builder-model.client';
import { NewModelsNotice } from './NewModelsNotice.client';

const SEEN_KEY = 'cloudchef_seen_builder_models_v1';
const deepseek: BuilderModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  label: 'DeepSeek V4.1 Flash 1017',
  createdAt: '2026-08-26T00:00:00.000Z',
};

let root: Root | undefined;
let values: Map<string, string>;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  });
  builderNewModelsStore.set([]);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('NewModelsNotice', () => {
  it('names a newly added model once, then stays gone after it is dismissed', async () => {
    values.set(SEEN_KEY, JSON.stringify([CLOUDFLARE_WORKERS_AI_MODEL]));
    installBuilderModelCatalog({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, deepseek],
    });

    await render();

    const notice = document.querySelector('[role="status"]');
    expect(notice?.textContent).toContain('New models');
    expect(notice?.textContent).toContain('DeepSeek V4.1 Flash 1017');
    expect(notice?.textContent).toContain('available in the model picker');

    await act(async () => notice?.querySelector('button')?.click());

    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(JSON.parse(values.get(SEEN_KEY) ?? 'null')).toEqual([CLOUDFLARE_WORKERS_AI_MODEL, deepseek.id]);

    // A later load of the same catalog has nothing left to announce.
    installBuilderModelCatalog({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, deepseek],
    });
    await act(async () => undefined);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('says when the saved model is no longer offered and the default stands in, until dismissed', async () => {
    values.set(SEEN_KEY, JSON.stringify([CLOUDFLARE_WORKERS_AI_MODEL, deepseek.id]));
    values.set('cloudchef_builder_model_v2', deepseek.id);
    installBuilderModelCatalog({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, deepseek],
    });
    expect(builderModelStore.get()).toBe(deepseek.id);
    await render();
    expect(document.querySelector('[role="status"]')).toBeNull();

    // The account's admin no longer allows it: the catalog leaves it out.
    installBuilderModelCatalog({ defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] });
    await act(async () => undefined);
    expect(builderModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    const notice = document.querySelector('[role="status"]');
    expect(notice?.textContent).toContain(
      'Model changed: DeepSeek V4.1 Flash 1017 isn’t offered in this account any more, so new messages use GLM 5.3 Flash.',
    );

    await act(async () => notice?.querySelector('button')?.click());
    expect(document.querySelector('[role="status"]')).toBeNull();
    // The default is now the saved model, so the next load says nothing.
    expect(values.get('cloudchef_builder_model_v2')).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
    installBuilderModelCatalog({ defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] });
    await act(async () => undefined);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });
});

async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<NewModelsNotice />);
    await Promise.resolve();
  });
}
