import { getAuthSession, type CloudflareAuthSession } from '~/lib/.server/auth';

/**
 * Account-wide operations are accepted only from a session created by a fresh sign-in:
 * Cloudflare (including reconnecting the Cloudflare login already on the account), Google, or an
 * emailed link. Each issues a new session, which is the re-authentication proof this window
 * checks. Attaching a new Cloudflare login or connecting an organization keeps the old session.
 *
 * Erasure is irreversible. A bulk export is not destructive, but one response hands over
 * every operator-held record about a person — identity, email, connected Cloudflare
 * account, granted scopes, runtime address, and sign-in history — in a file that is then
 * kept and forwarded. A borrowed session must reach neither more easily than the other,
 * so both gates deliberately share this one window. Deleting a team, irreversible for all its
 * members, asks for the same.
 */
export const ACCOUNT_REAUTHENTICATION_WINDOW_MS = 10 * 60_000;

/** Returns the re-authenticated session, or the Response that refuses the request. */
export async function requireRecentlyAuthenticatedSession(
  env: Env,
  request: Request,
  reauthenticationMessage: string,
): Promise<CloudflareAuthSession | Response> {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
  }
  return isRecentSignIn(session) ? session : reauthenticationRequired(reauthenticationMessage);
}

/** Whether `session` came from a sign-in within the window. */
export function isRecentSignIn(session: CloudflareAuthSession): boolean {
  return Date.now() - session.session.createdAt <= ACCOUNT_REAUTHENTICATION_WINDOW_MS;
}

/** The refusal the client answers by offering a fresh sign-in. */
export function reauthenticationRequired(message: string): Response {
  return Response.json(
    { code: 'reauthentication_required', error: message },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}
