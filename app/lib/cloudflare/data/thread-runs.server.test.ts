import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import { recordPublication } from './posts.server';
import { startThread } from './post-threads.server';
import {
  THREAD_RUN_STALE_MS,
  chatMayCloseThread,
  claimThreadRun,
  endThreadRun,
  setThreadRunChat,
} from './thread-runs.server';

async function seeded() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
      ('sara', 'Sara', 'sara@example.test', 1, 1, 1, 'sara'),
      ('ben', 'Ben', 'ben@example.test', 1, 1, 1, 'ben');
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at) VALUES
      ('sara-account', 'sara', 'account', 'active', 1, 1);
    INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, visibility, created_by,
      site_url, created_at) VALUES
      ('recipes', 'sara-account', 'Recipe Box', 'recipe-box', 't-recipes', 'zip', 'public', 'sara',
        'https://recipes.example.workers.dev', 1);
  `);
  await recordPublication(db, { projectId: 'recipes', commit: 'a'.repeat(40), by: 'sara', siteUrl: null });
  // SAFETY: the column selected is the posts table's id, of the row this test made.
  const postId = (database.prepare(`SELECT id FROM posts WHERE project_id = 'recipes'`).get() as { id: string }).id;
  const thread = await startThread(db, { userId: 'ben', postId, body: '@cloudchef why?' });
  return { db, thread };
}

describe('mention runs', () => {
  it('keeps one chat per person per thread, one running turn at a time, and a new chat when access changes', async () => {
    const { db, thread } = await seeded();
    const claim = (access: 'edit' | 'read', newChatId: string) =>
      claimThreadRun(db, { threadId: thread.id, userId: 'ben', access, commentId: thread.id, newChatId });

    expect(await claim('read', 'first')).toEqual({ status: 'claimed', chatId: 'first', fresh: true });
    expect(await claim('read', 'second')).toEqual({ status: 'busy' });
    await setThreadRunChat(db, { threadId: thread.id, userId: 'ben', chatId: 'ben-chat' });
    expect(await chatMayCloseThread(db, { threadId: thread.id, userId: 'ben', chatId: 'ben-chat' })).toBe(false);
    expect(await endThreadRun(db, { threadId: thread.id, userId: 'ben', commentId: thread.id, chatId: 'other' })).toBe(
      false,
    );
    expect(await endThreadRun(db, { threadId: thread.id, userId: 'ben', commentId: thread.id })).toBe(true);

    expect(await claim('read', 'third')).toEqual({ status: 'claimed', chatId: 'ben-chat', fresh: false });
    await endThreadRun(db, { threadId: thread.id, userId: 'ben', commentId: thread.id });
    // Given edit access since: a chat on the project, which may close the thread while it answers.
    expect(await claim('edit', 'fourth')).toEqual({ status: 'claimed', chatId: 'fourth', fresh: true });
    expect(await chatMayCloseThread(db, { threadId: thread.id, userId: 'ben', chatId: 'fourth' })).toBe(true);
  });

  it('takes a turn that never reported back as lost after a few hours', async () => {
    const { db, thread } = await seeded();
    const claim = (now: number) =>
      claimThreadRun(db, {
        threadId: thread.id,
        userId: 'ben',
        access: 'read',
        commentId: thread.id,
        newChatId: `c-${now}`,
        now,
      });
    expect((await claim(1_000)).status).toBe('claimed');
    expect(await claim(1_000 + THREAD_RUN_STALE_MS - 1)).toEqual({ status: 'busy' });
    expect(await claim(1_000 + THREAD_RUN_STALE_MS + 1)).toEqual({ status: 'claimed', chatId: 'c-1000', fresh: false });
  });
});
