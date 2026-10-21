import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureInitialChat,
  isChatArchived,
  listLinkedChatHistory,
  openLinkedChat,
  startLinkedChat,
} from './chat-repository.server';
import { removeChat } from './chat-service.server';
import { discardEmptyChat } from './chat-service.server';

describe('ensureInitialChat', () => {
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
describe('openLinkedChat', () => {
  it('opens one chat per GitHub project, already bound to it, and returns to it after', async () => {
    const { sqlite, db } = workspaceDatabase();
    const first = await openLinkedChat(db, { sessionId: 'session', id: 'first-id', orgProjectId: 'project-1' });
    expect(first).toEqual({ initialId: 'first-id', created: true });
    // Bound before its agent ever starts: seeding reads the project from the row.
    expect(sqlite.prepare("SELECT org_project_id FROM chats WHERE initial_id = 'first-id'").get()).toEqual({
      org_project_id: 'project-1',
    });
    expect(sqlite.prepare('SELECT agent_name FROM chat_transcripts').all()).toEqual([{ agent_name: 'first-id' }]);

    await expect(
      openLinkedChat(db, { sessionId: 'session', id: 'second-id', orgProjectId: 'project-1' }),
    ).resolves.toEqual({ initialId: 'first-id', created: false });
    await expect(
      openLinkedChat(db, { sessionId: 'session', id: 'other-id', orgProjectId: 'project-2' }),
    ).resolves.toEqual({ initialId: 'other-id', created: true });
  });
});

describe('startLinkedChat', () => {
  const project = { sessionId: 'session', orgProjectId: 'project-1' };

  it('keeps an empty current conversation, since it is already new', async () => {
    const { db } = workspaceDatabase();
    await openLinkedChat(db, { ...project, id: 'first-id' });
    await expect(startLinkedChat(db, { ...project, id: 'second-id' })).resolves.toEqual({
      initialId: 'first-id',
      archivedAgentNames: [],
    });
  });

  it('archives the current conversation and starts one that continues its workspace', async () => {
    const { sqlite, db } = workspaceDatabase();
    await openLinkedChat(db, { ...project, id: 'first-id' });
    sqlite.prepare("UPDATE chats SET has_messages = 1, description = 'Fix the footer'").run();

    // The archived conversation's agents are named, for the caller to stop.
    await expect(startLinkedChat(db, { ...project, id: 'second-id' })).resolves.toEqual({
      initialId: 'second-id',
      archivedAgentNames: ['first-id'],
    });
    await expect(isChatArchived(db, { sessionId: 'session', id: 'first-id' })).resolves.toBe(true);
    await expect(isChatArchived(db, { sessionId: 'session', id: 'second-id' })).resolves.toBe(false);
    expect(
      sqlite
        .prepare(
          'SELECT initial_id, archived_at IS NOT NULL AS archived, continues_agent_name FROM chats ORDER BY archived_at IS NULL',
        )
        .all(),
    ).toEqual([
      { initial_id: 'first-id', archived: 1, continues_agent_name: null },
      { initial_id: 'second-id', archived: 0, continues_agent_name: 'first-id' },
    ]);
    expect(sqlite.prepare("SELECT agent_name FROM chat_transcripts WHERE agent_name = 'second-id'").get()).toEqual({
      agent_name: 'second-id',
    });
    // Opening the project now returns to the new conversation; the old one is listed as earlier.
    await expect(openLinkedChat(db, { ...project, id: 'third-id' })).resolves.toEqual({
      initialId: 'second-id',
      created: false,
    });
    await expect(listLinkedChatHistory(db, project)).resolves.toEqual([
      { initialId: 'first-id', description: 'Fix the footer', archivedAt: expect.any(Number) },
    ]);
  });

  it('starts one conversation when two tabs start one at once', async () => {
    const { sqlite, db } = workspaceDatabase();
    await openLinkedChat(db, { ...project, id: 'first-id' });
    sqlite.prepare('UPDATE chats SET has_messages = 1').run();

    const [one, other] = await Promise.all([
      startLinkedChat(db, { ...project, id: 'tab-a' }),
      startLinkedChat(db, { ...project, id: 'tab-b' }),
    ]);
    expect(other.initialId).toEqual(one.initialId);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS current FROM chats WHERE archived_at IS NULL AND is_deleted = 0').get(),
    ).toEqual({ current: 1 });
  });

  it('continues the agent holding the current workspace when the conversation has a later subchat', async () => {
    const { sqlite, db } = workspaceDatabase();
    await openLinkedChat(db, { ...project, id: 'first-id' });
    sqlite
      .prepare(
        `INSERT INTO chat_transcripts (chat_id, subchat_index, generation, agent_name, transition_token, created_at, updated_at)
         SELECT id, 1, 0, 'first-id--transcript-1-0', 'token', 1, 1 FROM chats`,
      )
      .run();
    sqlite.prepare('UPDATE chats SET has_messages = 1, last_subchat_index = 1').run();

    await expect(startLinkedChat(db, { ...project, id: 'second-id' })).resolves.toMatchObject({
      archivedAgentNames: ['first-id', 'first-id--transcript-1-0'],
    });
    expect(sqlite.prepare("SELECT continues_agent_name FROM chats WHERE initial_id = 'second-id'").get()).toEqual({
      continues_agent_name: 'first-id--transcript-1-0',
    });
  });

  it('hands the project back to the latest earlier conversation when the current one is removed', async () => {
    const { sqlite, db } = workspaceDatabase();
    const current = () =>
      sqlite
        .prepare('SELECT initial_id FROM chats WHERE archived_at IS NULL AND is_deleted = 0 ORDER BY initial_id')
        .all();
    await openLinkedChat(db, { ...project, id: 'first-id' });
    sqlite.prepare('UPDATE chats SET has_messages = 1').run();
    await startLinkedChat(db, { ...project, id: 'second-id' });
    sqlite.prepare('UPDATE chats SET has_messages = 1').run();
    await startLinkedChat(db, { ...project, id: 'third-id' });
    // Another project's conversation is not touched.
    await openLinkedChat(db, { sessionId: 'session', id: 'other-id', orgProjectId: 'project-2' });

    // Removing an earlier one changes nothing about which is current.
    await removeChat(db, { sessionId: 'session', id: 'first-id' });
    expect(current()).toEqual([{ initial_id: 'other-id' }, { initial_id: 'third-id' }]);

    await removeChat(db, { sessionId: 'session', id: 'third-id' });
    expect(current()).toEqual([{ initial_id: 'other-id' }, { initial_id: 'second-id' }]);
    await expect(openLinkedChat(db, { ...project, id: 'fourth-id' })).resolves.toEqual({
      initialId: 'second-id',
      created: false,
    });
  });
});

function workspaceDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../../../user-workspace-migrations/', import.meta.url).pathname;
  for (const file of readdirSync(directory).sort()) {
    sqlite.exec(readFileSync(join(directory, file), 'utf8'));
  }
  const bound = (query: string, values: SQLInputValue[]) => ({
    first: async () => sqlite.prepare(query).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(query).all(...values) }),
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
