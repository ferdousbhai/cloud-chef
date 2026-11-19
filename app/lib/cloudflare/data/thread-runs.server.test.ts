import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import { recordPublication } from './posts.server';
import { addReply, startThread } from './post-threads.server';
import { chatMayCloseThread, claimThreadRun, endThreadRun, setThreadRunChat } from './thread-runs.server';

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
  const reply = async () => (await addReply(db, { userId: 'ben', threadId: thread.id, body: '@cloudchef and?' })).id;
  return { db, thread, reply };
}

describe('mention runs', () => {
  it('keeps one chat per person per thread, and a new chat when access changes', async () => {
    const { db, thread, reply } = await seeded();
    const claim = (access: 'edit' | 'read', commentId: string, newChatId: string) =>
      claimThreadRun(db, { threadId: thread.id, userId: 'ben', access, commentId, newChatId });

    expect(await claim('read', thread.id, 'first')).toEqual({ chatId: 'first', fresh: true });
    await setThreadRunChat(db, { threadId: thread.id, userId: 'ben', commentId: thread.id, chatId: 'ben-chat' });
    // Read-only: it may not close the thread.
    expect(await chatMayCloseThread(db, { threadId: thread.id, userId: 'ben', chatId: 'ben-chat' })).toBe(false);
    expect(await claim('read', await reply(), 'second')).toEqual({ chatId: 'ben-chat', fresh: false });
    // Given edit access since: a chat on the project.
    expect(await claim('edit', await reply(), 'third')).toEqual({ chatId: 'third', fresh: true });
  });

  it('keeps every mention until it is answered, once, so a second can wait while the first runs', async () => {
    const { db, thread, reply } = await seeded();
    const first = thread.id;
    const second = await reply();
    await claimThreadRun(db, { threadId: thread.id, userId: 'ben', access: 'edit', commentId: first, newChatId: 'c' });
    await claimThreadRun(db, { threadId: thread.id, userId: 'ben', access: 'edit', commentId: second, newChatId: 'x' });
    await setThreadRunChat(db, { threadId: thread.id, userId: 'ben', commentId: first, chatId: 'c' });
    await setThreadRunChat(db, { threadId: thread.id, userId: 'ben', commentId: second, chatId: 'c' });
    expect(await chatMayCloseThread(db, { threadId: thread.id, userId: 'ben', chatId: 'c' })).toBe(true);

    const end = (commentId: string, chatId?: string) =>
      endThreadRun(db, { threadId: thread.id, userId: 'ben', commentId, chatId });
    expect(await end(first, 'other')).toBe(false);
    expect(await end(first, 'c')).toBe(true);
    expect(await end(first, 'c')).toBe(false);
    expect(await chatMayCloseThread(db, { threadId: thread.id, userId: 'ben', chatId: 'c' })).toBe(true);
    expect(await end(second)).toBe(true);
    expect(await chatMayCloseThread(db, { threadId: thread.id, userId: 'ben', chatId: 'c' })).toBe(false);
  });
});
