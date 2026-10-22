// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import {
  builderDefaultModelStore,
  builderModelCatalogStatusStore,
  installBuilderModelCatalog,
} from '~/lib/stores/builder-model.client';
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

type KeysFixture = {
  status: string;
  providers: {
    provider: string;
    key: { alias: string; secretPreview: string | null; addedByCloudChef: boolean } | null;
  }[];
};
let initialKeys: KeysFixture = unlinked;
let root: Root | undefined;
/** Answers each request to the account's catalog in turn; the default answer serves the rest. */
let catalogAnswers: (() => Promise<Response>)[] = [];
let catalogAnswer: () => Promise<Response> = async () => new Response(null, { status: 503 });
const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
  if (input === '/api/settings/models') {
    return Response.json({ canManage: true, defaultModelId: null, keys: initialKeys });
  }
  if (input === '/api/settings/models/keys/link' && init?.method === 'POST') {
    return Response.json({ keys: linked, authenticationTurnedOn: false, previousKeysRemain: false });
  }
  if (input === '/api/settings/models/default' && init?.method === 'POST') {
    return Response.json({ defaultModelId: claudeModel.id });
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
  initialKeys = unlinked;
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
  it('uses the label to choose the API key article', async () => {
    initialKeys = {
      status: 'ready',
      providers: ['anthropic', 'openai', 'openrouter', 'grok'].map((provider) => ({ provider, key: null })),
    };
    await render();
    expect([...document.querySelectorAll('input')].map((input) => input.placeholder)).toEqual([
      'Paste an Anthropic API key',
      'Paste an OpenAI API key',
      'Paste an OpenRouter API key',
      'Paste an xAI API key',
    ]);
  });

  it('shows linked key facts and reveals the replacement input and warning on request', async () => {
    initialKeys = {
      status: 'ready',
      providers: [
        { provider: 'anthropic', key: { alias: 'sg', secretPreview: '********wAA', addedByCloudChef: false } },
      ],
    };
    await render();
    expect(document.body.textContent).toContain(
      'Key ending wAA · alias sg · added in Cloudflare · stored in your Cloudflare account',
    );
    expect(
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Replace key')?.parentElement
        ?.className,
    ).toContain('mt-2.5');
    expect(document.querySelector('input')).toBeNull();
    expect(document.body.textContent).not.toContain('Saving a key here replaces');
    await act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Replace key')?.click(),
    );
    expect(document.querySelector('input[aria-label="Anthropic API key"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Saving a key here replaces');
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Anthropic API key"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'sk-ant-replacement');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')?.click(),
    );
    expect(document.querySelector('input')).toBeNull();
    expect(document.body.textContent).not.toContain('Saving a key here replaces');
    await act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Replace key')?.click(),
    );
    const replacement = document.querySelector<HTMLInputElement>('input[aria-label="Anthropic API key"]');
    expect(replacement?.value).toBe('');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        replacement,
        'sk-ant-replacement',
      );
      replacement?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    await settle();
    expect(document.querySelector('input')).toBeNull();
    expect(document.body.textContent).not.toContain('Saving a key here replaces');
  });

  it('describes the default alias without repeating alias default', async () => {
    initialKeys = linked;
    await render();
    expect(document.body.textContent).toContain(
      'Key linked · default alias · added in CloudChef · stored in your Cloudflare account',
    );
  });

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

  it('starts new chats on a newly chosen default by requesting the catalog again', async () => {
    catalogAnswers = [
      async () =>
        Response.json({ defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL, models: [DEFAULT_WORKERS_AI_MODEL, claudeModel] }),
    ];
    catalogAnswer = async () =>
      Response.json({ defaultModelId: claudeModel.id, models: [DEFAULT_WORKERS_AI_MODEL, claudeModel] });
    await render();
    await settle();
    expect(builderDefaultModelStore.get()).toBe(CLOUDFLARE_WORKERS_AI_MODEL);

    const select = document.querySelector<HTMLElement>('#default-model');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, claudeModel.id);
      select?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();

    expect(fetchMock.mock.calls.filter(([url]) => url === `${RUNTIME}/v1/models`)).toHaveLength(2);
    expect(builderDefaultModelStore.get()).toBe(claudeModel.id);
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
