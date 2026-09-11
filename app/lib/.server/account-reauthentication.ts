import { getAuthSession, type CloudflareAuthSession } from '~/lib/.server/auth';

/**
 * Account-wide operations are accepted only from a session that was created by a fresh
 * Cloudflare sign-in. Reconnecting Cloudflare issues a new session, which is the
 * re-authentication proof this window checks.
 *
 * Erasure is irreversible. A bulk export is not destructive, but one response hands over
 * every operator-held record about a person — identity, email, connected Cloudflare
 * account, granted scopes, runtime address, and sign-in history — in a file that is then
 * kept and forwarded. A borrowed session must reach neither more easily than the other,
 * so both gates deliberately share this one window.
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
  if (Date.now() - session.session.createdAt > ACCOUNT_REAUTHENTICATION_WINDOW_MS) {
    return Response.json(
      { code: 'reauthentication_required', error: reauthenticationMessage },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return session;
}
