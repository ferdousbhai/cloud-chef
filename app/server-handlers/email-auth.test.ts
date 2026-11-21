import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase, createProvenEmailUser, envWith, inviteToTeam } from '~/test/control-plane-d1';
import { createAuthSession, getAuthSession } from '~/lib/.server/auth';
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

function post(path: string, body: Record<string, string | boolean>, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sessionFrom(env: Env, response: Response) {
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
  return getAuthSession(env, new Request(ORIGIN, { headers: { cookie } }));
}

function tokenFrom(text: string): string {
  const match = /token=([\w-]+)/.exec(text);
  if (!match) {
    throw new Error('no sign-in link in the email');
  }
  return match[1];
}

describe('email sign-in', () => {
  it('emails a one-time link that signs in a new user a team invited, without a Cloudflare connection', async () => {
    const { env, sent } = setup();
    await inviteToTeam(env.DB, 'sam@example.com');
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
    await createProvenEmailUser(env.DB, 'sam@example.com');
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

  it('returns to the builder after a link asked to return somewhere that is not a URL', async () => {
    const { env, sent } = setup();
    await createProvenEmailUser(env.DB, 'sam@example.com');
    const start = await startEmailSignInAction({
      request: post('/api/auth/email/start', { email: 'sam@example.com', callbackURL: 'http://[' }),
      env,
    });
    expect(start.status).toBe(202);
    const complete = await completeEmailSignInAction({
      request: post('/api/auth/email/complete', { token: tokenFrom(sent[0]) }),
      env,
    });
    await expect(complete.json()).resolves.toEqual({ returnTo: '/' });
  });

  it('says which address a link is for without using it up', async () => {
    const { env, sent } = setup();
    await createProvenEmailUser(env.DB, 'sam@example.com');
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

  it('keeps a link whose address an account made with Cloudflare carries, for after signing in with Cloudflare', async () => {
    const { database, env, sent } = setup();
    database
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cloudflare_subject)
         VALUES ('user-cf', 'Ada', 'ada@example.com', 1, 1, 1, 'cf-1')`,
      )
      .run();
    await startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'ada@example.com' }), env });
    const token = tokenFrom(sent[0]);

    // Signed out: no second account, and the link is not used up.
    const refused = await completeEmailSignInAction({ request: post('/api/auth/email/complete', { token }), env });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: 'account_made_with_cloudflare' });
    expect(database.prepare('SELECT COUNT(*) AS users FROM "user"').get()).toEqual({ users: 1 });

    // Signed in with Cloudflare, the same link proves the address on that account.
    const { cookie } = await createAuthSession(env, 'user-cf', new Request(ORIGIN));
    const signedIn = post('/api/auth/email/complete', { token });
    signedIn.headers.set('cookie', cookie.split(';')[0]);
    const proven = await completeEmailSignInAction({ request: signedIn, env });
    expect(proven.status).toBe(200);
    expect((await sessionFrom(env, proven))?.user.id).toBe('user-cf');
    expect(database.prepare('SELECT email_proven_at IS NOT NULL AS proven FROM "user"').get()).toEqual({ proven: 1 });
  });

  it('makes a separate account from such a link when the person says the account is not theirs', async () => {
    const { database, env, sent } = setup();
    database
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cloudflare_subject)
         VALUES ('user-cf', 'Someone else', 'ada@example.com', 1, 1, 1, 'cf-1')`,
      )
      .run();
    await startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'ada@example.com' }), env });
    const done = await completeEmailSignInAction({
      request: post('/api/auth/email/complete', { token: tokenFrom(sent[0]), separateAccount: true }),
      env,
    });
    const session = await sessionFrom(env, done);
    expect(session?.user.email).toBe('ada@example.com');
    expect(session?.user.id).not.toBe('user-cf');
  });

  it('signs in an existing user who first signed in with Google or a link', async () => {
    const { env, sent } = setup();
    const sam = await createProvenEmailUser(env.DB, 'sam@example.com');
    await startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'Sam@example.com' }), env });
    const complete = await completeEmailSignInAction({
      request: post('/api/auth/email/complete', { token: tokenFrom(sent[0]) }),
      env,
    });
    expect(complete.status).toBe(200);
    expect((await sessionFrom(env, complete))?.user.id).toBe(sam.id);
  });

  it('makes a new account for an address CloudChef has never seen', async () => {
    const { database, env, sent } = setup();
    const start = await startEmailSignInAction({
      request: post('/api/auth/email/start', { email: 'nobody@example.com' }),
      env,
    });
    expect(start.status).toBe(202);
    await expect(start.json()).resolves.toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(database.prepare('SELECT COUNT(*) AS users FROM "user"').get()).toEqual({ users: 0 });
    const complete = await completeEmailSignInAction({
      request: post('/api/auth/email/complete', { token: tokenFrom(sent[0]) }),
      env,
    });
    expect(complete.status).toBe(200);
    expect((await sessionFrom(env, complete))?.user.email).toBe('nobody@example.com');
  });

  it('refuses an expired link', async () => {
    const { database, env, sent } = setup();
    await createProvenEmailUser(env.DB, 'sam@example.com');
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

  it('holds the hourly limit for requests that arrive at once', async () => {
    const { database, env, sent } = setup();
    const responses = await Promise.all(
      Array.from({ length: EMAIL_SIGN_IN_LINKS_PER_HOUR * 3 }, () =>
        startEmailSignInAction({ request: post('/api/auth/email/start', { email: 'sam@example.com' }), env }),
      ),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    expect(sent).toHaveLength(EMAIL_SIGN_IN_LINKS_PER_HOUR);
    expect(database.prepare('SELECT COUNT(*) AS links FROM email_sign_in_tokens').get()).toEqual({
      links: EMAIL_SIGN_IN_LINKS_PER_HOUR,
    });
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
