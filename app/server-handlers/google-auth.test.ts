import { describe, expect, it, vi } from 'vitest';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
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
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'access', token_type: 'Bearer' });
    }
    return Response.json(claims);
  });
}

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
  it('asks Google for a verified identity with PKCE, then signs in', async () => {
    const { env, database } = setup();
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
    const done = await completeGoogleSignInAction({ request: callback(state), env, fetchGoogle });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${ORIGIN}/settings`);
    const tokenBody = String(fetchGoogle.mock.calls[0][1]?.body);
    expect(tokenBody).toContain('code_verifier=');

    const session = await sessionFrom(env, done);
    expect(session?.user).toMatchObject({ email: 'sam@acme.com', name: 'Sam' });
    expect(database.prepare('SELECT google_subject FROM "user"').get()).toEqual({ google_subject: 'g-1' });

    // The state is used once.
    const replay = await completeGoogleSignInAction({ request: callback(state), env, fetchGoogle });
    expect(replay.status).toBe(410);
  });

  it('finds the same user when their Google email changes', async () => {
    const { env } = setup();
    const first = await start(env);
    const one = await completeGoogleSignInAction({
      request: callback(first.state),
      env,
      fetchGoogle: google({ sub: 'g-1', email: 'old@acme.com', email_verified: true }),
    });
    const second = await start(env);
    const two = await completeGoogleSignInAction({
      request: callback(second.state),
      env,
      fetchGoogle: google({ sub: 'g-1', email: 'new@acme.com', email_verified: true }),
    });
    expect((await sessionFrom(env, two))?.user.id).toBe((await sessionFrom(env, one))?.user.id);
  });

  it('refuses an unverified email, a different browser, and an email tied to another Google account', async () => {
    const { env, database } = setup();
    const unverified = await start(env);
    const refused = await completeGoogleSignInAction({
      request: callback(unverified.state),
      env,
      fetchGoogle: google({ sub: 'g-1', email: 'sam@acme.com', email_verified: false }),
    });
    expect(refused.status).toBe(403);

    const otherBrowser = await start(env);
    const mismatch = await completeGoogleSignInAction({
      request: callback(otherBrowser.state, 'someone-else'),
      env,
      fetchGoogle: google({}),
    });
    expect(mismatch.status).toBe(400);

    database
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, google_subject)
         VALUES ('user-1', 'Sam', 'sam@acme.com', 1, 1, 1, 'g-1')`,
      )
      .run();
    const conflict = await start(env);
    const taken = await completeGoogleSignInAction({
      request: callback(conflict.state),
      env,
      fetchGoogle: google({ sub: 'g-2', email: 'sam@acme.com', email_verified: true }),
    });
    expect(taken.status).toBe(409);
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
