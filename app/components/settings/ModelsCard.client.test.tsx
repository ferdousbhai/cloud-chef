// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { builderModelCatalogStatusStore, installBuilderModelCatalog } from '~/lib/stores/builder-model.client';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL, type BuilderModel } from '~/lib/workers-ai-model';
import { ModelsCard } from './ModelsCard.client';

const RUNTIME = 'https://runtime.example.com';
const claudeModel: BuilderModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: 'anthropic/claude-opus-5-5',
  label: 'Claude Opus 5.5',
  contextTokens: 1_000_000,
  requiresPaid: false,
};
const unlinked = { status: 'ready', providers: [{ provider: 'anthropic', key: null }] };
const linked = {
  status: 'ready',
  providers: [{ provider: 'anthropic', key: { alias: 'default', secretPreview: null, addedByCloudChef: true } }],
};

let root: Root | undefined;
/** Answers each request to the account's catalog in turn; the default answer serves the rest. */
let catalogAnswers: (() => Promise<Response>)[] = [];
let catalogAnswer: () => Promise<Response> = async () => new Response(null, { status: 503 });
const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
  if (input === '/api/settings/models') {
    return Response.json({ canManage: true, defaultModelId: null, keys: unlinked });
  }
  if (input === '/api/settings/models/keys/link' && init?.method === 'POST') {
    return Response.json({ keys: linked, authenticationTurnedOn: false, previousKeysRemain: false });
  }
  if (input === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (input === `${RUNTIME}/v1/models`) {
    return (catalogAnswers.shift() ?? catalogAnswer)();
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
});

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  fetchMock.mockClear();
  catalogAnswers = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
  resetUserRuntimeSession();
  installBuilderModelCatalog(
    { defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] },
    { getItem: () => null, setItem: () => undefined },
  );
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

async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<ModelsCard />));
}

/** Lets every pending request and the renders they cause finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function defaultModelChoices(): string[] {
  return [...document.querySelectorAll<HTMLOptionElement>('#default-model option')].map(
    (option) => option.textContent ?? '',
  );
}

describe('ModelsCard', () => {
  it("lists a linked key's models from a catalog requested after linking, not one already in flight", async () => {
    let answerFirstRequest: (response: Response) => void = () => undefined;
    catalogAnswers = [() => new Promise<Response>((resolve) => (answerFirstRequest = resolve))];
    catalogAnswer = async () =>
      Response.json({ defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL, claudeModel] });
    await render();
    await settle();

    const input = document.querySelector<HTMLInputElement>('input[aria-label="Anthropic API key"]');
    await act(async () => {
      // React tracks the value its own setter wrote, so the native one is what makes this an edit.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'sk-ant-test');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    await settle();
    // The catalog request sent before the key was linked answers last, without its models.
    answerFirstRequest(
      Response.json({ defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL] }),
    );
    await settle();

    expect(fetchMock.mock.calls.filter(([url]) => url === `${RUNTIME}/v1/models`)).toHaveLength(2);
    expect(defaultModelChoices()).toContain('Claude Opus 5.5 (Anthropic)');
    expect(builderModelCatalogStatusStore.get()).toBe('ready');
  });

  it('says a failed refresh shows the models last listed, rather than that none could be loaded', async () => {
    catalogAnswer = async () => new Response(null, { status: 503 });
    await render();
    await settle();

    expect(builderModelCatalogStatusStore.get()).toBe('stale');
    expect(document.body.textContent).toContain(
      'could not be refreshed just now, so these are the models it last listed',
    );
    expect(document.body.textContent).not.toContain('could not be loaded');
  });
});
