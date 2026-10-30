import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';

const controlPlaneTables = [
  'approval_requests',
  'apps',
  'cloudflare_auth_sessions',
  'cloudflare_authorizations',
  'cloudflare_connections',
  'cloudflare_credentials',
  'cloudflare_oauth_states',
  'command_line_logins',
  'command_line_tokens',
  'email_sign_in_tokens',
  'follows',
  'github_install_states',
  'github_installations',
  'google_sign_in_states',
  'notifications',
  'org_project_access',
  'org_projects',
  'organization_invites',
  'organization_members',
  'organization_quota_events',
  'organization_usage_daily',
  'organizations',
  'pending_copies',
  'post_comments',
  'post_likes',
  'post_media',
  'post_media_deletions',
  'post_reports',
  'posts',
  'production_requests',
  'project_deployments',
  'project_main_pushes',
  'project_main_rewrites',
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

  test("gives a person's own space and their team in the same Cloudflare account one authorization, changing no workspace", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const authorizations = migrations.indexOf('0035_cloudflare_authorizations.sql');
    for (const migration of migrations.slice(0, authorizations)) {
      db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
    }
    // Production's shape: the owner's own connection and their team's, both in one account, each with its own
    // grant and generation; the owner has a workspace in each, Sara (a member only) in the team's; and a team
    // in another account, untouched.
    db.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
        ('owner', 'Owner', 'owner@example.com', 1, 1, 1),
        ('sara', 'Sara', 'sara@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES
        ('sites', 'Sara''s sites', 'owner', 1, 1),
        ('elsewhere', 'Elsewhere', 'owner', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('sites', 'owner', 'admin', 1), ('sites', 'sara', 'member', 1), ('elsewhere', 'owner', 'admin', 1);
      INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES
        ('own-grant', 'x', 'y', 20), ('team-grant', 'x', 'y', 10), ('other-grant', 'x', 'y', 5);
      INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, status, credential_handle,
        granted_oauth_scopes_json, connected_at, created_at, updated_at, connection_generation) VALUES
        ('own', 'owner', NULL, 'account-1', 'active', 'own-grant', '["own"]', 20, 1, 20, 5),
        ('team', NULL, 'sites', 'account-1', 'active', 'team-grant', '["team"]', 10, 2, 10, 4),
        ('other', NULL, 'elsewhere', 'account-2', 'active', 'other-grant', '["other"]', 5, 3, 5, 1);
      INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
        runtime_version, status, created_at, updated_at) VALUES
        ('owner', 'own', 5, 'worker-own', 'https://own.example', 'v', 'ready', 1, 1),
        ('owner', 'team', 4, 'worker-owner-team', 'https://owner-team.example', 'v', 'ready', 1, 1),
        ('sara', 'team', 4, 'worker-sara-team', 'https://sara-team.example', 'v', 'ready', 1, 1);
    `);
    const spaces = () =>
      db
        .prepare(
          'SELECT id, user_id, org_id, account_id, status, connection_generation FROM cloudflare_connections ORDER BY id',
        )
        .all();
    const before = spaces();

    db.exec(readFileSync(`migrations/${migrations[authorizations]}`, 'utf8'));

    // One authorization per account: the owner's own grant for the shared account.
    expect(
      db
        .prepare(
          'SELECT account_id, credential_handle, granted_oauth_scopes_json FROM cloudflare_authorizations ORDER BY account_id',
        )
        .all(),
    ).toEqual([
      { account_id: 'account-1', credential_handle: 'own-grant', granted_oauth_scopes_json: '["own"]' },
      { account_id: 'account-2', credential_handle: 'other-grant', granted_oauth_scopes_json: '["other"]' },
    ]);
    // Each space keeps its id, account, status and generation, so every workspace stays as it is.
    expect(spaces()).toEqual(before);
    expect(
      db
        .prepare(
          'SELECT user_id, connection_id, connection_generation FROM user_computer_runtimes ORDER BY worker_name',
        )
        .all(),
    ).toEqual([
      { user_id: 'owner', connection_id: 'own', connection_generation: 5 },
      { user_id: 'owner', connection_id: 'team', connection_generation: 4 },
      { user_id: 'sara', connection_id: 'team', connection_generation: 4 },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // The Worker still serving while this applies writes a reconnect into the space's own row; the account's
    // authorization follows it.
    db.exec(`
      INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES ('fresh', 'x', 'y', 30);
      UPDATE cloudflare_connections SET credential_handle = 'fresh', granted_oauth_scopes_json = '["fresh"]',
        connection_generation = 5, updated_at = 30 WHERE id = 'team';
    `);
    expect(
      db
        .prepare(
          `SELECT credential_handle, granted_oauth_scopes_json FROM cloudflare_authorizations WHERE account_id = 'account-1'`,
        )
        .get(),
    ).toEqual({ credential_handle: 'fresh', granted_oauth_scopes_json: '["fresh"]' });
  });

  test("empties each space's own credential column, so a credential no authorization names can be deleted", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = readdirSync('migrations')
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const cleared = migrations.indexOf('0037_clear_space_credential_handles.sql');
    for (const migration of migrations.slice(0, cleared)) {
      db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
    }
    // Production's shape after 0035: the owner's own space and their team in one account, each space still
    // naming the credential it was connected with, and the account's authorization the owner's.
    db.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
        ('owner', 'Owner', 'owner@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES ('sites', 'Sites', 'owner', 1, 1);
      INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES
        ('own-grant', 'x', 'y', 20), ('team-grant', 'x', 'y', 10);
      INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, status, credential_handle,
        granted_oauth_scopes_json, connected_at, created_at, updated_at, connection_generation) VALUES
        ('own', 'owner', NULL, 'account-1', 'active', 'own-grant', '["own"]', 20, 1, 20, 5),
        ('team', NULL, 'sites', 'account-1', 'active', 'team-grant', '["team"]', 10, 2, 10, 4);
      UPDATE cloudflare_authorizations SET credential_handle = 'own-grant', granted_oauth_scopes_json = '["own"]';
    `);
    // The space's own column keeps the team's replaced credential from being deleted.
    expect(() => db.exec(`DELETE FROM cloudflare_credentials WHERE handle = 'team-grant'`)).toThrow(/foreign key/i);

    db.exec(readFileSync(`migrations/${migrations[cleared]}`, 'utf8'));

    expect(db.prepare('SELECT id, credential_handle FROM cloudflare_connections ORDER BY id').all()).toEqual([
      { id: 'own', credential_handle: null },
      { id: 'team', credential_handle: null },
    ]);
    expect(db.prepare('SELECT account_id, credential_handle FROM cloudflare_authorizations').all()).toEqual([
      { account_id: 'account-1', credential_handle: 'own-grant' },
    ]);
    db.exec(`DELETE FROM cloudflare_credentials WHERE handle = 'team-grant'`);
    expect(db.prepare('SELECT handle FROM cloudflare_credentials').all()).toEqual([{ handle: 'own-grant' }]);
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
