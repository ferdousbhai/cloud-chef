// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCloudflareReturnURL: vi.fn(() => 'https://cloudchef.build/'),
  signInWithCloudflare: vi.fn(async () => undefined),
}));

vi.mock('~/lib/auth-client', () => ({
  createCloudflareReturnURL: mocks.createCloudflareReturnURL,
  signInWithCloudflare: mocks.signInWithCloudflare,
}));

import { ReauthorizeInterstitial } from './ReauthorizeInterstitial.client';

const DEFERRED_KEY = 'cloudchef:cloudflare-reauthorize-deferred';

function stageConnection(oauthScopeGrantStatus: string | null) {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ accountId: 'a', oauthScopeGrantStatus }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

let container: HTMLElement;
let root: Root;

async function mount() {
  await act(async () => {
    root.render(<ReauthorizeInterstitial />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((element) => element.textContent === label);
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.sessionStorage.clear();
  mocks.createCloudflareReturnURL.mockClear();
  mocks.signInWithCloudflare.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReauthorizeInterstitial', () => {
  it('stays silent for a provider-confirmed grant', async () => {
    stageConnection('core');
    await mount();
    expect(document.body.textContent).not.toContain('Reauthorize Cloudflare');
  });

  it('does not prompt again once deferred this session', async () => {
    window.sessionStorage.setItem(DEFERRED_KEY, '1');
    const fetchImpl = stageConnection('unknown');
    await mount();
    expect(document.body.textContent).not.toContain('Reauthorize Cloudflare');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reauthorizes through the reconnect flow', async () => {
    stageConnection('unknown');
    await mount();
    await clickButton('Reauthorize Cloudflare');
    expect(mocks.signInWithCloudflare).toHaveBeenCalledWith('https://cloudchef.build/');
  });

  it('remembers a deferral so it does not nag on re-render', async () => {
    stageConnection('unknown');
    await mount();
    await clickButton('Later');
    expect(document.body.textContent).not.toContain('Reauthorize Cloudflare');
    expect(window.sessionStorage.getItem(DEFERRED_KEY)).toBe('1');
  });
});
