import { z } from 'zod';
import { publicOrigin } from '~/lib/.server/public-origin';
import { createAuthSession, getAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { IdentityConflictError } from '~/lib/.server/identity-conflict-error';
import {
  hasSameOrigin,
  readCookie,
  readJsonRequest,
  safeReturnTo,
  serializeCookie,
  withinAddressRateLimit,
} from '~/lib/.server/request-guards';
import { bytesToBase64Url } from '~/lib/hex-digest';

/**
 * Sign in with Google (OpenID Connect, authorization code with PKCE): for people without a Cloudflare
 * login, typically with a company Google Workspace account. Only a verified email is accepted; it is
 * what an organization's invite is addressed to.
 */
export const GOOGLE_RETURN_PATH = '/auth/google/return';
const STATE_COOKIE = 'cloudchef_google_state';
const STATE_TTL_MS = 10 * 60_000;
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const startSchema = z.strictObject({ callbackURL: z.string().max(2_048).optional() });
const tokenSchema = z.looseObject({ access_token: z.string().min(1) });
/** The OpenID userinfo claims CloudChef reads. `hd` is the Workspace domain, absent for gmail.com. */
export const googleUserinfoSchema = z.looseObject({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean(),
  name: z.string().optional(),
  picture: z.url().optional(),
  hd: z.string().optional(),
});

type GoogleFetch = typeof fetch;

export async function startGoogleSignInAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  if (!(await withinAddressRateLimit(env.SIGN_IN_RATE_LIMITER, request))) {
    return Response.json({ error: 'Too many sign-in attempts. Try again shortly.' }, { status: 429 });
  }
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return Response.json({ error: 'Google sign-in is not configured for this environment.' }, { status: 503 });
  }
  const body = await readJsonRequest(request, startSchema, 'Invalid sign-in request.');
  if ('response' in body) {
    return body.response;
  }
  const { callbackURL } = body.data;
  const origin = publicOrigin(request);
  const state = crypto.randomUUID();
  const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO google_sign_in_states (id, code_verifier, return_to, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(state, verifier, safeReturnTo(callbackURL, origin), now + STATE_TTL_MS, now)
    .run();
  const authorizationUrl = new URL(AUTHORIZE_URL);
  authorizationUrl.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID);
  authorizationUrl.searchParams.set('redirect_uri', new URL(GOOGLE_RETURN_PATH, origin).toString());
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', 'openid email profile');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('prompt', 'select_account');
  return Response.json(
    { authorizationUrl: authorizationUrl.toString() },
    { status: 201, headers: { 'Set-Cookie': stateCookie(state, STATE_TTL_MS / 1_000, request) } },
  );
}

export async function completeGoogleSignInAction({
  request,
  env,
  fetchGoogle = fetch,
}: {
  request: Request;
  env: Env;
  fetchGoogle?: GoogleFetch;
}): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state || readCookie(request, STATE_COOKIE) !== state) {
    return Response.json({ error: 'Google sign-in browser state did not match.' }, { status: 400 });
  }
  const now = Date.now();
  // A failure to claim the state, such as D1's, is this sign-in failing like any other below.
  let pending: { code_verifier: string; return_to: string } | null;
  try {
    pending = await env.DB.prepare(
      `UPDATE google_sign_in_states SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?
       RETURNING code_verifier, return_to`,
    )
      .bind(now, state, now)
      .first<{ code_verifier: string; return_to: string }>();
  } catch {
    return signInFailed();
  }
  if (!pending) {
    return Response.json({ error: 'This Google sign-in has expired. Start again.' }, { status: 410 });
  }
  const returnTo = safeReturnTo(pending.return_to, url.origin);
  const code = url.searchParams.get('code');
  if (!code || !env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    // Cancelled at Google, or misconfigured: back where they started, signed out.
    return redirect(new URL(returnTo, url.origin), stateCookie('', 0, request));
  }
  try {
    const tokenResponse = await fetchGoogle(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: new URL(GOOGLE_RETURN_PATH, publicOrigin(request)).toString(),
        code_verifier: pending.code_verifier,
      }),
    });
    if (!tokenResponse.ok) {
      return Response.json({ error: 'Google did not accept the sign-in. Start again.' }, { status: 400 });
    }
    const { access_token } = tokenSchema.parse(await tokenResponse.json());
    const infoResponse = await fetchGoogle(USERINFO_URL, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!infoResponse.ok) {
      return Response.json({ error: 'Google did not share your account details.' }, { status: 502 });
    }
    const info = googleUserinfoSchema.parse(await infoResponse.json());
    if (!info.email_verified) {
      return Response.json({ error: 'Your Google account email is not verified.' }, { status: 403 });
    }
    const signedIn = await getAuthSession(env, request);
    const user = await upsertVerifiedEmailUser(
      env.DB,
      { email: info.email, name: info.name, image: info.picture, googleSubject: info.sub },
      Date.now(),
      signedIn?.user.id ?? null,
    );
    const session = await prepareAuthSession(user.id, request);
    const cookie = await createAuthSession(env, session);
    const response = redirect(new URL(returnTo, url.origin), cookie);
    response.headers.append('Set-Cookie', stateCookie('', 0, request));
    return response;
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof z.ZodError) {
      return Response.json({ error: 'Google returned an unexpected response.' }, { status: 502 });
    }
    return signInFailed();
  }
}

/** Nothing about the request or what Google returned is logged. */
function signInFailed(): Response {
  console.error('Google sign-in failed');
  return Response.json({ error: 'Google sign-in failed.' }, { status: 500 });
}

function redirect(location: URL, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location.toString(), 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
  });
}

function stateCookie(value: string, maxAge: number, request: Request): string {
  return serializeCookie({ name: STATE_COOKIE, value, path: GOOGLE_RETURN_PATH, maxAge, request });
}
