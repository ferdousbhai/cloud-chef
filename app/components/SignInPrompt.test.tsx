// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { SignInPrompt } from './SignInPrompt';

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

/** The prompt as the page shows it, with `/api/auth/session` answering `session` and the waitlist kept in memory. */
async function renderPrompt(session: CloudflareAuthSession | null, props: { title: string; initialError?: string }) {
  let waitlisted = false;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path === '/api/managed-spaces/waitlist/update') {
        waitlisted = z.object({ joined: z.boolean() }).parse(JSON.parse(String(init?.body))).joined;
      }
      return path.startsWith('/api/managed-spaces/waitlist')
        ? Response.json({ joined: waitlisted })
        : Response.json(session);
    }),
  );
  const rootRoute = createRootRoute({
    component: () => (
      <SignInPrompt
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
  it('signs in the same way for everyone, with Google or an emailed link, and Cloudflare only as a small link', async () => {
    const { text, buttons } = await renderPrompt(null, { title: 'Sign in to CloudChef' });
    expect(text).toContain('Sign in to CloudChef');
    expect(text).toContain('Made your account with Cloudflare? Sign in with Cloudflare');
    expect(text).toContain('By continuing, you agree to the Terms and Privacy notice.');
    expect(buttons).toEqual(['Continue with Google', 'Continue with email', 'Sign in with Cloudflare']);
    expect(text).not.toContain('Workers Paid');
    expect(text).not.toContain('Last used');
  });

  it('marks how this browser signed in last', async () => {
    window.localStorage.setItem('cloudchef:last-sign-in', 'google');
    const { buttons } = await renderPrompt(null, { title: 'Sign in to CloudChef' });
    expect(buttons[0]).toBe('Continue with GoogleLast used');
    window.localStorage.clear();
  });

  it('asks someone signed in with nowhere to build where their apps should live, not to sign in again', async () => {
    const { text, buttons } = await renderPrompt(signedInWithoutAccount, { title: 'Sign in to open settings.' });
    expect(text).toContain('Where should your apps live?');
    expect(text).toContain("You're signed in as sam@acme.com.");
    expect(text).toContain("In your team's space");
    expect(text).toContain('ask its admin to invite sam@acme.com');
    expect(text).toContain('In your own Cloudflare account');
    expect(text).toContain('Cloudflare bills you for them');
    expect(buttons).toContain('Use my Cloudflare account');
    expect(buttons).toContain('Sign out');
    expect(text).not.toContain('Continue with Google');
    expect(text).not.toContain('What happens next');
  });

  it('offers a space CloudChef runs as a waitlist to join and leave', async () => {
    const { text, buttons } = await renderPrompt(signedInWithoutAccount, { title: 'Sign in to open settings.' });
    expect(text).toContain('In a space CloudChef runs');
    expect(text).toContain('Coming soon');
    expect(text).toContain('No Cloudflare account needed');
    expect(buttons).toContain('Join the waitlist');
    const button = (label: string) =>
      [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    await act(async () => button('Join the waitlist')?.click());
    expect(document.body.textContent).toContain("You're on the waitlist. We'll email sam@acme.com when it opens.");
    await act(async () => button('Leave the waitlist')?.click());
    expect(button('Join the waitlist')).toBeDefined();
  });

  it("says what happens on Cloudflare's site before going there", async () => {
    await renderPrompt(signedInWithoutAccount, { title: 'Sign in to open settings.' });
    const choose = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use my Cloudflare account',
    );
    await act(async () => choose?.click());
    const text = document.body.textContent ?? '';
    expect(text).toContain('What happens next');
    expect(text).toContain('Sign in to Cloudflare, or make a free account there.');
    expect(text).toContain('Workers Paid plan');
    expect(text).toContain('Approve CloudChef. You come straight back here.');
    expect([...document.querySelectorAll('button')].map((button) => button.textContent)).toEqual(
      expect.arrayContaining(['Continue to Cloudflare', 'Back']),
    );
  });

  it('asks for a username first, as GitHub does, with a suggestion that can be saved as it is', async () => {
    await renderPrompt(signedInWithoutAccount, { title: 'Sign in to open settings.' });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Choose your username');
    expect(dialog?.querySelector('input')?.value).toBe('sam');
    expect(dialog?.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false);
    expect(dialog?.querySelector('[aria-label="Close dialog"]')).toBeNull();
  });
});
