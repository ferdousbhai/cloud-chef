import { describe, expect, it, vi } from 'vitest';
import { controlPlaneDatabase, envWith, sessionCookieSignedInBefore } from '~/test/control-plane-d1';
import { createAuthSession, getAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import type { CloudflareOAuthOrchestrator } from '~/lib/.server/cloudflare/cloudflare-oauth-orchestrator';
import { completeCloudflareConnectionAction, startCloudflareConnectionAction } from './cloudflare-integration';

const ORIGIN = 'https://cloudchef.build';
const HOUR = 60 * 60_000;

/** Cloudflare's side of the OAuth exchange, answering as the Cloudflare login `subject`. */
function cloudflareAs(subject: string): Pick<CloudflareOAuthOrchestrator, 'startConnection' | 'completeConnection'> {
  return {
    startConnection: vi.fn(async () => ({
      sessionId: 'provider-session',
      authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?client_id=test',
      expiresAt: Date.now() + 60_000,
    })),
    completeConnection: vi.fn(async () => ({
      user: { subject, email: 'sam@corp.com', name: 'Sam', picture: null },
      accountId: 'account-1',
      accountName: 'Sam',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: Date.now() + HOUR,
      grantedOAuthScopes: ['workers-scripts.write'],
    })),
  };
}

async function setup() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({
    DB: db,
    CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CLOUDFLARE_OAUTH_CLIENT_ID: 'client-1',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'client-secret',
    CLOUDFLARE_OAUTH_START_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const user = await upsertVerifiedEmailUser(db, { email: 'sam@corp.com' });
  // Signed in an hour ago: too long ago for export or erasure.
  const cookie = await sessionCookieSignedInBefore(env, user.id, HOUR);
  return { database, db, env, user, cookie };
}

/** Starts a connection while signed in, then comes back from Cloudflare as `orchestrator`'s login. */
async function connect(
  env: Env,
  cookie: string,
  orchestrator: Pick<CloudflareOAuthOrchestrator, 'startConnection' | 'completeConnection'>,
) {
  const started = await startCloudflareConnectionAction({
    request: new Request(`${ORIGIN}/api/cloudflare/connection/start`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ callbackURL: `${ORIGIN}/settings` }),
    }),
    env,
    orchestrator,
  });
  if (started.status !== 201) {
    return started;
  }
  const state = /cloudchef_oauth_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return completeCloudflareConnectionAction({
    request: new Request(`${ORIGIN}/connect/return?state=${state}&code=code`, {
      headers: { cookie: `${cookie}; cloudchef_oauth_state=${state}` },
    }),
    env,
    orchestrator,
  });
}

describe('connecting Cloudflare while signed in', () => {
  it('counts reconnecting the Cloudflare login already on the account as a fresh sign-in', async () => {
    const { database, env, user, cookie } = await setup();
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-sam', user.id);

    const response = await connect(env, cookie, cloudflareAs('cf-sam'));
    expect(response.status).toBe(303);
    const fresh = /cloudchef_session=[^;]+/.exec(response.headers.get('set-cookie') ?? '')?.[0] ?? '';
    expect(fresh).not.toBe('');
    const session = await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: fresh } }));
    expect(session?.user.id).toBe(user.id);
    expect(Date.now() - (session?.session.createdAt ?? 0)).toBeLessThan(60_000);
    // The old session is gone.
    expect(await getAuthSession(env, new Request(ORIGIN, { headers: { cookie } }))).toBeNull();
  });

  it('says the account is connected when the session ended before the return, and sends the browser to Settings', async () => {
    const { database, env, user, cookie } = await setup();
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-sam', user.id);
    const orchestrator = cloudflareAs('cf-sam');
    const started = await startCloudflareConnectionAction({
      request: new Request(`${ORIGIN}/api/cloudflare/connection/start`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ callbackURL: `${ORIGIN}/chat/project-1` }),
      }),
      env,
      orchestrator,
    });
    const state = /cloudchef_oauth_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';

    // Back from Cloudflare with only the authorization's browser state: the session cookie is gone.
    const response = await completeCloudflareConnectionAction({
      request: new Request(`${ORIGIN}/connect/return?state=${state}&code=code`, {
        headers: { cookie: `cloudchef_oauth_state=${state}` },
      }),
      env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/settings');
    expect(location.searchParams.get('continue')).toBe('/chat/project-1');
    expect(location.searchParams.get('cloudflare_message')).toBe('session_ended');
    expect(response.headers.get('set-cookie')).not.toContain('cloudchef_session=');
    expect(database.prepare('SELECT status FROM cloudflare_connections WHERE user_id = ?').get(user.id)).toEqual({
      status: 'active',
    });
  });

  it('asks for a recent sign-in before attaching a new Cloudflare login, and never issues a session for one', async () => {
    const { env, cookie } = await setup();
    const refused = await connect(env, cookie, cloudflareAs('cf-new'));
    expect(refused.status).toBe(401);
  });

  it("names a Cloudflare login that is someone else's by a code, not by the error's own words", async () => {
    const { database, db, env, user } = await setup();
    const other = await upsertVerifiedEmailUser(db, { email: 'kim@corp.com' });
    database.prepare('UPDATE "user" SET cloudflare_subject = ? WHERE id = ?').run('cf-sam', other.id);
    const recent = (await createAuthSession(env, user.id, new Request('https://cloudchef.build/'))).cookie.split(
      ';',
    )[0];

    const response = await connect(env, recent, cloudflareAs('cf-sam'));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('cloudflare_message')).toBe('login_linked_elsewhere');
  });
});
