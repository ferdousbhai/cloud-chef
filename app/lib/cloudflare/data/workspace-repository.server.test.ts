import { describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureInitialWorkspace, openLinkedWorkspace } from './workspace-repository.server';
import { discardEmptyWorkspace, getAllWorkspaces } from './workspace-service.server';

describe('ensureInitialWorkspace', () => {
  it('revives the empty chat a failed first message discarded', async () => {
    // The homepage keeps its chat id, so this is the ordinary "send failed, send again" path.
    const { sqlite, db } = workspaceDatabase();
    await expect(
      ensureInitialWorkspace(db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' }),
    ).resolves.toMatchObject({ id: 'chat-row', created: true });
    await discardEmptyWorkspace(db, { sessionId: 'session', id: 'chat' });
    expect(count(sqlite, 'agent_gc_candidates')).toBe(1);
    expect(count(sqlite, 'app_resource_gc_candidates')).toBe(1);

    await expect(
      ensureInitialWorkspace(db, { id: 'chat-row-2', creatorId: 'session', initialId: 'chat' }),
    ).resolves.toMatchObject({ id: 'chat-row', is_deleted: 0, has_messages: 0, created: true });

    // One catalog row and one transcript identity, and the queued cleanup is withdrawn with them.
    expect(count(sqlite, 'workspaces')).toBe(1);
    expect(count(sqlite, 'conversations')).toBe(1);
    expect(count(sqlite, 'agent_gc_candidates')).toBe(0);
    expect(count(sqlite, 'app_resource_gc_candidates')).toBe(0);
  });

  it('leaves a discarded chat that accepted content deleted', async () => {
    const { sqlite, db } = workspaceDatabase();
    await ensureInitialWorkspace(db, { id: 'chat-row', creatorId: 'session', initialId: 'chat' });
    sqlite.exec("UPDATE workspaces SET has_messages = 1, is_deleted = 1 WHERE id = 'chat-row'");

    await expect(
      ensureInitialWorkspace(db, { id: 'chat-row-2', creatorId: 'session', initialId: 'chat' }),
    ).rejects.toThrow('Unable to initialize chat');
    expect(count(sqlite, 'workspaces')).toBe(1);
  });
});

function count(sqlite: DatabaseSync, table: string): number {
  return Number(sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total);
}

/** The real user-workspace schema, so the partial unique index and agent_name uniqueness apply. */
describe('openLinkedWorkspace', () => {
  it('opens one chat per team project, already bound to it, and returns to it after', async () => {
    const { sqlite, db } = workspaceDatabase();
    const first = await openLinkedWorkspace(db, { sessionId: 'session', id: 'first-id', orgProjectId: 'project-1' });
    expect(first).toEqual({ initialId: 'first-id', created: true });
    // Bound before its agent ever starts: seeding reads the project from the row.
    expect(sqlite.prepare("SELECT org_project_id FROM workspaces WHERE initial_id = 'first-id'").get()).toEqual({
      org_project_id: 'project-1',
    });
    expect(sqlite.prepare('SELECT agent_name FROM conversations').all()).toEqual([{ agent_name: 'first-id' }]);

    await expect(
      openLinkedWorkspace(db, { sessionId: 'session', id: 'second-id', orgProjectId: 'project-1' }),
    ).resolves.toEqual({ initialId: 'first-id', created: false });
    await expect(
      openLinkedWorkspace(db, { sessionId: 'session', id: 'other-id', orgProjectId: 'project-2' }),
    ).resolves.toEqual({ initialId: 'other-id', created: true });
  });
});

describe('getAllWorkspaces', () => {
  it('lists one’s own apps, leaving out team projects and a draft an admin made a team project', async () => {
    const { sqlite, db } = workspaceDatabase();
    sqlite.exec(`
      INSERT INTO workspaces (id, creator_id, initial_id, description, timestamp, has_messages, org_project_id,
        adopted_by_org_project_id) VALUES
        ('app', 'owner', 'app', 'Garden', '2026-10-03', 1, NULL, NULL),
        ('linked', 'owner', 'linked', 'Team site', '2026-10-02', 1, 'project-1', NULL),
        ('adopted', 'owner', 'adopted', 'Old draft', '2026-10-01', 1, NULL, 'project-2');
    `);

    const listed = await getAllWorkspaces(db, { sessionId: 'owner' });

    expect(listed.map((workspace) => workspace.initialId)).toEqual(['app']);
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
