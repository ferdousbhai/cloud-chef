import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import { recordPublication } from './posts.server';
import {
  addAgentReply,
  addReply,
  closeThread,
  closeThreadsWentLive,
  cutToComment,
  deleteComment,
  listCopies,
  listThreads,
  markThreadOnItsWay,
  mentionedUsernames,
  mentionsCloudChef,
  openThreadsOfProjects,
  reopenThread,
  setThreadFollowing,
  setThreadLocked,
  setThreadPinned,
  startThread,
  waitingFixes,
} from './post-threads.server';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const DAY = 24 * 60 * 60_000;

/** Sara's public Recipe Box with a post; Ben and Mira comment; Ben has a public copy of it. */
async function seeded() {
  const { database, db } = controlPlaneDatabase();
  const old = Date.now() - 30 * DAY;
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
      ('sara', 'Sara', 'sara@example.test', 1, ${old}, ${old}, 'sara'),
      ('ben', 'Ben', 'ben@example.test', 1, ${old}, ${old}, 'ben'),
      ('mira', 'Mira', 'mira@example.test', 1, ${old}, ${old}, 'mira');
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at) VALUES
      ('sara-account', 'sara', 'account', 'active', 1, 1),
      ('ben-account', 'ben', 'account-ben', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, visibility, created_by,
      site_url, created_at) VALUES
      ('recipes', 'sara-account', 'Recipe Box', 'recipe-box', 't-recipes', 'zip', 'public', 'sara',
        'https://recipes.example.workers.dev', 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, copied_from, visibility,
      created_by, site_url, created_at) VALUES
      ('ben-recipes', 'ben-account', 'Ben''s Recipe Box', 'recipe-box', 't-ben', 'copy', 'recipes', 'public', 'ben',
        'https://ben-recipes.example.workers.dev', 2);
  `);
  await recordPublication(db, { projectId: 'recipes', commit: COMMIT_A, by: 'sara', siteUrl: null });
  await recordPublication(db, { projectId: 'ben-recipes', commit: COMMIT_A, by: 'ben', siteUrl: null });
  // SAFETY: the column selected is the posts table's id, of the row this test made.
  const postId = (database.prepare(`SELECT id FROM posts WHERE project_id = 'recipes'`).get() as { id: string }).id;
  return { database, db, postId };
}

function notificationsOf(database: ReturnType<typeof controlPlaneDatabase>['database'], userId: string) {
  return database
    .prepare('SELECT kind, actor_id, detail FROM notifications WHERE user_id = ? ORDER BY rowid')
    .all(userId)
    .map((row) => ({ kind: row.kind, actor_id: row.actor_id, detail: row.detail }));
}

function kindsOf(database: ReturnType<typeof controlPlaneDatabase>['database'], userId: string) {
  return notificationsOf(database, userId).map((row) => row.kind);
}

describe('mentions', () => {
  it('finds usernames and @cloudchef, not addresses', () => {
    expect(mentionedUsernames('@Sara and @ben-2, mail me at x@y.z, @cloudchef')).toEqual(['sara', 'ben-2']);
    expect(mentionsCloudChef('hey @CloudChef please')).toBe(true);
    expect(mentionsCloudChef('me@cloudchef.build')).toBe(false);
  });
});

describe('threads', () => {
  it('numbers threads, keeps replies under them, and tells followers and the mentioned', async () => {
    const { database, db, postId } = await seeded();
    const first = await startThread(db, { userId: 'ben', postId, body: 'The date picker fails on phones' });
    const second = await startThread(db, { userId: 'mira', postId, body: 'Dark mode?' });
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first.state).toBe('open');
    expect(first.onEarlierVersion).toBe(false);

    await addReply(db, { userId: 'sara', threadId: first.id, body: 'Thanks! @mira, does it fail for you too?' });
    await addReply(db, { userId: 'mira', threadId: first.id, body: 'Yes, same' });

    const { threads, open } = await listThreads(db, postId, 'ben');
    expect(open).toBe(2);
    const listed = threads.find((thread) => thread.id === first.id)!;
    expect(listed.replyCount).toBe(2);
    expect(listed.replies.map((reply) => reply.body)).toEqual([
      'Thanks! @mira, does it fail for you too?',
      'Yes, same',
    ]);
    expect(listed.viewer).toEqual({ following: true, canClose: true, canEdit: false });
    // Sara heard of the new thread; Ben of both replies; Mira of her mention, not of her own reply.
    expect(kindsOf(database, 'sara')).toEqual(['post_commented', 'post_commented', 'comment_replied']);
    expect(kindsOf(database, 'ben')).toEqual(['comment_replied', 'comment_replied']);
    expect(kindsOf(database, 'mira')).toEqual(['comment_mentioned']);
    expect(database.prepare('SELECT comment_count FROM posts WHERE id = ?').get(postId)).toEqual({ comment_count: 4 });
  });

  it('lets the starter and editors close and reopen, and nobody else', async () => {
    const { db, postId } = await seeded();
    const thread = await startThread(db, { userId: 'ben', postId, body: 'Add a print button' });
    const other = await startThread(db, { userId: 'mira', postId, body: 'Print please' });
    await expect(closeThread(db, { userId: 'mira', threadId: thread.id, reason: 'not_planned' })).rejects.toMatchObject(
      { status: 403 },
    );
    const duplicate = await closeThread(db, { userId: 'sara', threadId: other.id, reason: 'duplicate', sameAs: 1 });
    expect(duplicate).toMatchObject({ state: 'closed', closeReason: 'duplicate', sameAs: 1 });
    const closed = await closeThread(db, { userId: 'ben', threadId: thread.id, reason: 'not_planned' });
    expect(closed).toMatchObject({ state: 'closed', closeReason: 'not_planned' });
    expect((await reopenThread(db, { userId: 'ben', threadId: thread.id })).state).toBe('open');
  });

  it('lets only editors lock and pin, and a locked thread takes replies only from them', async () => {
    const { db, postId } = await seeded();
    const thread = await startThread(db, { userId: 'ben', postId, body: 'Hello' });
    await expect(setThreadLocked(db, { userId: 'ben', threadId: thread.id, locked: true })).rejects.toMatchObject({
      status: 403,
    });
    expect((await setThreadLocked(db, { userId: 'sara', threadId: thread.id, locked: true })).locked).toBe(true);
    await expect(addReply(db, { userId: 'mira', threadId: thread.id, body: 'Hi' })).rejects.toMatchObject({
      status: 403,
    });
    await addReply(db, { userId: 'sara', threadId: thread.id, body: 'Locked for now' });
    for (let count = 0; count < 3; count += 1) {
      const each = await startThread(db, { userId: 'mira', postId, body: `Idea ${count}` });
      await setThreadPinned(db, { userId: 'sara', threadId: each.id, pinned: true });
    }
    await expect(setThreadPinned(db, { userId: 'sara', threadId: thread.id, pinned: true })).rejects.toMatchObject({
      status: 409,
    });
    expect((await listThreads(db, postId, null)).threads.slice(0, 3).every((each) => each.pinned)).toBe(true);
  });

  it('mutes a thread so replies no longer notify', async () => {
    const { database, db, postId } = await seeded();
    const thread = await startThread(db, { userId: 'ben', postId, body: 'Hi' });
    await setThreadFollowing(db, { userId: 'ben', threadId: thread.id, follow: false });
    await addReply(db, { userId: 'sara', threadId: thread.id, body: 'Hello Ben' });
    expect(notificationsOf(database, 'ben')).toEqual([]);
  });

  it('deletes a thread with its replies and keeps the count right', async () => {
    const { database, db, postId } = await seeded();
    const thread = await startThread(db, { userId: 'ben', postId, body: 'Hi' });
    await addReply(db, { userId: 'mira', threadId: thread.id, body: 'Hi too' });
    await expect(deleteComment(db, { userId: 'mira', commentId: thread.id })).rejects.toMatchObject({ status: 403 });
    await deleteComment(db, { userId: 'sara', commentId: thread.id });
    expect(database.prepare('SELECT COUNT(*) AS count FROM post_comments').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT comment_count FROM posts WHERE id = ?').get(postId)).toEqual({ comment_count: 0 });
  });
});

describe('a change going live', () => {
  it('keeps a thread on its way until a publish with the change, then closes it as changed', async () => {
    const { database, db, postId } = await seeded();
    const thread = await startThread(db, { userId: 'ben', postId, body: 'Fix the picker' });
    await expect(
      markThreadOnItsWay(db, { userId: 'ben', threadId: thread.id, fixCommit: COMMIT_B }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await markThreadOnItsWay(db, { userId: 'sara', threadId: thread.id, fixCommit: COMMIT_B })).toBe(
      'on_its_way',
    );
    expect(await waitingFixes(db, 'recipes')).toEqual([{ threadId: thread.id, fixCommit: COMMIT_B }]);
    await closeThreadsWentLive(db, { projectId: 'recipes', threadIds: [thread.id], at: 5 });
    const [closed] = (await listThreads(db, postId, null)).threads;
    expect(closed).toMatchObject({ state: 'closed', closeReason: 'changed', stateAt: 5 });
    expect(notificationsOf(database, 'ben')).toEqual([{ kind: 'thread_closed', actor_id: null, detail: 'changed' }]);
  });

  it('closes at once when the change is already live', async () => {
    const { db, postId } = await seeded();
    const thread = await startThread(db, { userId: 'ben', postId, body: 'Fix the picker' });
    expect(await markThreadOnItsWay(db, { userId: 'sara', threadId: thread.id, fixCommit: COMMIT_A })).toBe('closed');
  });
});

describe('CloudChef and copies', () => {
  it('posts CloudChef’s answer as a reply, cut to a comment’s length', async () => {
    const { db, postId } = await seeded();
    const thread = await startThread(db, { userId: 'ben', postId, body: '@cloudchef how does it save recipes?' });
    const reply = await addAgentReply(db, { threadId: thread.id, askerId: 'ben', body: 'x'.repeat(1500) });
    expect(reply?.byAgent).toBe(true);
    expect(reply?.body).toHaveLength(1000);
    expect(reply?.body.endsWith('…')).toBe(true);
  });

  it('lists public copies and takes a suggestion only from the copy’s maker', async () => {
    const { database, db, postId } = await seeded();
    expect(await listCopies(db, postId)).toEqual([
      {
        name: "Ben's Recipe Box",
        path: '/ben/recipe-box',
        author: { username: 'ben', name: 'Ben', image: null },
      },
    ]);
    await expect(
      startThread(db, { userId: 'mira', postId, body: 'Try this', suggestFrom: 'ben-recipes' }),
    ).rejects.toMatchObject({ status: 403 });
    const suggestion = await startThread(db, {
      userId: 'ben',
      postId,
      body: 'I added printing',
      suggestFrom: 'ben-recipes',
    });
    expect(suggestion.kind).toBe('suggestion');
    expect(suggestion.suggestion).toEqual({
      name: "Ben's Recipe Box",
      path: '/ben/recipe-box',
      siteUrl: 'https://ben-recipes.example.workers.dev',
    });
    expect(kindsOf(database, 'sara')).toEqual(['change_suggested']);
  });
});

describe('openThreadsOfProjects', () => {
  it('counts open threads per project, for its card', async () => {
    const { db, postId } = await seeded();
    await startThread(db, { userId: 'ben', postId, body: 'One' });
    const closed = await startThread(db, { userId: 'ben', postId, body: 'Two' });
    await closeThread(db, { userId: 'sara', threadId: closed.id, reason: 'not_planned' });
    expect(await openThreadsOfProjects(db, ['recipes', 'ben-recipes'])).toEqual({ recipes: 1 });
  });
});

describe('cutToComment', () => {
  it('ends a reply too long for a comment at its last sentence that fits', () => {
    const sentence = 'This sentence is exactly fifty characters long ok. ';
    const cut = cutToComment(sentence.repeat(30));
    expect(cut.length).toBeLessThanOrEqual(1000);
    expect(cut.endsWith('ok.…')).toBe(true);
    const words = cutToComment('word '.repeat(400));
    expect(words.endsWith('word…')).toBe(true);
  });
});
