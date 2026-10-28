import { describe, expect, it } from 'vitest';
import { userRuntimeDataAction, userRuntimeInitialMessagesAction } from './data.server';
import { ensureInitialChat } from './data/chat-repository.server';
import { envWith, userWorkspaceDatabase } from '~/test/control-plane-d1';

describe('a new conversation in a chat', () => {
  it('closes the one before, then has it stop and hand its publication over to the new one', async () => {
    const { database, db } = userWorkspaceDatabase();
    await ensureInitialChat(db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' });
    const handover = { productionRevision: 'a'.repeat(64), publicationPending: true };
    const calls: unknown[] = [];
    const lastIndex = () => database.prepare('SELECT last_conversation_index AS last FROM workspaces').get()?.last;
    const BuilderAgent = {
      getByName: (name: string) => ({
        getTranscriptSnapshotForOwner: async () => ({ checkpoint: null, messages: [] }),
        settleForSuccessor: async (ownerId: string) => {
          calls.push(['settle', name, ownerId, lastIndex()]);
          return handover;
        },
        continuePublication: async (ownerId: string, value: typeof handover) =>
          calls.push(['continue', name, ownerId, value]),
      }),
    };

    const response = await dataAction(db, 'subchats.create', { chatId: 'chat' }, { BuilderAgent });

    expect(await response.json()).toEqual({ result: 1 });
    // Already closed when it is asked to stop, so it refuses new work whatever happens next.
    expect(calls).toEqual([
      ['settle', 'chat', 'session', 1],
      ['continue', 'chat--transcript-1-0', 'session', handover],
    ]);
  });

  it('is started even when the one before cannot hand over, and the new one publishes again', async () => {
    const { db } = userWorkspaceDatabase();
    await ensureInitialChat(db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' });
    const BuilderAgent = {
      getByName: () => ({
        getTranscriptSnapshotForOwner: async () => ({ checkpoint: null, messages: [] }),
        settleForSuccessor: async () => {
          throw new Error('The earlier conversation did not settle in time.');
        },
      }),
    };

    const response = await dataAction(db, 'subchats.create', { chatId: 'chat' }, { BuilderAgent });

    expect(await response.json()).toEqual({ result: 1 });
  });
});

describe('user runtime data refusals', () => {
  it('says a subchat of a chat that is not there cannot be renamed, as not found', async () => {
    const { db } = userWorkspaceDatabase();

    const response = await dataAction(db, 'subchats.setDescription', {
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
        body: JSON.stringify({ chatId: 'missing' }),
      }),
      env: envWith({ DB: db }),
      userId: 'session',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'missing' });
  });
});

function dataAction(
  db: D1Database,
  path: string,
  args: Record<string, string | number>,
  bindings: { BuilderAgent?: object } = {},
): Promise<Response> {
  return userRuntimeDataAction({
    request: new Request('https://runtime.example/v1/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, args }),
    }),
    // SAFETY: the data operation reaches the agents only through the methods each fake implements.
    env: envWith({ DB: db, ...(bindings as Partial<Env>) }),
    userId: 'session',
  });
}
