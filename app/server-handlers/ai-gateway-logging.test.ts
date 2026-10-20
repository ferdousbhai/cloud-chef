import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { aiGatewayLoggingAction, updateAiGatewayLoggingAction } from './ai-gateway-logging';

const ORIGIN = 'https://cloudchef.build';

async function setup() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db });
  const signIn = async (email: string) => {
    const user = await upsertVerifiedEmailUser(db, { email });
    const cookie = (await createAuthSession(env, await prepareAuthSession(user.id))).split(';')[0];
    return { userId: user.id, cookie };
  };
  return { database, env, signIn };
}

function read(env: Env, cookie: string) {
  return aiGatewayLoggingAction({
    request: new Request(`${ORIGIN}/api/settings/ai-gateway-logging`, { headers: { cookie } }),
    env,
  });
}

function update(env: Env, cookie: string, body: Record<string, string | boolean>, origin = ORIGIN) {
  return updateAiGatewayLoggingAction({
    request: new Request(`${ORIGIN}/api/settings/ai-gateway-logging/update`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
    env,
  });
}

describe('AI Gateway content logging setting', () => {
  it('is on until the person turns it off, and changes only their own', async () => {
    const { database, env, signIn } = await setup();
    const ada = await signIn('ada@acme.com');
    const sam = await signIn('sam@acme.com');

    const initial = await read(env, ada.cookie);
    expect(initial.status).toBe(200);
    expect(initial.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await initial.json()).toEqual({ contentLogging: true });

    const off = await update(env, ada.cookie, { contentLogging: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ contentLogging: false });
    expect(await (await read(env, ada.cookie)).json()).toEqual({ contentLogging: false });
    expect(
      database.prepare('SELECT id, ai_gateway_content_logging AS logging FROM "user" ORDER BY email').all(),
    ).toEqual([
      { id: ada.userId, logging: 0 },
      { id: sam.userId, logging: 1 },
    ]);

    expect(await (await update(env, ada.cookie, { contentLogging: true })).json()).toEqual({ contentLogging: true });
  });

  it('refuses a request without a session, from another origin, or without a choice', async () => {
    const { env, signIn } = await setup();
    const ada = await signIn('ada@acme.com');

    expect((await read(env, '')).status).toBe(401);
    expect((await update(env, '', { contentLogging: false })).status).toBe(401);
    expect((await update(env, ada.cookie, { contentLogging: false }, 'https://evil.example')).status).toBe(403);
    expect((await update(env, ada.cookie, { contentLogging: 'no' })).status).toBe(400);
    expect((await update(env, ada.cookie, { contentLogging: false, userId: 'someone-else' })).status).toBe(400);
    // Nothing above changed it.
    expect(await (await read(env, ada.cookie)).json()).toEqual({ contentLogging: true });
  });
});
