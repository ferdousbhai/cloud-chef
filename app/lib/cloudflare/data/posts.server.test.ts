import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import {
  POST_MOVE_INTERVAL_MS,
  REPORTS_TO_HOLD,
  addComment,
  decideReports,
  deletePost,
  fileReport,
  findPerson,
  findPostByAddress,
  hidePostOfPrivateProject,
  listExplorePosts,
  listFeedPosts,
  listNotifications,
  mediaToServe,
  pendingMediaDeletions,
  recordCopy,
  recordPublication,
  setFollowing,
  setLiked,
  setPostShown,
  ShowcaseError,
} from './posts.server';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const COMMIT_C = 'c'.repeat(40);
const DAY = 24 * 60 * 60_000;

/** Sara's public project, a private one, and Ben, who isn't a member of anything; all a month old. */
function seeded() {
  const { database, db } = controlPlaneDatabase();
  const old = Date.now() - 30 * DAY;
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
      ('sara', 'Sara', 'sara@example.test', 1, ${old}, ${old}, 'sara'),
      ('ben', 'Ben', 'ben@example.test', 1, ${old}, ${old}, 'ben'),
      ('mira', 'Mira', 'mira@example.test', 1, ${old}, ${old}, 'mira');
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('sara-account', 'sara', 'account', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, visibility, created_by,
      site_url, created_at) VALUES
      ('recipes', 'sara-account', 'Recipe Box', 'recipe-box', 't-recipes', 'zip', 'public', 'sara',
        'https://recipes.example.workers.dev', 1),
      ('diary', 'sara-account', 'Diary', 'diary', 't-diary', 'zip', 'private', 'sara',
        'https://diary.example.workers.dev', 2);
  `);
  return { database, db };
}

function postOf(database: DatabaseSync, projectId: string) {
  // SAFETY: the columns selected are exactly these, of the posts table this test's migrations made.
  return database
    .prepare('SELECT id, status, hidden_reason, commit_sha, shown_at, published_count FROM posts WHERE project_id = ?')
    .get(projectId) as
    | {
        id: string;
        status: string;
        hidden_reason: string | null;
        commit_sha: string;
        shown_at: number;
        published_count: number;
      }
    | undefined;
}

describe('recordPublication', () => {
  it('posts a public project once, on the page of whoever pushed the commit, and never a private one', async () => {
    const { database, db } = seeded();
    database.exec(`INSERT INTO project_main_pushes (id, project_id, pushed_by, old_commit, new_commit, pushed_at)
      VALUES ('push', 'recipes', 'ben', NULL, '${COMMIT_A}', 1)`);

    const first = await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const again = await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const hidden = await recordPublication(db, { projectId: 'diary', commit: COMMIT_A, by: 'sara', siteUrl: null });

    expect(first.kind).toBe('created');
    expect(again.kind).toBe('unchanged');
    expect(hidden.kind).toBe('not_posted');
    expect(database.prepare('SELECT author_id, site_url FROM posts').all()).toEqual([
      { author_id: 'ben', site_url: 'https://recipes.example.workers.dev' },
    ]);
  });

  it('updates the one post on a later publish, moving it up the feed at most once a day', async () => {
    const { database, db } = seeded();
    const start = Date.now();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null, now: start });
    await recordPublication(db, {
      projectId: 'recipes',
      commit: COMMIT_B,
      by: 'sara',
      siteUrl: null,
      now: start + 60_000,
    });
    expect(postOf(database, 'recipes')).toMatchObject({ commit_sha: COMMIT_B, shown_at: start, published_count: 2 });

    const later = start + POST_MOVE_INTERVAL_MS + 1;
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_C, by: 'sara', siteUrl: null, now: later });
    expect(postOf(database, 'recipes')).toMatchObject({ commit_sha: COMMIT_C, shown_at: later, published_count: 3 });
  });

  it('keeps a post its author hid hidden, and shows again one hidden when its project went private', async () => {
    const { database, db } = seeded();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const postId = postOf(database, 'recipes')!.id;
    await setPostShown(db, { postId, userId: 'sara', shown: false });
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_B, by: 'sara', siteUrl: null });
    expect(postOf(database, 'recipes')).toMatchObject({
      status: 'hidden',
      hidden_reason: 'author',
      commit_sha: COMMIT_B,
    });

    await setPostShown(db, { postId, userId: 'sara', shown: true });
    database.exec(`UPDATE org_projects SET visibility = 'private' WHERE id = 'recipes'`);
    await hidePostOfPrivateProject(db, 'recipes');
    expect(postOf(database, 'recipes')).toMatchObject({ status: 'hidden', hidden_reason: 'project_private' });

    database.exec(`UPDATE org_projects SET visibility = 'public' WHERE id = 'recipes'`);
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_C, by: 'sara', siteUrl: null });
    expect(postOf(database, 'recipes')).toMatchObject({ status: 'visible', hidden_reason: null });
  });
});

describe('showing posts', () => {
  it('shows only what anyone may see, and deletes a private project’s media', async () => {
    const { database, db } = seeded();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const postId = postOf(database, 'recipes')!.id;
    database.exec(`INSERT INTO post_media (id, post_id, kind, origin, r2_key, content_type, bytes, state, created_at)
      VALUES ('00000000-0000-4000-8000-000000000001', '${postId}', 'screenshot', 'automatic', 'posts/x/shot.webp',
        'image/webp', 10, 'ready', 1)`);

    expect((await findPostByAddress(db, 'sara', 'recipe-box')).post?.screenshot?.url).toBe(
      '/media/00000000-0000-4000-8000-000000000001.webp',
    );
    expect((await findPerson(db, 'sara'))?.posts).toBe(1);
    expect(await mediaToServe(db, '00000000-0000-4000-8000-000000000001')).not.toBeNull();
    // Nothing private about the person reaches the public view.
    expect(JSON.stringify(await listExplorePosts(db))).not.toContain('sara@example.test');

    database.exec(`UPDATE org_projects SET visibility = 'private' WHERE id = 'recipes'`);
    await hidePostOfPrivateProject(db, 'recipes');
    expect((await listExplorePosts(db)).posts).toEqual([]);
    expect(await mediaToServe(db, '00000000-0000-4000-8000-000000000001')).toBeNull();
    expect(await pendingMediaDeletions(db)).toEqual(['posts/x/shot.webp']);
    expect(await findPostByAddress(db, 'sara', 'recipe-box')).toEqual({ post: null, project: null });
  });

  it('lets only the people who manage a post hide or delete it', async () => {
    const { database, db } = seeded();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const postId = postOf(database, 'recipes')!.id;
    await expect(setPostShown(db, { postId, userId: 'ben', shown: false })).rejects.toBeInstanceOf(ShowcaseError);
    await expect(deletePost(db, { postId, userId: 'ben' })).rejects.toBeInstanceOf(ShowcaseError);
    await deletePost(db, { postId, userId: 'sara' });
    expect(postOf(database, 'recipes')).toBeUndefined();
  });
});

describe('follows, likes and the feed', () => {
  it('fills a follower’s feed, and tells the author once of a follow, a like and a copy', async () => {
    const { database, db } = seeded();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const postId = postOf(database, 'recipes')!.id;

    expect((await listFeedPosts(db, 'ben')).posts).toEqual([]);
    await setFollowing(db, { userId: 'ben', username: 'sara', follow: true });
    await setFollowing(db, { userId: 'ben', username: 'sara', follow: false });
    await setFollowing(db, { userId: 'ben', username: 'sara', follow: true });
    expect((await listFeedPosts(db, 'ben')).posts.map((post) => post.id)).toEqual([postId]);

    expect(await setLiked(db, { userId: 'ben', postId, like: true })).toEqual({ liked: true, likeCount: 1 });
    expect(await setLiked(db, { userId: 'ben', postId, like: true })).toEqual({ liked: true, likeCount: 1 });
    await setLiked(db, { userId: 'mira', postId, like: true });
    await recordCopy(db, { sourceProjectId: 'recipes', copierId: 'mira' });

    const notifications = await listNotifications(db, 'sara');
    expect(notifications.map((item) => [item.kind, item.actor?.name, item.others])).toEqual([
      ['project_copied', 'Mira', 0],
      ['post_liked', 'Mira', 1],
      ['new_follower', 'Ben', 0],
    ]);
    await expect(setFollowing(db, { userId: 'sara', username: 'sara', follow: true })).rejects.toThrow(
      'You can’t follow yourself.',
    );
  });

  it('keeps a new account’s posts out of feeds for its first day', async () => {
    const { database, db } = seeded();
    database.exec(`UPDATE "user" SET createdAt = ${Date.now()} WHERE id = 'sara'`);
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    await setFollowing(db, { userId: 'ben', username: 'sara', follow: true });
    expect((await listFeedPosts(db, 'ben')).posts).toEqual([]);
    expect((await listExplorePosts(db)).posts).toHaveLength(1);
  });
});

describe('reports', () => {
  it(`holds a post after ${REPORTS_TO_HOLD} people report it, and an operator's removal takes it down for good`, async () => {
    const { database, db } = seeded();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const postId = postOf(database, 'recipes')!.id;
    const report = (reporter: { reporterId: string | null; reporterIpHash: string | null }) =>
      fileReport(db, { postId, commentId: null, reason: 'scam_or_phishing', note: null, ...reporter });

    expect(await report({ reporterId: 'ben', reporterIpHash: 'ip-1' })).toEqual({ held: false });
    // The same visitor twice is one person.
    expect(await report({ reporterId: null, reporterIpHash: 'ip-2' })).toEqual({ held: false });
    expect(await report({ reporterId: null, reporterIpHash: 'ip-2' })).toEqual({ held: false });
    expect(await report({ reporterId: 'mira', reporterIpHash: 'ip-3' })).toEqual({ held: true });
    expect(postOf(database, 'recipes')).toMatchObject({ status: 'hidden', hidden_reason: 'reported' });
    await expect(setPostShown(db, { postId, userId: 'sara', shown: true })).rejects.toBeInstanceOf(ShowcaseError);

    const decided = await decideReports(db, { postId, commentId: null, operatorId: 'ben', decision: 'remove' });
    expect(decided.removedPostAuthor).toEqual({
      email: 'sara@example.test',
      name: 'Sara',
      title: 'Recipe Box',
      reason: 'a scam',
    });
    expect(postOf(database, 'recipes')).toMatchObject({ status: 'removed' });
    // The next publish doesn't post it again.
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_B, by: 'sara', siteUrl: null });
    expect(postOf(database, 'recipes')).toMatchObject({ status: 'removed', commit_sha: COMMIT_A });
    expect((await listNotifications(db, 'sara'))[0]).toMatchObject({ kind: 'post_removed', detail: 'a scam' });
  });

  it('limits a visitor’s reports per day', async () => {
    const { database, db } = seeded();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const postId = postOf(database, 'recipes')!.id;
    const report = () =>
      fileReport(db, { postId, commentId: null, reporterId: null, reporterIpHash: 'ip', reason: 'spam', note: null });
    for (let count = 0; count < 5; count += 1) {
      await report();
    }
    await expect(report()).rejects.toMatchObject({ status: 429 });
  });

  it('holds a reported comment, and dismissing shows it again', async () => {
    const { database, db } = seeded();
    await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
    const postId = postOf(database, 'recipes')!.id;
    const comment = await addComment(db, { userId: 'ben', postId, body: 'Nice <b>work</b>' });
    expect(comment.body).toBe('Nice <b>work</b>');
    for (const ip of ['a', 'b', 'c']) {
      await fileReport(db, {
        postId,
        commentId: comment.id,
        reporterId: null,
        reporterIpHash: ip,
        reason: 'spam',
        note: null,
      });
    }
    expect(database.prepare('SELECT status FROM post_comments').get()).toEqual({ status: 'held' });
    expect(database.prepare('SELECT comment_count FROM posts').get()).toEqual({ comment_count: 0 });
    await decideReports(db, { postId, commentId: comment.id, operatorId: 'mira', decision: 'dismiss' });
    expect(database.prepare('SELECT status FROM post_comments').get()).toEqual({ status: 'visible' });
    expect(database.prepare('SELECT comment_count FROM posts').get()).toEqual({ comment_count: 1 });
  });
});
