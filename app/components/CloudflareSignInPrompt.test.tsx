// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { NO_ACCOUNT_MESSAGE } from '~/lib/sign-in-refusal';
import { CloudflareSignInPrompt } from './CloudflareSignInPrompt';

/** Sam, signed in with Google or an emailed link, with no Cloudflare account to build in yet. */
const signedInWithoutAccount: CloudflareAuthSession = {
  session: { id: 'session-1', userId: 'user-1', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
  user: { id: 'user-1', name: 'Sam', email: 'sam@acme.com', image: null, username: null },
  context: null,
  contexts: [],
};

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/sign-in');
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The prompt as the page shows it, with `/api/auth/session` answering `session`. */
async function renderPrompt(session: CloudflareAuthSession | null, props: { title: string; initialError?: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => Response.json(session)),
  );
  const rootRoute = createRootRoute({
    component: () => (
      <CloudflareSignInPrompt
        title={props.title}
        description="Build in your own Cloudflare account."
        initialError={props.initialError}
      />
    ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createBrowserHistory() });
  await router.load();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<RouterProvider router={router} />));
  await act(async () => undefined);
  return {
    text: (document.body.textContent ?? '').replace(/\s+/g, ' '),
    buttons: Array.from(document.querySelectorAll('button'), (button) => button.textContent?.trim()),
  };
}

describe('the sign-in prompt', () => {
  it('signs up with Cloudflare, and signs in to an existing account with Google or an emailed link', async () => {
    const { text, buttons } = await renderPrompt(null, { title: 'Sign in to CloudChef.' });
    expect(text).toContain('Sign in to CloudChef.');
    expect(text).toContain('Build in your own Cloudflare account.');
    expect(text).toContain("Needs Cloudflare's Workers Paid plan.");
    expect(text).toContain('Already have a CloudChef account? Sign in with Google or an emailed link.');
    expect(text).toContain('By continuing, you agree to the Terms and Privacy notice.');
    expect(buttons).toEqual(['Continue with Cloudflare', 'Continue with Google', 'Email me a link']);
    expect(text).not.toContain('Back to CloudChef');
    expect(text).not.toContain('Workers Paid required.');
  });

  it('says plainly why Google or a link signed no one in', async () => {
    await renderPrompt(null, { title: 'Sign in to CloudChef.', initialError: NO_ACCOUNT_MESSAGE });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "There's no CloudChef account for this address. Connect Cloudflare to start, or ask your team's admin to invite you.",
    );
  });

  it('offers someone signed in without a Cloudflare account to connect one, not to sign in again', async () => {
    const { text, buttons } = await renderPrompt(signedInWithoutAccount, { title: 'Sign in to open settings.' });
    expect(text).toContain("You're signed in as sam@acme.com.");
    expect(buttons).toEqual(['Connect Cloudflare', 'Sign out']);
    expect(text).toContain('Teams');
    expect(text).not.toContain('Already have a CloudChef account?');
  });
});
