import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createSubchat, discardEmptyChat, getAllChats, getSubchats, removeChat } from './chat-service.server';
import type { ChatRow, ChatTranscriptRow } from './types';
import { AGENT_GC_GRACE_PERIOD_MS } from './agent-gc.server';

describe('empty chat lifecycle', () => {
  it('discards a titled empty chat while preserving chats with durable content', async () => {
    const database = emptyChatDatabase();
    const insertChat = database.sqlite.prepare(
      `INSERT INTO workspaces (
         id, creator_id, initial_id, description, has_messages, is_deleted
       ) VALUES (?, 'owner', ?, ?, ?, 0)`,
    );
    insertChat.run('empty-row', 'empty', '**Generated title**', 0);
    insertChat.run('message-row', 'message', 'Message project', 1);
    for (const chatId of ['empty-row', 'message-row']) {
      database.sqlite
        .prepare(
          `INSERT INTO conversations (workspace_id, conversation_index)
           VALUES (?, 0)`,
        )
        .run(chatId);
    }

    await discardEmptyChat(database.db, { sessionId: 'owner', id: 'empty' });
    await discardEmptyChat(database.db, { sessionId: 'owner', id: 'message' });

    expect(database.sqlite.prepare(`SELECT id, is_deleted FROM workspaces ORDER BY id`).all()).toEqual([
      { id: 'empty-row', is_deleted: 1 },
      { id: 'message-row', is_deleted: 0 },
    ]);
    expect(database.sqlite.prepare(`SELECT workspace_id FROM agent_gc_candidates`).all()).toEqual([
      { workspace_id: 'empty-row' },
    ]);
    expect(database.sqlite.prepare(`SELECT workspace_id FROM app_resource_gc_candidates`).all()).toEqual([
      { workspace_id: 'empty-row' },
    ]);
  });
});

describe('chat reads', () => {
  it('lists every chat of ones own newest first', async () => {
    const all = vi.fn().mockResolvedValue({
      results: ['c', 'b', 'a'].map((id) => ({
        initial_id: `initial-${id}`,
        description: null,
        timestamp: '2026-02-03T04:05:06.000Z',
      })),
    });
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    // SAFETY: getAllChats calls only prepare().bind().all(), which this stub provides.
    const db = { prepare } as unknown as D1Database;

    const chats = await getAllChats(db, { sessionId: 'user-1' });

    expect(chats.map((chat) => chat.initialId)).toEqual(['initial-c', 'initial-b', 'initial-a']);
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY workspaces.timestamp DESC, workspaces.id DESC'),
    );
    // A GitHub project's chat is listed with the GitHub projects, never also as one of the user's apps.
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('AND workspaces.org_project_id IS NULL'));
    expect(bind).toHaveBeenCalledWith('user-1');
  });

  it('lists every subchat of a chat in order', async () => {
    const subchatRows = [0, 1, 2].map((subchatIndex) => ({
      conversation_index: subchatIndex,
      description: null,
      updated_at: subchatIndex,
      agent_name: `chat--transcript-${subchatIndex}-0`,
    }));
    const all = vi.fn().mockResolvedValue({ results: subchatRows });
    const first = vi.fn().mockResolvedValue({
      id: 'chat-row',
      creator_id: 'user-1',
      initial_id: 'chat',
      description: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      last_conversation_index: 2,
      is_deleted: 0,
    });
    const binds: unknown[][] = [];
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...values: unknown[]) => {
        binds.push(values);
        return query.includes('SELECT workspaces.id') ? { first } : { all };
      }),
    }));

    // SAFETY: getSubchats calls only prepare().bind().first() and .all(), which this stub provides.
    const subchats = await getSubchats({ prepare } as unknown as D1Database, { sessionId: 'user-1', chatId: 'chat' });

    expect(subchats.map((item) => item.subchatIndex)).toEqual([0, 1, 2]);
    expect(binds).toEqual([['user-1', 'chat'], ['chat-row']]);
  });
});

describe('chat deletion', () => {
  it('queues BuilderAgent cleanup before atomically clearing chat metadata', async () => {
    const statements: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn((...values: unknown[]) => ({
          query,
          values,
          run: vi.fn(),
        })),
      })),
      batch: vi.fn(async (batch: Array<{ query: string; values: unknown[] }>) => {
        statements.push(...batch);
        return [];
      }),
    } as unknown as D1Database;

    await removeChat(db, { sessionId: 'owner', id: 'chat' });

    expect(statements).toHaveLength(3);
    expect(statements[0].query).toContain('INSERT INTO agent_gc_candidates');
    expect(statements[0].query).toContain('JOIN conversations');
    expect(Number(statements[0].values[0]) - Number(statements[0].values[1])).toBe(AGENT_GC_GRACE_PERIOD_MS);
    expect(statements[1].query).toContain('INSERT INTO app_resource_gc_candidates');
    expect(statements[2].query).toContain('SET is_deleted = 1');
    expect(statements[2].query).not.toContain('snapshot_key');
  });
});

describe('subchat creation', () => {
  it('rejects subchat creation at the validated index ceiling', async () => {
    const database = subchatDatabase();

    await expect(
      createSubchat(database.db, {
        sessionId: 'user-1',
        chat: { ...latestChat, last_conversation_index: 10_000 },
        parent: latestTranscript,
        parentRevision: 0,
      }),
    ).rejects.toThrow('maximum number of subchats');
    expect(database.statements).toHaveLength(0);
  });

  it('creates a subchat with its own agent identity and parent checkpoint', async () => {
    const database = subchatDatabase();

    const created = await createSubchat(database.db, {
      sessionId: 'user-1',
      chat: latestChat,
      parent: latestTranscript,
      parentRevision: 9,
    });

    expect(created).toBe(3);
    const transcriptInsert = database.statements[0];
    expect(transcriptInsert.query).toContain('INSERT INTO conversations');
    expect(transcriptInsert.values.slice(0, 5)).toEqual(['chat-row', 3, 'chat--transcript-3-0', 2, 9]);
    expect(transcriptInsert.query).toContain('WHERE workspace_id = ? AND conversation_index = ?');
    expect(transcriptInsert.query).toContain('workspaces.is_deleted = 0');
    expect(transcriptInsert.values.at(-1)).toBe('user-1');
    expect(database.statements[1].query).toContain('last_conversation_index = ?');
  });

  it('rejects subchat creation when the chat changes before the batch', async () => {
    const database = subchatDatabase([0, 0]);

    await expect(
      createSubchat(database.db, {
        sessionId: 'user-1',
        chat: latestChat,
        parent: latestTranscript,
        parentRevision: 9,
      }),
    ).rejects.toThrow('Chat transcript changed while creating a subchat');
  });
});

function emptyChatDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      initial_id TEXT NOT NULL,
      description TEXT,
      timestamp TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      last_conversation_index INTEGER NOT NULL DEFAULT 0,
      has_messages INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      workspace_id TEXT NOT NULL,
      conversation_index INTEGER NOT NULL
    );
    CREATE TABLE agent_gc_candidates (
      workspace_id TEXT NOT NULL,
      initial_id TEXT NOT NULL,
      conversation_index INTEGER NOT NULL,
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, conversation_index)
    );
    CREATE TABLE app_resource_gc_candidates (
      workspace_id TEXT PRIMARY KEY,
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
  `);
  const db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => sqlite.prepare(query).get(...(values as SQLInputValue[])) ?? null,
        run: async () => {
          const result = sqlite.prepare(query).run(...(values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        },
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = await Promise.all(statements.map((statement) => statement.run()));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

type BoundStatement = { query: string; values: unknown[] };

const latestChat: ChatRow = {
  id: 'chat-row',
  creator_id: 'user-1',
  initial_id: 'chat',
  description: null,
  timestamp: '2026-01-01T00:00:00.000Z',
  last_conversation_index: 2,
  has_messages: 1,
  is_deleted: 0,
};

const latestTranscript: ChatTranscriptRow = {
  workspace_id: 'chat-row',
  conversation_index: 2,
  agent_name: 'chat--transcript-2-0',
  description: 'Feature',
  parent_conversation_index: 1,
  parent_revision: 3,
  transition_token: 'previous-transition',
  created_at: 1,
  updated_at: 2,
};

/** A database whose one batch reports `batchChanges` rows changed by each statement. */
function subchatDatabase(batchChanges = [1, 1]) {
  const statements: BoundStatement[] = [];
  // SAFETY: createSubchat only prepares, binds, and batches statements, which this stub provides.
  const db = {
    prepare: (query: string) => ({ bind: (...values: unknown[]) => ({ query, values }) }),
    batch: async (batch: BoundStatement[]) => {
      statements.push(...batch);
      return batch.map((_statement, index) => ({ success: true, meta: { changes: batchChanges[index] ?? 1 } }));
    },
  } as unknown as D1Database;
  return { db, statements };
}
