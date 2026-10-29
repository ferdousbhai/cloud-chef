import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  controlPlaneDatabase,
  createProvenEmailUser,
  envWith,
  inviteToTeam,
  withStatementHook,
} from '~/test/control-plane-d1';
import { getAuthSession } from '~/lib/.server/auth';
import { z } from 'zod';
import {
  completeGoogleSignInAction,
  GOOGLE_RETURN_PATH,
  type googleUserinfoSchema,
  startGoogleSignInAction,
} from './google-auth';

const ORIGIN = 'https://cloudchef.build';

function setup() {
  const { database, db } = controlPlaneDatabase();
  const env = {
    DB: db,
    SIGN_IN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  };
  return { database, env: envWith(env) };
}

/** Google's token and userinfo endpoints, answering with these claims. */
function google(claims: Partial<z.input<typeof googleUserinfoSchema>>) {
  const fetchGoogle = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'access', token_type: 'Bearer' });
    }
    return Response.json(claims);
  });
  vi.stubGlobal('fetch', fetchGoogle);
  return fetchGoogle;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function start(env: Env) {
  const response = await startGoogleSignInAction({
    request: new Request(`${ORIGIN}/api/auth/google/start`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callbackURL: `${ORIGIN}/settings` }),
    }),
    env,
  });
  const { authorizationUrl } = z.object({ authorizationUrl: z.string() }).parse(await response.json());
  const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
  return { response, authorizationUrl: new URL(authorizationUrl), state };
}

function callback(state: string, cookieState = state, code = 'code') {
  return new Request(`${ORIGIN}${GOOGLE_RETURN_PATH}?state=${state}&code=${code}`, {
    headers: { cookie: `cloudchef_google_state=${cookieState}` },
  });
}

async function sessionFrom(env: Env, response: Response) {
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  return getAuthSession(env, new Request(ORIGIN, { headers: { cookie } }));
}

describe('Google sign-in', () => {
  it('asks Google for a verified identity with PKCE, then signs in a person a team invited', async () => {
    const { env, database } = setup();
    await inviteToTeam(env.DB, 'sam@acme.com');
    const { response, authorizationUrl, state } = await start(env);
    expect(response.status).toBe(201);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('scope')).toBe('openid email profile');
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_RETURN_PATH}`);

    const fetchGoogle = google({
      sub: 'g-1',
      email: 'Sam@Acme.com',
      email_verified: true,
      name: 'Sam',
      hd: 'acme.com',
    });
    const done = await completeGoogleSignInAction({ request: callback(state), env });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${ORIGIN}/settings`);
    const tokenBody = String(fetchGoogle.mock.calls[0][1]?.body);
    expect(tokenBody).toContain('code_verifier=');

    const session = await sessionFrom(env, done);
    expect(session?.user).toMatchObject({ email: 'sam@acme.com', name: 'Sam' });
    expect(database.prepare('SELECT google_subject FROM "user" WHERE email = ?').get('sam@acme.com')).toEqual({
      google_subject: 'g-1',
    });

    // The state is used once.
    const replay = await completeGoogleSignInAction({ request: callback(state), env });
    expect(replay.status).toBe(410);
  });

  it('signs in the existing account that has the Google address', async () => {
    const { env, database } = setup();
    const sam = await createProvenEmailUser(env.DB, 'sam@acme.com');
    const { state } = await start(env);
    google({ sub: 'g-1', email: 'Sam@acme.com', email_verified: true, name: 'Sam' });
    const done = await completeGoogleSignInAction({ request: callback(state), env });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${ORIGIN}/settings`);
    expect((await sessionFrom(env, done))?.user.id).toBe(sam.id);
    expect(database.prepare('SELECT google_subject FROM "user" WHERE id = ?').get(sam.id)).toEqual({
      google_subject: 'g-1',
    });
  });

  it('signs no one in for a Google account with no CloudChef account and no invite, and says why', async () => {
    const { env, database } = setup();
    const { state } = await start(env);
    google({ sub: 'g-9', email: 'nobody@acme.com', email_verified: true });
    const refused = await completeGoogleSignInAction({ request: callback(state), env });
    expect(refused.status).toBe(303);
    expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?sign_in=no_account`);
    expect(refused.headers.get('set-cookie')).not.toContain('cloudchef_session=');
    expect(await sessionFrom(env, refused)).toBeNull();
    expect(database.prepare('SELECT COUNT(*) AS users FROM "user"').get()).toEqual({ users: 0 });
  });

  it('finds the same user when their Google email changes', async () => {
    const { env } = setup();
    await inviteToTeam(env.DB, 'old@acme.com');
    const first = await start(env);
    google({ sub: 'g-1', email: 'old@acme.com', email_verified: true });
    const one = await completeGoogleSignInAction({
      request: callback(first.state),
      env,
    });
    const second = await start(env);
    google({ sub: 'g-1', email: 'new@acme.com', email_verified: true });
    const two = await completeGoogleSignInAction({
      request: callback(second.state),
      env,
    });
    expect((await sessionFrom(env, two))?.user.id).toBe((await sessionFrom(env, one))?.user.id);
  });

  it('refuses an unverified email, a different browser, and an email tied to another Google account', async () => {
    const { env, database } = setup();
    const unverified = await start(env);
    google({ sub: 'g-1', email: 'sam@acme.com', email_verified: false });
    const refused = await completeGoogleSignInAction({
      request: callback(unverified.state),
      env,
    });
    expect(refused.status).toBe(403);

    const otherBrowser = await start(env);
    google({});
    const mismatch = await completeGoogleSignInAction({
      request: callback(otherBrowser.state, 'someone-else'),
      env,
    });
    expect(mismatch.status).toBe(400);

    database
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, google_subject)
         VALUES ('user-1', 'Sam', 'sam@acme.com', 1, 1, 1, 'g-1')`,
      )
      .run();
    const conflict = await start(env);
    google({ sub: 'g-2', email: 'sam@acme.com', email_verified: true });
    const taken = await completeGoogleSignInAction({
      request: callback(conflict.state),
      env,
    });
    expect(taken.status).toBe(409);
  });

  it('answers a sign-in whose state D1 fails to claim as a failed sign-in, not a route error', async () => {
    const { env } = setup();
    const { state } = await start(env);
    const failing = withStatementHook(env.DB, (query) => {
      if (query.includes('UPDATE google_sign_in_states')) {
        throw new Error('D1_ERROR: storage operation exceeded timeout');
      }
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchGoogle = google({});
    const failed = await completeGoogleSignInAction({
      request: callback(state),
      env: { ...env, DB: failing },
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Google sign-in failed.' });
    expect(logged).toHaveBeenCalledWith('Google sign-in failed');
    expect(fetchGoogle).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("has Google return to CloudChef's own address, whichever hostname the request reached", async () => {
    const { env } = setup();
    const preview = 'https://0123abcd-cloudchef.example.workers.dev';
    const response = await startGoogleSignInAction({
      request: new Request(`${preview}/api/auth/google/start`, {
        method: 'POST',
        headers: { Origin: preview, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env,
    });
    const { authorizationUrl } = z.object({ authorizationUrl: z.string() }).parse(await response.json());
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_RETURN_PATH}`);
  });

  it('reports itself unavailable without a Google client', async () => {
    const { env } = setup();
    const response = await startGoogleSignInAction({
      request: new Request(`${ORIGIN}/api/auth/google/start`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      }),
      env: { ...env, GOOGLE_OAUTH_CLIENT_ID: '' },
    });
    expect(response.status).toBe(503);
  });
});
