import { createClientOnlyFn } from '@tanstack/react-start';
import { useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { disposeClientCollections } from '~/lib/cloudflare/client-collections';
import { rememberTabWorkspace, resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { captureProductEvent } from '~/lib/telemetry.client';
import { CLOUDFLARE_AUTHORIZATION_ERROR_PARAM } from '~/lib/cloudflare/authorization-recovery';
import { clearPendingSubmit, recordPendingSubmit } from '~/lib/stores/pending-submit';

const captureCloudflareConnectStarted = createClientOnlyFn(() => {
  void captureProductEvent('cloudflare_connect_started');
});

type AuthState = {
  data: CloudflareAuthSession | null;
  isPending: boolean;
};

const workspaceContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal'), connectionId: z.string(), accountName: z.string().nullable() }),
  z.object({
    kind: z.literal('organization'),
    connectionId: z.string(),
    accountName: z.string().nullable(),
    orgId: z.string(),
    orgName: z.string(),
    role: z.enum(['admin', 'member']),
    draftsAllowed: z.boolean(),
  }),
]);

/** Typed against the server contract, so a drift in `CloudflareAuthSession` fails to compile here. */
const cloudflareAuthSessionSchema: z.ZodType<CloudflareAuthSession> = z.object({
  session: z.object({
    id: z.string(),
    userId: z.string(),
    expiresAt: z.number(),
    createdAt: z.number(),
  }),
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
  }),
  context: workspaceContextSchema.nullable(),
  contexts: z.array(workspaceContextSchema),
});

const authorizationStartSchema = z.looseObject({
  authorizationUrl: z.string().optional().catch(undefined),
  code: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

/** Refused until the person signs in again (Cloudflare, Google or an emailed link): their session is too old. */
export class ReauthenticationRequiredError extends Error {}

const requestErrorSchema = z.looseObject({ error: z.string().optional().catch(undefined) });

const listeners = new Set<() => void>();
const serverSnapshot: AuthState = { data: null, isPending: true };
let state: AuthState = serverSnapshot;
let loading: Promise<void> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: AuthState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

async function loadSession() {
  if (loading) {
    return loading;
  }
  loading = fetch('/api/auth/session', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error('Unable to load the Cloudflare session.');
      }
      const session = cloudflareAuthSessionSchema.safeParse(await response.json());
      setState({ data: session.success ? session.data : null, isPending: false });
      rememberTabWorkspace(session.success ? (session.data.context?.connectionId ?? null) : null);
    })
    .catch(() => setState({ data: null, isPending: false }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

export const authClient = {
  useSession() {
    const snapshot = useSyncExternalStore(
      subscribe,
      () => state,
      () => serverSnapshot,
    );
    useEffect(() => {
      void loadSession();
    }, []);
    return snapshot;
  },
};

/**
 * `continuePrompt` is the submit this connection was asked for, and the only thing that may
 * resume one. Every other connect start — settings, the account card, a bare sign-in screen —
 * clears any pending continuation here, so returning from one of those can never start a
 * build the person did not ask for in that moment.
 */
export async function signInWithCloudflare(
  callbackURL = window.location.href,
  options: { continuePrompt?: string; organizationId?: string } = {},
) {
  captureCloudflareConnectStarted();
  clearPendingSubmit();
  if (options.continuePrompt) {
    recordPendingSubmit(options.continuePrompt);
  }
  try {
    const response = await fetch('/api/cloudflare/connection/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callbackURL, organizationId: options.organizationId }),
    });
    const parsed = authorizationStartSchema.safeParse(await response.json().catch(() => null));
    const payload = parsed.success ? parsed.data : null;
    if (!response.ok || !payload?.authorizationUrl) {
      const message = payload?.error ?? 'Unable to start Cloudflare authorization.';
      throw payload?.code === 'reauthentication_required'
        ? new ReauthenticationRequiredError(message)
        : new Error(message);
    }
    window.location.assign(payload.authorizationUrl);
  } catch (error) {
    // An authorization that never started must not leave an instruction waiting to resume.
    clearPendingSubmit();
    throw error;
  }
}

/** Sign in with Google: for people without a Cloudflare login, such as members of an organization. */
export async function signInWithGoogle(callbackURL = window.location.href) {
  clearPendingSubmit();
  const response = await fetch('/api/auth/google/start', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackURL }),
  });
  const parsed = authorizationStartSchema.safeParse(await response.json().catch(() => null));
  const payload = parsed.success ? parsed.data : null;
  if (!response.ok || !payload?.authorizationUrl) {
    throw new Error(payload?.error ?? 'Unable to start Google sign-in.');
  }
  window.location.assign(payload.authorizationUrl);
}

/** Emails a one-time sign-in link to `email`; the link returns to `callbackURL`. */
export async function requestEmailSignInLink(email: string, callbackURL = window.location.href) {
  clearPendingSubmit();
  const response = await fetch('/api/auth/email/start', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, callbackURL }),
  });
  if (!response.ok) {
    const parsed = requestErrorSchema.safeParse(await response.json().catch(() => null));
    throw new Error((parsed.success ? parsed.data.error : undefined) ?? 'Unable to send a sign-in link.');
  }
}

/** The address an emailed sign-in link is for, without using it up. */
export async function describeEmailSignIn(token: string): Promise<string> {
  const response = await fetch('/api/auth/email/describe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = requestErrorSchema.safeParse(body);
    throw new Error((parsed.success ? parsed.data.error : undefined) ?? 'This sign-in link is not valid.');
  }
  return z.object({ email: z.string() }).parse(body).email;
}

/** Completes a sign-in from an emailed link; returns where to go next. */
export async function completeEmailSignIn(token: string): Promise<string> {
  const response = await fetch('/api/auth/email/complete', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = requestErrorSchema.safeParse(body);
    throw new Error((parsed.success ? parsed.data.error : undefined) ?? 'Unable to sign in with this link.');
  }
  const parsed = z.object({ returnTo: z.string() }).safeParse(body);
  return parsed.success ? parsed.data.returnTo : '/';
}

/**
 * Switches to another Cloudflare account this person builds in (their own, or an organization's).
 * Chats and the workspace belong to one account, so everything loaded for the current one is
 * dropped and the builder reopens.
 */
export async function switchWorkspace(connectionId: string) {
  const response = await fetch('/api/context', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId }),
  });
  if (!response.ok) {
    const parsed = requestErrorSchema.safeParse(await response.json().catch(() => null));
    throw new Error((parsed.success ? parsed.data.error : undefined) ?? 'Unable to switch accounts.');
  }
  await disposeClientCollections();
  resetUserRuntimeSession();
  clearPendingSubmit();
  window.location.assign('/');
}

export function createCloudflareReturnURL(returnURL = window.location.href, origin = window.location.origin): string {
  const expectedOrigin = new URL(origin).origin;
  try {
    const requested = new URL(returnURL, expectedOrigin);
    if (requested.origin === expectedOrigin && !requested.pathname.startsWith('//')) {
      requested.searchParams.delete(CLOUDFLARE_AUTHORIZATION_ERROR_PARAM);
      if (requested.pathname === '/settings') {
        const continuation = requested.searchParams.get('continue');
        if (continuation && continuation.startsWith('/') && !continuation.startsWith('//')) {
          const target = new URL(continuation, expectedOrigin);
          if (target.origin === expectedOrigin && !target.pathname.startsWith('//')) {
            return target.toString();
          }
        }
        requested.searchParams.delete('continue');
      }
      return requested.toString();
    }
  } catch {
    // Invalid and external destinations return to the public builder.
  }
  return `${expectedOrigin}/`;
}

export async function signOutOfCloudChef(callbackURL = window.location.origin) {
  const response = await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) {
    const parsed = requestErrorSchema.safeParse(await response.json().catch(() => null));
    throw new Error((parsed.success ? parsed.data.error : undefined) ?? 'Unable to sign out of CloudChef.');
  }
  setState({ data: null, isPending: false });
  await disposeClientCollections();
  resetUserRuntimeSession();
  clearPendingSubmit();
  window.location.assign(callbackURL);
}
