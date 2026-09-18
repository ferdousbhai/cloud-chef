// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL, type WorkersAiModel } from '~/lib/workers-ai-model';
import { builderNewModelsStore, installBuilderModelCatalog } from '~/lib/stores/builder-model.client';
import { NewModelsNotice } from './NewModelsNotice.client';

const SEEN_KEY = 'cloudchef_seen_builder_models_v1';
const kimi: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/moonshotai/kimi-k2.7-code',
  label: 'Kimi K2.7 Code',
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
  it('says nothing on a first ever catalog load', async () => {
    installBuilderModelCatalog({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, kimi],
    });

    await render();

    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('names a newly added model once, then stays gone after it is dismissed', async () => {
    values.set(SEEN_KEY, JSON.stringify([CLOUDFLARE_WORKERS_AI_MODEL]));
    installBuilderModelCatalog({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, kimi],
    });

    await render();

    const notice = document.querySelector('[role="status"]');
    expect(notice?.textContent).toContain('New on Workers AI');
    expect(notice?.textContent).toContain('Kimi K2.7 Code');
    expect(notice?.textContent).toContain('available in the model picker');

    await act(async () => notice?.querySelector('button')?.click());

    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(JSON.parse(values.get(SEEN_KEY) ?? 'null')).toEqual([CLOUDFLARE_WORKERS_AI_MODEL, kimi.id]);

    // A later load of the same catalog has nothing left to announce.
    installBuilderModelCatalog({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, kimi],
    });
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
