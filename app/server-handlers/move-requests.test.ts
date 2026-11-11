import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase, createProvenEmailUser, envWith } from '~/test/control-plane-d1';
import { createAuthSession } from '~/lib/.server/auth';
import {
  MOVE_NOTE_MAX_LENGTH,
  MOVE_REQUEST_LIMIT,
  moveRequestsSchema,
  normalizeMoveSiteUrl,
} from '~/lib/move-requests';
import { moveRequestsAction, saveMoveRequestAction, withdrawMoveRequestAction } from './move-requests';

const ORIGIN = 'https://cloudchef.build';

/** What a form sends, or something like it that must be refused. */
type Body = { siteUrl?: string; platform?: string; note?: string };

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

function post(path: string, cookie: string, body: Body, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function read(env: Env, cookie: string) {
  const response = await moveRequestsAction({
    request: new Request(`${ORIGIN}/api/move-requests`, { headers: { cookie } }),
    env,
  });
  return moveRequestsSchema.parse(await response.json()).requests;
}

function save(env: Env, cookie: string, body: Body, origin?: string) {
  return saveMoveRequestAction({ request: post('/api/move-requests/save', cookie, body, origin), env });
}

function withdraw(env: Env, cookie: string, body: Body, origin?: string) {
  return withdrawMoveRequestAction({ request: post('/api/move-requests/withdraw', cookie, body, origin), env });
}

describe('move requests', () => {
  it('keeps one request per person and address: asking again changes it, and each person sees only their own', async () => {
    const { database, env, signIn } = await setup();
    const sara = await signIn('sara@gmail.com');
    const sam = await signIn('sam@acme.com');
    expect(await read(env, sara.cookie)).toEqual([]);

    const asked = await save(env, sara.cookie, { siteUrl: 'BohemianGoddess.com', platform: 'other' });
    expect(asked.status).toBe(200);
    const [first] = moveRequestsSchema.parse(await asked.json()).requests;
    expect(first).toMatchObject({ siteUrl: 'https://bohemiangoddess.com/', platform: 'other', note: null });

    const again = await save(env, sara.cookie, {
      siteUrl: 'https://bohemiangoddess.com/#top',
      platform: 'shopify',
      note: '  The shop, not the blog.  ',
    });
    expect(moveRequestsSchema.parse(await again.json()).requests).toEqual([
      {
        siteUrl: 'https://bohemiangoddess.com/',
        platform: 'shopify',
        note: 'The shop, not the blog.',
        createdAt: first!.createdAt,
        updatedAt: expect.any(String),
      },
    ]);
    await save(env, sara.cookie, { siteUrl: 'http://saraadolfsen.com/blog?lang=fi', platform: 'wordpress' });
    expect((await read(env, sara.cookie)).map((request) => request.siteUrl).sort()).toEqual([
      'http://saraadolfsen.com/blog?lang=fi',
      'https://bohemiangoddess.com/',
    ]);
    expect(await read(env, sam.cookie)).toEqual([]);
    expect(database.prepare('SELECT COUNT(*) AS requests FROM move_requests').get()).toEqual({ requests: 2 });
  });

  it('withdraws only the caller’s own request for an address', async () => {
    const { env, signIn } = await setup();
    const sara = await signIn('sara@gmail.com');
    const sam = await signIn('sam@acme.com');
    await save(env, sara.cookie, { siteUrl: 'https://example.com', platform: 'wordpress' });
    await save(env, sam.cookie, { siteUrl: 'https://example.com', platform: 'other' });

    const withdrawn = await withdraw(env, sara.cookie, { siteUrl: 'https://example.com/' });
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toEqual({ requests: [] });
    expect(await read(env, sam.cookie)).toHaveLength(1);
  });

  it('refuses an address that isn’t a site’s, a platform it doesn’t know, and a note that is too long', async () => {
    const { database, env, signIn } = await setup();
    const sara = await signIn('sara@gmail.com');
    for (const siteUrl of [
      '',
      'not a site',
      'localhost',
      'ftp://example.com',
      'mailto:sara@example.com',
      'javascript:alert(1)',
      'https://sara:secret@example.com',
      `https://example.com/${'a'.repeat(400)}`,
    ]) {
      expect((await save(env, sara.cookie, { siteUrl, platform: 'other' })).status, siteUrl).toBe(400);
    }
    expect((await save(env, sara.cookie, { siteUrl: 'https://example.com', platform: 'wix' })).status).toBe(400);
    expect((await save(env, sara.cookie, { siteUrl: 'https://example.com' })).status).toBe(400);
    const long = 'a'.repeat(MOVE_NOTE_MAX_LENGTH + 1);
    expect(
      (await save(env, sara.cookie, { siteUrl: 'https://example.com', platform: 'other', note: long })).status,
    ).toBe(400);
    expect(database.prepare('SELECT COUNT(*) AS requests FROM move_requests').get()).toEqual({ requests: 0 });
  });

  it('stops at a number of sites per person, still letting them change one they asked for', async () => {
    const { env, signIn } = await setup();
    const sara = await signIn('sara@gmail.com');
    for (let site = 0; site < MOVE_REQUEST_LIMIT; site += 1) {
      expect(
        (await save(env, sara.cookie, { siteUrl: `https://site-${site}.example`, platform: 'other' })).status,
      ).toBe(200);
    }
    expect((await save(env, sara.cookie, { siteUrl: 'https://one-more.example', platform: 'other' })).status).toBe(400);
    expect((await save(env, sara.cookie, { siteUrl: 'https://site-0.example', platform: 'shopify' })).status).toBe(200);
    expect(await read(env, sara.cookie)).toHaveLength(MOVE_REQUEST_LIMIT);
  });

  it('refuses someone signed out and a request from another site', async () => {
    const { env, signIn } = await setup();
    const sara = await signIn('sara@gmail.com');
    const body = { siteUrl: 'https://example.com', platform: 'other' };
    expect((await moveRequestsAction({ request: new Request(`${ORIGIN}/api/move-requests`), env })).status).toBe(401);
    expect((await save(env, '', body)).status).toBe(401);
    expect((await withdraw(env, '', { siteUrl: 'https://example.com/' })).status).toBe(401);
    expect((await save(env, sara.cookie, body, 'https://evil.example')).status).toBe(403);
    expect((await withdraw(env, sara.cookie, { siteUrl: 'https://example.com/' }, 'https://evil.example')).status).toBe(
      403,
    );
  });
});

describe('a site’s address', () => {
  it('is kept as a browser would write it, without what follows #', () => {
    expect(normalizeMoveSiteUrl('  example.com  ')).toBe('https://example.com/');
    expect(normalizeMoveSiteUrl('HTTP://Example.com/Shop#reviews')).toBe('http://example.com/Shop');
    expect(normalizeMoveSiteUrl('shop.example.com/collections/all?page=2')).toBe(
      'https://shop.example.com/collections/all?page=2',
    );
  });
});
