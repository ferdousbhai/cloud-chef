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
  listReplies,
  listThreads,
  markThreadOnItsWay,
  mentionedUsernames,
  mentionsCloudChef,
  offerChange,
  offeredChange,
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
    expect(await listCopies(db, postId, null)).toEqual([
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

  it('offers a change made on the project itself, which only its makers decide on, and updates the open offer', async () => {
    const { database, db, postId } = await seeded();
    const first = await offerChange(db, { userId: 'ben', postId, body: 'Printing', commit: 'b'.repeat(40) });
    expect(first.updated).toBe(false);
    const [thread] = (await listThreads(db, postId, 'sara')).threads;
    expect(thread?.suggestion).toEqual({ name: 'Recipe Box', path: null, siteUrl: null, ownChange: true });
    expect(kindsOf(database, 'sara')).toEqual(['change_suggested']);
    // Once its preview is built, the thread links it for anyone reading to try.
    database.exec(
      `INSERT INTO project_deployments (id, project_id, branch, kind, commit_sha, state, url, created_at, updated_at)
       VALUES ('d1', 'recipes', 'suggested-1', 'preview', '${'b'.repeat(40)}', 'succeeded',
         'https://suggested-1-recipes.example.workers.dev', 1, 1)`,
    );
    expect((await listThreads(db, postId, 'ben')).threads[0]?.suggestion?.siteUrl).toBe(
      'https://suggested-1-recipes.example.workers.dev',
    );
    // Ben, who offered it, can't decide on it; Sara, who makes the app, can.
    await expect(offeredChange(db, { threadId: thread!.id, userId: 'ben' })).rejects.toMatchObject({ status: 403 });
    expect(await offeredChange(db, { threadId: thread!.id, userId: 'sara' })).toMatchObject({
      number: first.number,
      projectId: 'recipes',
      commit: 'b'.repeat(40),
      offeredBy: 'Ben',
    });
    // Offering again gives the open offer the new commit, with the message as a reply.
    const again = await offerChange(db, { userId: 'ben', postId, body: 'Up to date', commit: 'c'.repeat(40) });
    expect(again).toEqual({ number: first.number, updated: true });
    expect((await offeredChange(db, { threadId: thread!.id, userId: 'sara' })).commit).toBe('c'.repeat(40));
    expect((await listReplies(db, thread!.id)).map((reply) => reply.body)).toEqual(['Up to date']);
    // Once decided, it isn't accepted again, and a new offer starts a new thread.
    await closeThread(db, { userId: 'sara', threadId: thread!.id, reason: 'not_planned' });
    await expect(offeredChange(db, { threadId: thread!.id, userId: 'sara' })).rejects.toMatchObject({ status: 409 });
    expect((await offerChange(db, { userId: 'ben', postId, body: 'Another', commit: 'd'.repeat(40) })).updated).toBe(
      false,
    );
    // A plain comment offers nothing to accept.
    const comment = await startThread(db, { userId: 'ben', postId, body: 'Nice' });
    await expect(offeredChange(db, { threadId: comment.id, userId: 'sara' })).rejects.toMatchObject({ status: 409 });
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

describe('a private project’s post', () => {
  it('takes threads only from people who may view the project, and tells only them', async () => {
    const { database, db, postId } = await seeded();
    database.exec(`UPDATE org_projects SET visibility = 'private' WHERE id = 'recipes'`);
    database.exec(
      `INSERT INTO project_shares (project_id, user_id, role, shared_at) VALUES ('recipes', 'ben', 'view', 1)`,
    );

    await expect(startThread(db, { userId: 'mira', postId, body: 'Hello' })).rejects.toMatchObject({ status: 404 });
    expect(await listThreads(db, postId, 'mira')).toEqual({ threads: [], open: 0 });
    expect(await listThreads(db, postId, null)).toEqual({ threads: [], open: 0 });

    const thread = await startThread(db, { userId: 'ben', postId, body: 'Ask @mira and @sara?' });
    expect((await listThreads(db, postId, 'sara')).threads.map((each) => each.id)).toEqual([thread.id]);
    await expect(addReply(db, { userId: 'mira', threadId: thread.id, body: 'Hi' })).rejects.toMatchObject({
      status: 404,
    });
    // Mira can't see the project: her mention tells her nothing.
    expect(kindsOf(database, 'mira')).toEqual([]);
    expect(kindsOf(database, 'sara')).toEqual(['post_commented']);
  });
});
