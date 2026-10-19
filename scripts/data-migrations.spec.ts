import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const controlPlaneTables = [
  'cloudflare_auth_sessions',
  'cloudflare_connections',
  'cloudflare_credentials',
  'cloudflare_oauth_states',
  'email_sign_in_tokens',
  'google_sign_in_states',
  'organization_invites',
  'organization_members',
  'organization_usage_daily',
  'organizations',
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

describe('CloudChef control-plane D1 schema', () => {
  test('ends with only the current control-plane and Computer locator schema', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyControlPlaneMigrations(db);

    expect(tableNames(db)).toEqual(controlPlaneTables);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('keeps one personal connection per user, one per organization, and one runtime per user and connection', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyControlPlaneMigrations(db);
    db.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
        ('user-1', 'User', 'user@example.com', 1, 1, 1),
        ('user-2', 'Other', 'other@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1);
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('personal-1', 'user-1', 'account-1', 'active', 1, 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
        VALUES ('org-connection', 'org-1', 'account-2', 'active', 1, 1);
    `);
    const insertConnection = (id: string, owner: string) =>
      db
        .prepare(
          `INSERT INTO cloudflare_connections (id, ${owner}, account_id, status, created_at, updated_at)
           VALUES (?, ?, 'account-3', 'active', 1, 1)`,
        )
        .run(id, owner === 'user_id' ? 'user-1' : 'org-1');
    expect(() => insertConnection('second-personal', 'user_id')).toThrow(/unique constraint failed/i);
    expect(() => insertConnection('second-org', 'org_id')).toThrow(/unique constraint failed/i);
    expect(() =>
      db.exec(
        `INSERT INTO cloudflare_connections (id, account_id, status, created_at, updated_at)
         VALUES ('ownerless', 'account-4', 'active', 1, 1)`,
      ),
    ).toThrow(/constraint failed/i);

    const insertRuntime = db.prepare(
      `INSERT INTO user_computer_runtimes (
         user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
         created_at, updated_at
       ) VALUES (?, ?, 1, 'worker', 'https://worker.example', 'version', 'ready', 1, 1)`,
    );
    // Two members of one organization, and one of them in their personal account too.
    insertRuntime.run('user-1', 'org-connection');
    insertRuntime.run('user-2', 'org-connection');
    insertRuntime.run('user-1', 'personal-1');
    expect(() => insertRuntime.run('user-1', 'org-connection')).toThrow(/unique constraint failed/i);
  });

  test('keeps one CloudChef user per Google account', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyControlPlaneMigrations(db);
    db.prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, google_subject)
       VALUES ('user-1', 'User', 'user@example.com', 1, 1, 1, 'google-1')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, google_subject)
           VALUES ('user-2', 'Other', 'other@example.com', 1, 1, 1, 'google-1')`,
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
