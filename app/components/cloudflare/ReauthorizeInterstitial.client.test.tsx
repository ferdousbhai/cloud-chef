// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Context = { kind: 'personal' } | { kind: 'organization'; orgName: string; role: 'admin' | 'member' };
/** The session context the mocked `useSession` reports, set per test. */
type CurrentContext = { current: Context };

const mocks = vi.hoisted(() => {
  const context: CurrentContext = { current: { kind: 'personal' } };
  return {
    createCloudflareReturnURL: vi.fn(() => 'https://cloudchef.build/'),
    signInWithCloudflare: vi.fn(async () => undefined),
    context,
  };
});

vi.mock('~/lib/auth-client', () => ({
  authClient: { useSession: () => ({ data: { context: mocks.context.current } }) },
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
  mocks.context.current = { kind: 'personal' };
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

  it("sends an organization's admin to its settings rather than to their own Cloudflare login", async () => {
    mocks.context.current = { kind: 'organization', orgName: 'Acme', role: 'admin' };
    stageConnection('unknown');
    await mount();
    expect(document.querySelector('a[href="/settings#organizations"]')).not.toBeNull();
    const labels = [...document.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toContain('Later');
    expect(labels).not.toContain('Reauthorize Cloudflare');
  });

  it("asks an organization's member to get an admin to reconnect", async () => {
    mocks.context.current = { kind: 'organization', orgName: 'Acme', role: 'member' };
    stageConnection('unknown');
    await mount();
    expect(document.body.textContent).toContain('Ask one of its admins');
    expect(document.querySelector('a[href="/settings#organizations"]')).toBeNull();
    expect(mocks.signInWithCloudflare).not.toHaveBeenCalled();
  });

  it('remembers a deferral so it does not nag on re-render', async () => {
    stageConnection('unknown');
    await mount();
    await clickButton('Later');
    expect(document.body.textContent).not.toContain('Reauthorize Cloudflare');
    expect(window.sessionStorage.getItem(DEFERRED_KEY)).toBe('1');
  });
});
