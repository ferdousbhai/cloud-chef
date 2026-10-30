import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import {
  findManagedPostOfProject,
  findPostByAddress,
  mediaToServe,
  pendingMediaDeletions,
  recordPublication,
  removeReel,
  replaceReel,
  ShowcaseError,
  type NewMedia,
} from './posts.server';

const COMMIT = 'a'.repeat(40);
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Sara's public, published project, and Ben, who isn't a member of anything. */
async function seeded() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
      ('sara', 'Sara', 'sara@example.test', 1, 1, 1, 'sara'),
      ('ben', 'Ben', 'ben@example.test', 1, 1, 1, 'ben');
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('sara-account', 'sara', 'account', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, visibility, created_by,
      site_url, created_at) VALUES
      ('recipes', 'sara-account', 'Recipe Box', 'recipe-box', 't-recipes', 'zip', 'public', 'sara',
        'https://recipes.example.workers.dev', 1);
  `);
  await recordPublication(db, { projectId: 'recipes', commit: COMMIT, by: 'sara', siteUrl: null });
  // SAFETY: the publish above made the one post, whose id is text.
  const { id: postId } = database.prepare('SELECT id FROM posts').get() as { id: string };
  return { database, db, postId };
}

function part(id: string, kind: 'reel_still' | 'reel_audio', position: number): NewMedia {
  return {
    id,
    kind,
    origin: 'agent',
    r2Key: `posts/x/${id}`,
    contentType: kind === 'reel_still' ? 'image/webp' : 'audio/mpeg',
    bytes: 10,
    width: kind === 'reel_still' ? 1280 : null,
    height: kind === 'reel_still' ? 800 : null,
    position,
    commit: null,
    state: 'ready',
  };
}

function reel(id: string): NewMedia {
  return {
    id,
    kind: 'reel',
    origin: 'agent',
    r2Key: `posts/x/${id}.json`,
    contentType: 'application/json',
    bytes: 10,
    width: 1280,
    height: 800,
    durationMs: 9_500,
    commit: null,
    state: 'ready',
  };
}

describe('a post’s clip', () => {
  it('goes on the post for the person who manages it only, replacing the one before', async () => {
    const { db, postId } = await seeded();
    await expect(
      replaceReel(db, { postId, userId: 'ben', reel: reel(ID(1)), parts: [part(ID(2), 'reel_still', 0)] }),
    ).rejects.toBeInstanceOf(ShowcaseError);

    await replaceReel(db, {
      postId,
      userId: 'sara',
      reel: reel(ID(1)),
      parts: [part(ID(2), 'reel_still', 0), part(ID(3), 'reel_still', 1), part(ID(4), 'reel_audio', 2)],
    });
    expect((await findPostByAddress(db, 'sara', 'recipe-box')).post?.reel).toEqual({
      url: `/media/${ID(1)}.json`,
      poster: { url: `/media/${ID(2)}.webp`, width: 1280, height: 800 },
      seconds: 9.5,
    });
    expect(await mediaToServe(db, ID(4))).toEqual({ r2Key: `posts/x/${ID(4)}`, contentType: 'audio/mpeg' });

    await replaceReel(db, { postId, userId: 'sara', reel: reel(ID(5)), parts: [part(ID(6), 'reel_still', 0)] });
    expect((await findPostByAddress(db, 'sara', 'recipe-box')).post?.reel?.url).toBe(`/media/${ID(5)}.json`);
    // The first clip's files are gone, each object queued for deletion.
    expect(await pendingMediaDeletions(db)).toEqual(
      expect.arrayContaining([`posts/x/${ID(1)}.json`, `posts/x/${ID(2)}`, `posts/x/${ID(4)}`]),
    );

    await removeReel(db, { postId, userId: 'sara' });
    expect((await findPostByAddress(db, 'sara', 'recipe-box')).post?.reel).toBeNull();
  });

  it('has a post to go on only for someone who manages it, while the project is public', async () => {
    const { database, db } = await seeded();
    expect((await findManagedPostOfProject(db, 'recipes', 'sara'))?.path).toBe('/sara/recipe-box');
    expect(await findManagedPostOfProject(db, 'recipes', 'ben')).toBeNull();
    database.exec(`UPDATE org_projects SET visibility = 'private' WHERE id = 'recipes'`);
    expect(await findManagedPostOfProject(db, 'recipes', 'sara')).toBeNull();
  });
});
