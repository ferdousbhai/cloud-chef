import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { getAuthSession } from '~/lib/.server/auth';
import {
  completeEmailSignInAction,
  describeEmailSignInAction,
  EMAIL_SIGN_IN_LINKS_PER_HOUR,
  startEmailSignInAction,
} from './email-auth';

const ORIGIN = 'https://cloudchef.build';

function setup() {
  const { database, db } = controlPlaneDatabase();
  const sent: string[] = [];
  const env = {
    DB: db,
    SIGN_IN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    SIGN_IN_EMAIL: {
      send: async (message: EmailMessage | EmailMessageBuilder) => {
        sent.push(JSON.stringify(message));
        return { messageId: 'm' };
      },
    },
  };
  return { database, env: envWith(env), sent };
}

function post(path: string, body: Record<string, string>, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function tokenFrom(text: string): string {
  const match = /token=([\w-]+)/.exec(text);
  if (!match) {
    throw new Error('no sign-in link in the email');
  }
  return match[1];
}

describe('email sign-in', () => {
  it('emails a one-time link that signs in a new user without a Cloudflare connection', async () => {
    const { env, sent } = setup();
    const start = await startEmailSignInAction({
      request: post('/api/auth/email/start', { email: 'Sam@Example.com', callbackURL: `${ORIGIN}/chat/1` }),
      env,
    });
    expect(start.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"to":"sam@example.com"');

    const token = tokenFrom(sent[0]);
    const complete = await completeEmailSignInAction({ request: post('/api/auth/email/complete', { token }), env });
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toEqual({ returnTo: '/chat/1' });
    const cookie = complete.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('cloudchef_session=');

    const session = await getAuthSession(env, new Request(ORIGIN, { headers: { cookie: cookie.split(';')[0] } }));
    expect(session?.user.email).toBe('sam@example.com');
    expect(session?.context).toBeNull();

    // The link works once.
    const again = await completeEmailSignInAction({ request: post('/api/auth/email/complete', { token }), env });
    expect(again.status).toBe(410);
  });

  it("emails a link to CloudChef's own address, whichever hostname the request reached", async () => {
    const { env, sent } = setup();
    const preview = 'https://0123abcd-cloudchef.example.workers.dev';
    const start = await startEmailSignInAction({
      request: new Request(`${preview}/api/auth/email/start`, {
        method: 'POST',
        headers: { Origin: preview, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sam@example.com' }),
      }),
      env,
    });
    expect(start.status).toBe(202);
    expect(sent[0]).toContain(`${ORIGIN}/sign-in/email?token=`);
    expect(sent[0]).not.toContain('workers.dev');
  });

  it('says which address a link is for without using it up', async () => {
    const { env, sent } = setup();
    await startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'sam@example.com' }), env });
    const token = tokenFrom(sent[0]);
    const described = await describeEmailSignInAction({ request: post('/api/auth/email/describe', { token }), env });
    await expect(described.json()).resolves.toEqual({ email: 'sam@example.com' });
    const complete = await completeEmailSignInAction({ request: post('/api/auth/email/complete', { token }), env });
    expect(complete.status).toBe(200);
  });

  it('signs an existing Cloudflare user in by their email, once CloudChef has proven it', async () => {
    const { database, env, sent } = setup();
    database
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cloudflare_subject, email_proven_at)
         VALUES ('user-1', 'Ada', 'ada@example.com', 1, 1, 1, 'cf-1', 1)`,
      )
      .run();
    await startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'ada@example.com' }), env });
    const complete = await completeEmailSignInAction({
      request: post('/api/auth/email/complete', { token: tokenFrom(sent[0]) }),
      env,
    });
    const session = await getAuthSession(
      env,
      new Request(ORIGIN, { headers: { cookie: (complete.headers.get('set-cookie') ?? '').split(';')[0] } }),
    );
    expect(session?.user.id).toBe('user-1');
  });

  it('refuses an expired link', async () => {
    const { database, env, sent } = setup();
    await startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'sam@example.com' }), env });
    database.prepare('UPDATE email_sign_in_tokens SET expires_at = 0').run();
    const complete = await completeEmailSignInAction({
      request: post('/api/auth/email/complete', { token: tokenFrom(sent[0]) }),
      env,
    });
    expect(complete.status).toBe(410);
  });

  it('stops sending to one address after the hourly limit, without saying so', async () => {
    const { env, sent } = setup();
    for (let i = 0; i <= EMAIL_SIGN_IN_LINKS_PER_HOUR; i++) {
      const response = await startEmailSignInAction({
        request: post('/api/auth/email/start', { email: 'sam@example.com' }),
        env,
      });
      expect(response.status).toBe(202);
    }
    expect(sent).toHaveLength(EMAIL_SIGN_IN_LINKS_PER_HOUR);
  });

  it('rejects other origins and bad addresses', async () => {
    const { env, sent } = setup();
    const foreign = await startEmailSignInAction({
      request: post('/api/auth/email/start', { email: 'sam@example.com' }, 'https://attacker.example'),
      env,
    });
    expect(foreign.status).toBe(403);
    const bad = await startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'nope' }), env });
    expect(bad.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
