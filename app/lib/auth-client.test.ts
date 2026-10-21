// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  authClient,
  createCloudflareReturnURL,
  retrySession,
  signInWithCloudflare,
  signOutOfCloudChef,
  switchWorkspace,
} from './auth-client';
import { useUnsavedEditsGuard } from '~/lib/hooks/useUnsavedEditsGuard';
import { PENDING_SUBMIT_STORAGE_KEY } from '~/utils/constants';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('the submit an authorization was asked to finish', () => {
  // A same-document destination, because jsdom leaves cross-document navigation unimplemented.
  function stubAuthorizationStart() {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ authorizationUrl: `${window.location.href.split('#')[0]}#cloudflare-authorization` }),
        ),
    );
  }

  test('travels with the connection the submit started', async () => {
    stubAuthorizationStart();

    await signInWithCloudflare('http://localhost/', { continuePrompt: '  Build a launch checklist.  ' });

    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBe('Build a launch checklist.');
  });

  test('is dropped by any connection no submit started', async () => {
    window.sessionStorage.setItem(PENDING_SUBMIT_STORAGE_KEY, 'Build a launch checklist.');
    stubAuthorizationStart();

    // Connecting from settings or the account card must never resume someone else's build.
    await signInWithCloudflare('http://localhost/settings');

    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBeNull();
  });

  test('is dropped when the authorization never starts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'Cloudflare authorization is unavailable.' }, { status: 503 })),
    );

    await expect(
      signInWithCloudflare('http://localhost/', { continuePrompt: 'Build a launch checklist.' }),
    ).rejects.toThrow('Cloudflare authorization is unavailable.');
    expect(window.sessionStorage.getItem(PENDING_SUBMIT_STORAGE_KEY)).toBeNull();
  });
});

describe('leaving the page over edits not yet saved', () => {
  /** A chat whose editor holds edits not yet saved; returns its unmount. */
  async function renderChatWithUnsavedEdits() {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const rootRoute = createRootRoute({
      component: function ChatWithUnsavedEdits() {
        useUnsavedEditsGuard(true);
        return null;
      },
    });
    const router = createRouter({ routeTree: rootRoute, history: createBrowserHistory() });
    await router.load();
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(RouterProvider, { router })));
    return () => act(async () => root.unmount());
  }

  test.each([
    { action: 'signing out', leave: () => signOutOfCloudChef() },
    { action: 'switching account', leave: () => switchWorkspace('connection-b') },
    { action: 'connecting Cloudflare', leave: () => signInWithCloudflare('http://localhost/') },
  ])('asks before $action reaches the server, and does nothing when the person stays', async ({ leave }) => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const unmount = await renderChatWithUnsavedEdits();

    await expect(leave()).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('not saved'));
    expect(fetchImpl).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('Cloudflare return URL', () => {
  test('returns OAuth directly to the same-origin builder destination', () => {
    expect(
      createCloudflareReturnURL('https://cloudchef.build/chat/project?panel=code#preview', 'https://cloudchef.build'),
    ).toBe('https://cloudchef.build/chat/project?panel=code#preview');
  });

  test('rejects external and protocol-relative continuations', () => {
    expect(createCloudflareReturnURL('https://attacker.example/path', 'https://cloudchef.build')).toBe(
      'https://cloudchef.build/',
    );
    expect(createCloudflareReturnURL('https://cloudchef.build//attacker.example', 'https://cloudchef.build')).toBe(
      'https://cloudchef.build/',
    );
  });

  test('resumes the original destination after a failed authorization', () => {
    expect(
      createCloudflareReturnURL(
        'https://cloudchef.build/settings?continue=%2Fchat%2Fproject&cloudflare_authorization=failed#cloudflare',
        'https://cloudchef.build',
      ),
    ).toBe('https://cloudchef.build/chat/project');
    expect(
      createCloudflareReturnURL(
        'https://cloudchef.build/settings?continue=%2F%5Cattacker.example&cloudflare_authorization=failed',
        'https://cloudchef.build',
      ),
    ).toBe('https://cloudchef.build/settings');
  });
});

describe('a session that could not be checked', () => {
  test('is reported as an error, not as being signed out, until a retry succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Network down'))
        .mockResolvedValue(
          Response.json({
            session: { id: 's', userId: 'u', expiresAt: 2, createdAt: 1 },
            user: { id: 'u', name: 'Sam', email: 'sam@acme.com', image: null },
            context: null,
            contexts: [],
          }),
        ),
    );
    const seen: Array<{ email: string | null; error: string | null; isPending: boolean }> = [];
    function Probe() {
      const { data, error, isPending } = authClient.useSession();
      seen.push({ email: data?.user.email ?? null, error, isPending });
      return null;
    }
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.createElement('div'));

    await act(async () => root.render(createElement(Probe)));
    expect(seen.at(-1)).toEqual({ email: null, error: "Couldn't check your session.", isPending: false });

    await act(async () => retrySession());
    expect(seen.at(-1)).toEqual({ email: 'sam@acme.com', error: null, isPending: false });
    await act(async () => root.unmount());
  });
});
