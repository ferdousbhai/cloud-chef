import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import { createAuthSession } from '~/lib/.server/auth';
import { managedSpaceWaitlistAction, updateManagedSpaceWaitlistAction } from './managed-space-waitlist';

const ORIGIN = 'https://cloudchef.build';

async function setup() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db });
  const signIn = async (email: string) => {
    const user = await createProvenEmailUser(db, email);
    const cookie = (await createAuthSession(env, user.id, new Request(`${ORIGIN}/`))).cookie.split(';')[0];
    return { userId: user.id, cookie };
  };
  return { database, env, signIn };
}

function read(env: Env, cookie: string) {
  return managedSpaceWaitlistAction({
    request: new Request(`${ORIGIN}/api/managed-spaces/waitlist`, { headers: { cookie } }),
    env,
  });
}

function update(env: Env, cookie: string, body: Record<string, boolean>, origin = ORIGIN) {
  return updateManagedSpaceWaitlistAction({
    request: new Request(`${ORIGIN}/api/managed-spaces/waitlist/update`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
    env,
  });
}

describe('the managed space waitlist', () => {
  it('lets someone with nowhere to build join, keeps the first time they joined, and leave', async () => {
    const { database, env, signIn } = await setup();
    const sara = await signIn('sara@gmail.com');
    const sam = await signIn('sam@acme.com');

    expect(await (await read(env, sara.cookie)).json()).toEqual({ joined: false, joinedAt: null });

    const joined = await update(env, sara.cookie, { joined: true });
    expect(joined.status).toBe(200);
    const first = z.object({ joined: z.literal(true), joinedAt: z.iso.datetime() }).parse(await joined.json());
    await update(env, sara.cookie, { joined: true });
    expect(await (await read(env, sara.cookie)).json()).toEqual(first);
    expect(await (await read(env, sam.cookie)).json()).toEqual({ joined: false, joinedAt: null });

    expect(await (await update(env, sara.cookie, { joined: false })).json()).toEqual({ joined: false, joinedAt: null });
    expect(
      database.prepare('SELECT COUNT(*) AS waiting FROM "user" WHERE managed_space_waitlist_at IS NOT NULL').get(),
    ).toEqual({ waiting: 0 });
  });

  it('refuses someone signed out and a request from another site', async () => {
    const { env, signIn } = await setup();
    const sara = await signIn('sara@gmail.com');
    expect((await read(env, '')).status).toBe(401);
    expect((await update(env, sara.cookie, { joined: true }, 'https://evil.example')).status).toBe(403);
  });
});
