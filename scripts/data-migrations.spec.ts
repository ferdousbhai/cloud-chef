import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const controlPlaneTables = [
  'app_resource_reconcile_runs',
  'cloudflare_auth_sessions',
  'cloudflare_connections',
  'cloudflare_credentials',
  'cloudflare_oauth_states',
  'daily_maintenance_jobs',
  'user',
  'user_computer_runtimes',
];

function applyControlPlaneMigrations(db: DatabaseSync): void {
  for (const migration of readdirSync('migrations')
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  }
}

describe('Ghostbuild control-plane D1 schema', () => {
  test('ends with only the current control-plane and Computer locator schema', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyControlPlaneMigrations(db);

    expect(tableNames(db)).toEqual(controlPlaneTables);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('enforces one current Cloudflare connection and runtime per user', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyControlPlaneMigrations(db);
    db.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, cloudflare_subject)
       VALUES ('user-1', 'User', 'user@example.com', 1, 1, 1, 'subject-1')`,
    ).run();
    db.prepare(
      `INSERT INTO cloudflare_connections (
         id, user_id, account_id, status, created_at, updated_at, connection_generation
       ) VALUES ('connection-1', 'user-1', 'account-1', 'active', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO user_computer_runtimes (
         user_id, connection_id, connection_generation, worker_name, endpoint,
         runtime_version, status, created_at, updated_at
       ) VALUES ('user-1', 'connection-1', 1, 'worker', 'https://worker.example', 'version', 'ready', 1, 1)`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO cloudflare_connections (
           id, user_id, account_id, status, created_at, updated_at, connection_generation
         ) VALUES ('connection-2', 'user-1', 'account-2', 'active', 1, 1, 2)`,
        )
        .run(),
    ).toThrow(/unique constraint failed/i);
  });
});

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}
