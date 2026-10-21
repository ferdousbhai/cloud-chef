import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const controlPlaneTables = [
  'cloudflare_auth_sessions',
  'cloudflare_connections',
  'cloudflare_credentials',
  'cloudflare_oauth_states',
  'email_sign_in_tokens',
  'github_approval_states',
  'github_install_states',
  'github_installations',
  'google_sign_in_states',
  'org_project_access',
  'org_projects',
  'organization_invites',
  'organization_members',
  'organization_quota_events',
  'organization_usage_daily',
  'organizations',
  'production_requests',
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
  test('counts every runtime as just used when the upgrade window arrives, so none is upgraded under a running turn', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const upgradeWindow = migrations.indexOf('0028_workspace_runtime_upgrade_window.sql');
    for (const migration of migrations.slice(0, upgradeWindow)) {
      db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
    }
    db.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('user-1', 'User', 'user@example.com', 1, 1, 1);
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('connection-1', 'user-1', 'account-1', 'active', 1, 1);
      INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
        runtime_version, status, created_at, updated_at)
        VALUES ('user-1', 'connection-1', 1, 'worker', 'https://workspace.example', 'old', 'ready', 1, 1);
    `);
    const before = Date.now() - 1_000;

    db.exec(readFileSync(`migrations/${migrations[upgradeWindow]}`, 'utf8'));

    const row = db.prepare('SELECT protocol_version, last_session_at FROM user_computer_runtimes').get();
    expect(row?.protocol_version).toBeNull();
    expect(Number(row?.last_session_at)).toBeGreaterThanOrEqual(before);
  });

  test('counts invites already sent and teams already made toward the limits, and empties decided requests', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const quotaEvents = migrations.indexOf('0030_organization_quota_events.sql');
    for (const migration of migrations.slice(0, quotaEvents)) {
      db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
    }
    db.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('user-1', 'User', 'user@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES
        ('org-1', 'Acme', 'user-1', 10, 10),
        ('org-2', 'Orphan', NULL, 11, 11);
      INSERT INTO organization_invites (id, org_id, email, role, token_hash, invited_by, expires_at, created_at)
        VALUES ('invite-1', 'org-1', 'sam@example.com', 'member', 'hash', 'user-1', 99, 20);
      INSERT INTO production_requests (id, org_id, requested_by, title, note, preview_url, snapshot_gzip_base64,
        snapshot_files, status, created_at) VALUES
        ('request-1', 'org-1', 'user-1', 'Site', 'Please', 'https://p.example', '', 3, 'declined', 1),
        ('request-2', 'org-1', 'user-1', 'Shop', 'Soon', 'https://q.example', 'gz', 4, 'pending', 2);
    `);

    db.exec(readFileSync(`migrations/${migrations[quotaEvents]}`, 'utf8'));

    expect(
      db.prepare('SELECT kind, user_id, org_id, created_at FROM organization_quota_events ORDER BY created_at').all(),
    ).toEqual([
      { kind: 'team', user_id: 'user-1', org_id: 'org-1', created_at: 10 },
      { kind: 'invite', user_id: 'user-1', org_id: 'org-1', created_at: 20 },
    ]);
    expect(db.prepare('SELECT id, title, note, preview_url FROM production_requests ORDER BY id').all()).toEqual([
      { id: 'request-1', title: 'Site', note: null, preview_url: null },
      { id: 'request-2', title: 'Shop', note: 'Soon', preview_url: 'https://q.example' },
    ]);
    // Deleting the team or revoking the invite leaves the log; erasing the person takes their entries.
    db.exec(`DELETE FROM organizations WHERE id = 'org-1'`);
    expect(db.prepare('SELECT COUNT(*) AS count FROM organization_quota_events').get()?.count).toBe(2);
    db.exec(`DELETE FROM "user" WHERE id = 'user-1'`);
    expect(db.prepare('SELECT COUNT(*) AS count FROM organization_quota_events').get()?.count).toBe(0);
  });

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
