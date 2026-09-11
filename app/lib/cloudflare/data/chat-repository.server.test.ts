import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureInitialChat, markChatStarted } from './chat-repository.server';
import { discardEmptyChat } from './chat-service.server';
import type { ChatRow } from './types';

describe('chat catalog visibility', () => {
  it('records only that an owner-scoped Agent accepted content', async () => {
    const database = new ChatRepositoryDatabase();

    await markChatStarted(database.db, {
      sessionId: 'session',
      chatId: 'chat',
      agentName: 'chat',
    });

    expect(database.runStatements).toHaveLength(1);
    expect(database.runStatements[0].query).toContain('SET has_messages = 1');
    expect(database.runStatements[0].query).toContain('chat_transcripts.agent_name = ?');
    expect(database.runStatements[0].values).toEqual(['session', 'chat', 'chat']);
    expect(database.runStatements[0].query).not.toMatch(/head_revision|head_digest|message_rank|part_index/);
  });
});

describe('ensureInitialChat', () => {
  it('creates only the chat catalog row and BuilderAgent transcript identity', async () => {
    const database = new ChatRepositoryDatabase();

    await expect(
      ensureInitialChat(database.db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' }),
    ).resolves.toMatchObject({ id: 'chat-row', created: true });

    expect(database.batchStatements).toHaveLength(5);
    expect(database.batchStatements[0].query).toContain('UPDATE chats');
    expect(database.batchStatements[1].query).toContain('DELETE FROM agent_gc_candidates');
    expect(database.batchStatements[2].query).toContain('DELETE FROM app_resource_gc_candidates');
    expect(database.batchStatements[3].query).toContain('INSERT INTO chats');
    expect(database.batchStatements[4].query).toContain('INSERT INTO chat_transcripts');
    expect(database.batchStatements.map((statement) => statement.query).join('\n')).not.toMatch(
      /head_revision|head_digest|message_rank|part_index/,
    );
  });

  it('revives the empty chat a failed first message discarded', async () => {
    // The homepage keeps its chat id, so this is the ordinary "send failed, send again" path.
    const { sqlite, db } = workspaceDatabase();
    await expect(
      ensureInitialChat(db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' }),
    ).resolves.toMatchObject({ id: 'chat-row', created: true });
    await discardEmptyChat(db, { sessionId: 'session', id: 'chat' });
    expect(count(sqlite, 'agent_gc_candidates')).toBe(1);
    expect(count(sqlite, 'app_resource_gc_candidates')).toBe(1);

    await expect(
      ensureInitialChat(db, { id: 'chat-row-2', creatorId: 'session', initialId: 'chat' }),
    ).resolves.toMatchObject({ id: 'chat-row', is_deleted: 0, has_messages: 0, created: true });

    // One catalog row and one transcript identity, and the queued cleanup is withdrawn with them.
    expect(count(sqlite, 'chats')).toBe(1);
    expect(count(sqlite, 'chat_transcripts')).toBe(1);
    expect(count(sqlite, 'agent_gc_candidates')).toBe(0);
    expect(count(sqlite, 'app_resource_gc_candidates')).toBe(0);
  });

  it('leaves a discarded chat that accepted content deleted', async () => {
    const { sqlite, db } = workspaceDatabase();
    await ensureInitialChat(db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' });
    sqlite.exec("UPDATE chats SET has_messages = 1, is_deleted = 1 WHERE id = 'chat-row'");

    await expect(ensureInitialChat(db, { id: 'chat-row-2', creatorId: 'session', initialId: 'chat' })).rejects.toThrow(
      'Unable to initialize chat',
    );
    expect(count(sqlite, 'chats')).toBe(1);
  });
});

function count(sqlite: DatabaseSync, table: string): number {
  return Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total);
}

/** The real user-workspace schema, so the partial unique index and agent_name uniqueness apply. */
function workspaceDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../../../user-workspace-migrations/', import.meta.url).pathname;
  for (const file of readdirSync(directory).sort()) {
    sqlite.exec(readFileSync(join(directory, file), 'utf8'));
  }
  const bound = (query: string, values: SQLInputValue[]) => ({
    first: async () => sqlite.prepare(query).get(...values) ?? null,
    run: async () => {
      const result = sqlite.prepare(query).run(...values);
      // SAFETY: the repository reads only `meta.changes`, which this reports from SQLite itself.
      return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
    },
  });
  const db = asD1Database({
    prepare: (query: string) => ({ bind: (...values: SQLInputValue[]) => bound(query, values) }),
    batch: async (statements: D1PreparedStatement[]) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results: D1Result[] = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  });
  return { sqlite, db };
}

type D1DatabaseStub = {
  prepare: (query: string) => object;
  batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
};

/**
 * SAFETY: the stub supplies the `prepare`/`bind`/`first`/`run`/`batch` surface these repository
 * functions actually reach for; the rest of the D1 surface is never called.
 */
function asD1Database(database: D1DatabaseStub): D1Database {
  return database as unknown as D1Database;
}

function chat(): ChatRow {
  return {
    id: 'chat-row',
    creator_id: 'session',
    initial_id: 'chat',
    description: null,
    timestamp: '2026-08-01T00:00:00.000Z',
    last_subchat_index: 0,
    has_messages: 0,
    is_deleted: 0,
  };
}

class ChatRepositoryDatabase {
  readonly batchStatements: PreparedStatement[] = [];
  readonly runStatements: PreparedStatement[] = [];
  readonly db: D1Database;

  constructor() {
    this.db = asD1Database({
      prepare: (query: string) => new PreparedStatement(query, this.runStatements),
      batch: async (statements: D1PreparedStatement[]) => {
        this.batchStatements.push(...(statements as unknown as PreparedStatement[]));
        return statements.map(() => ({ meta: { changes: 1 } })) as D1Result[];
      },
    });
  }
}

class PreparedStatement {
  values: unknown[] = [];

  constructor(
    readonly query: string,
    private readonly runStatements: PreparedStatement[] = [],
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.query.includes('FROM chats') ? (chat() as T) : null;
  }

  async run(): Promise<D1Result> {
    this.runStatements.push(this);
    return { meta: { changes: 1 } } as D1Result;
  }
}
