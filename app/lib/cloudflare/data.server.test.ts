import { describe, expect, it } from 'vitest';
import { userRuntimeDataAction, userRuntimeInitialMessagesAction } from './data.server';
import { ensureInitialChat } from './data/chat-repository.server';
import { envWith, userWorkspaceDatabase } from '~/test/control-plane-d1';

describe('user runtime data refusals', () => {
  it('says an earlier conversation on a GitHub project takes no new subchat, as a conflict', async () => {
    const { database, db } = userWorkspaceDatabase();
    await ensureInitialChat(db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' });
    database.exec("UPDATE chats SET archived_at = 1 WHERE id = 'chat-row'");

    const response = await dataAction(db, 'subchats.create', { sessionId: 'session', chatId: 'chat' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'This conversation continues in a newer one. Open the project to keep working.',
    });
  });

  it('says a subchat of a chat that is not there cannot be renamed, as not found', async () => {
    const { db } = userWorkspaceDatabase();

    const response = await dataAction(db, 'subchats.setDescription', {
      sessionId: 'session',
      chatId: 'missing',
      subchatIndex: 0,
      description: 'Title',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Chat not found' });
  });
});

describe('user runtime transcript reads', () => {
  it('answers a chat that is not there as missing, in JSON', async () => {
    const { db } = userWorkspaceDatabase();

    const response = await userRuntimeInitialMessagesAction({
      request: new Request('https://runtime.example/v1/chats/messages', {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'session', chatId: 'missing' }),
      }),
      env: envWith({ DB: db }),
      userId: 'session',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'missing' });
  });
});

function dataAction(db: D1Database, path: string, args: Record<string, string | number>): Promise<Response> {
  return userRuntimeDataAction({
    request: new Request('https://runtime.example/v1/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, args }),
    }),
    env: envWith({ DB: db }),
    userId: 'session',
  });
}
