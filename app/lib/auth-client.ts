import { createClientOnlyFn } from '@tanstack/react-start';
import { useEffect, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { disposeClientCollections } from '~/lib/cloudflare/client-collections';
import { rememberTabWorkspace, resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { captureProductEvent } from '~/lib/telemetry.client';
import {
  CLOUDFLARE_AUTHORIZATION_ERROR_PARAM,
  CLOUDFLARE_CONNECT_MESSAGE_PARAM,
} from '~/lib/cloudflare/authorization-recovery';
import { clearPendingSubmit, recordPendingSubmit } from '~/lib/stores/pending-submit';
import { leavePage } from '~/lib/hooks/useUnsavedEditsGuard';
import { noContentSchema, postJson, RequestError } from '~/lib/json-request';

const captureCloudflareConnectStarted = createClientOnlyFn(() => {
  void captureProductEvent('cloudflare_connect_started');
});

type AuthState = {
  data: CloudflareAuthSession | null;
  isPending: boolean;
  /** Set when the session couldn't be checked: not the same as being signed out. */
  error: string | null;
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

const authorizationStartSchema = z.object({ authorizationUrl: z.string() });

/** Refused until the person signs in again (Cloudflare, Google or an emailed link): their session is too old. */
export class ReauthenticationRequiredError extends Error {}

const listeners = new Set<() => void>();
const serverSnapshot: AuthState = { data: null, isPending: true, error: null };
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
      setState({ data: session.success ? session.data : null, isPending: false, error: null });
      rememberTabWorkspace(session.success ? (session.data.context?.connectionId ?? null) : null);
    })
    // A failed check keeps what was known (nothing, on a first load) and says so, rather than looking signed out.
    .catch(() => setState({ data: state.data, isPending: false, error: "Couldn't check your session." }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Checks the session again, after a failed check. */
export function retrySession() {
  setState({ ...state, isPending: true, error: null });
  void loadSession();
}

/** Loads the session again after a change it reflects, such as a team's new name in `contexts`. */
export async function refreshSession() {
  // A check already under way may have started before the change, so this one follows it.
  await loading;
  await loadSession();
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
 *
 * Resolves false when the person stays for edits not yet saved; otherwise the page is leaving.
 */
export function signInWithCloudflare(
  callbackURL = window.location.href,
  options: { continuePrompt?: string; organizationId?: string } = {},
): Promise<boolean> {
  return leavePage(() => startCloudflareAuthorization(callbackURL, options));
}

async function startCloudflareAuthorization(
  callbackURL: string,
  options: { continuePrompt?: string; organizationId?: string },
) {
  captureCloudflareConnectStarted();
  clearPendingSubmit();
  if (options.continuePrompt) {
    recordPendingSubmit(options.continuePrompt);
  }
  try {
    const { authorizationUrl } = await postJson(
      '/api/cloudflare/connection/start',
      { callbackURL, organizationId: options.organizationId },
      authorizationStartSchema,
      'Unable to start Cloudflare authorization.',
    );
    window.location.assign(authorizationUrl);
  } catch (error) {
    // An authorization that never started must not leave an instruction waiting to resume.
    clearPendingSubmit();
    throw error instanceof RequestError && error.code === 'reauthentication_required'
      ? new ReauthenticationRequiredError(error.message)
      : error;
  }
}

/**
 * Sign in with Google: for people without a Cloudflare login, such as members of an organization. Resolves
 * false when the person stays for edits not yet saved; otherwise the page is leaving.
 */
export function signInWithGoogle(callbackURL = window.location.href): Promise<boolean> {
  return leavePage(() => startGoogleSignIn(callbackURL));
}

async function startGoogleSignIn(callbackURL: string) {
  clearPendingSubmit();
  const { authorizationUrl } = await postJson(
    '/api/auth/google/start',
    { callbackURL },
    authorizationStartSchema,
    'Unable to start Google sign-in.',
  );
  window.location.assign(authorizationUrl);
}

/** Emails a one-time sign-in link to `email`; the link returns to `callbackURL`. */
export async function requestEmailSignInLink(email: string, callbackURL = window.location.href) {
  clearPendingSubmit();
  await postJson('/api/auth/email/start', { email, callbackURL }, z.looseObject({}), 'Unable to send a sign-in link.');
}

/** The address an emailed sign-in link is for, without using it up. */
export async function describeEmailSignIn(token: string): Promise<string> {
  const { email } = await postJson(
    '/api/auth/email/describe',
    { token },
    z.object({ email: z.string() }),
    'This sign-in link is not valid.',
  );
  return email;
}

/** Completes a sign-in from an emailed link; returns where to go next. */
export async function completeEmailSignIn(token: string): Promise<string> {
  const { returnTo } = await postJson(
    '/api/auth/email/complete',
    { token },
    z.object({ returnTo: z.string() }).catch({ returnTo: '/' }),
    'Unable to sign in with this link.',
  );
  return returnTo;
}

/**
 * Switches to another Cloudflare account this person builds in (their own, or an organization's).
 * Chats and the workspace belong to one account, so everything loaded for the current one is
 * dropped and the builder reopens. Resolves false, switching nothing, when the person stays for edits not
 * yet saved.
 */
export function switchWorkspace(connectionId: string): Promise<boolean> {
  return leavePage(() => switchAndReopen(connectionId));
}

async function switchAndReopen(connectionId: string) {
  await postJson('/api/context', { connectionId }, noContentSchema, 'Unable to switch accounts.');
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
      requested.searchParams.delete(CLOUDFLARE_CONNECT_MESSAGE_PARAM);
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

/** Resolves false, still signed in, when the person stays for edits not yet saved. */
export function signOutOfCloudChef(callbackURL = window.location.origin): Promise<boolean> {
  return leavePage(() => signOutAndLeave(callbackURL));
}

async function signOutAndLeave(callbackURL: string) {
  await postJson('/api/auth/sign-out', {}, noContentSchema, 'Unable to sign out of CloudChef.');
  setState({ data: null, isPending: false, error: null });
  await disposeClientCollections();
  resetUserRuntimeSession();
  clearPendingSubmit();
  window.location.assign(callbackURL);
}
