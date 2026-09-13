import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { findUserWorkspaceRuntime, upsertUserWorkspaceRuntime } from './user-workspace-runtime-repository';

describe('workspace runtime locator', () => {
  it('stores and replaces the ready runtime for a user', async () => {
    const db = runtimeDatabase();

    await upsertUserWorkspaceRuntime(runtimeArgs(db, { runtimeVersion: 'a'.repeat(64), now: 1 }));
    await upsertUserWorkspaceRuntime(runtimeArgs(db, { runtimeVersion: 'b'.repeat(64), now: 2 }));

    await expect(findUserWorkspaceRuntime(db, 'user-1')).resolves.toMatchObject({
      runtimeVersion: 'b'.repeat(64),
    });
  });

  it('does not return an unfinished legacy row', async () => {
    const db = runtimeDatabase();
    await db
      .prepare(
        `INSERT INTO user_computer_runtimes
          (user_id, connection_id, connection_generation, worker_name, endpoint,
           runtime_version, status, created_at, updated_at)
         VALUES ('user-1', 'connection-1', 1, 'worker', 'https://workspace.example', 'old',
                 'provisioning', 1, 1)`,
      )
      .run();

    await expect(findUserWorkspaceRuntime(db, 'user-1')).resolves.toBeNull();
  });
});

function runtimeArgs(db: D1Database, overrides: { runtimeVersion: string; now: number }) {
  return {
    db,
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    workerName: 'worker',
    endpoint: 'https://workspace.example',
    runtimeVersion: overrides.runtimeVersion,
    imageDigest: 'docker.io/cloudflare/sandbox@sha256:test',
    now: overrides.now,
  };
}

function runtimeDatabase(): D1Database {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE user_computer_runtimes (
      user_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      connection_generation INTEGER NOT NULL,
      worker_name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      runtime_version TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      image_digest TEXT
    );
  `);
  return {
    prepare(query: string) {
      return prepared(database.prepare(query));
    },
  } as unknown as D1Database;
}

function prepared(statement: StatementSync) {
  let values: SQLInputValue[] = [];
  return {
    bind(...next: SQLInputValue[]) {
      values = next;
      return this;
    },
    async first<T>() {
      return (statement.get(...values) as T | undefined) ?? null;
    },
    async run() {
      const result = statement.run(...values);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  };
}
