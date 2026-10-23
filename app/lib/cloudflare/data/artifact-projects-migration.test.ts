import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

const MIGRATION = '0033_artifact_projects.sql';

/** The control-plane database as production had it before Artifacts: every migration up to this one. */
function databaseBefore() {
  const database = new sqlite.DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  for (const migration of readdirSync('migrations').sort()) {
    if (migration >= MIGRATION) {
      break;
    }
    database.exec(readFileSync(join('migrations', migration), 'utf8'));
  }
  return database;
}

describe(MIGRATION, () => {
  it("turns the team's GitHub-linked projects into imports, keeping who may work on them", () => {
    const database = databaseBefore();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('ada', 'Ada', 'ada@example.com', 1, 1, 1), ('sara', 'Sara', 'sara@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org', 'Sites', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org', 'ada', 'admin', 1), ('org', 'sara', 'member', 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
        VALUES ('team-connection', 'org', 'account', 'active', 1, 1);
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('ada-own', 'ada', 'account', 'active', 1, 1);
      INSERT INTO github_installations (org_id, installation_id, account_login, account_type, connected_by, created_at, updated_at)
        VALUES ('org', 7, 'ada', 'User', 'ada', 1, 2);
      INSERT INTO github_install_states (id, org_id, user_id, return_to, expires_at, created_at)
        VALUES ('state', 'org', 'ada', '/settings', 9, 1);
      INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_by, created_at)
        VALUES ('ff', 'org', 'ff', 1115484475, 'ada/forbidden-feminine', 'master', 'linked', 'ada', 1),
               ('sa', 'org', 'sa', 1404196644, 'ada/saraadolfsen', 'main', 'linked', 'ada', 2);
      INSERT INTO org_project_access (project_id, user_id, granted_by, granted_at) VALUES ('ff', 'sara', 'ada', 5);
      INSERT INTO production_requests (id, org_id, requested_by, title, snapshot_gzip_base64, snapshot_files, status,
        project_id, created_at)
        VALUES ('old-request', 'org', 'sara', 'Old', '', 3, 'approved', 'sa', 1);
    `);
    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    expect(
      database
        .prepare(
          `SELECT id, connection_id, org_id, import_repo_id, import_repo_full_name, import_branch, artifact_repo,
                  workers_builds_script_tag, default_branch, origin
           FROM org_projects ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'ff',
        connection_id: 'team-connection',
        org_id: 'org',
        import_repo_id: 1115484475,
        import_repo_full_name: 'ada/forbidden-feminine',
        import_branch: 'master',
        artifact_repo: null,
        workers_builds_script_tag: '6a5d7ad1d4cf487c8c39b8db7a81f6c8',
        default_branch: 'main',
        origin: 'imported',
      },
      {
        id: 'sa',
        connection_id: 'team-connection',
        org_id: 'org',
        import_repo_id: 1404196644,
        import_repo_full_name: 'ada/saraadolfsen',
        import_branch: 'main',
        artifact_repo: null,
        workers_builds_script_tag: 'd367538bf2e84573a30d43ffceaaaa0e',
        default_branch: 'main',
        origin: 'imported',
      },
    ]);
    expect(database.prepare('SELECT project_id, user_id, role, granted_at FROM org_project_access').all()).toEqual([
      { project_id: 'ff', user_id: 'sara', role: 'edit', granted_at: 5 },
    ]);
    expect(database.prepare('SELECT id, project_id, snapshot_files, repo FROM production_requests').all()).toEqual([
      { id: 'old-request', project_id: 'sa', snapshot_files: 3, repo: null },
    ]);
    expect(database.prepare('SELECT connection_id, org_id, installation_id FROM github_installations').all()).toEqual([
      { connection_id: 'team-connection', org_id: 'org', installation_id: 7 },
    ]);
    expect(database.prepare('SELECT id, connection_id FROM github_install_states').all()).toEqual([
      { id: 'state', connection_id: 'team-connection' },
    ]);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // A new request names no snapshot, and a project's access and requests still go with it.
    database.exec(`
      INSERT INTO production_requests (id, org_id, requested_by, title, status, repo, commit_sha, created_at)
        VALUES ('new-request', 'org', 'sara', 'New', 'pending', 'p-chat', '${'c'.repeat(40)}', 3);
      DELETE FROM org_projects WHERE id = 'ff';
      DELETE FROM org_projects WHERE id = 'sa';
    `);
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_project_access').get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT project_id FROM production_requests WHERE id = 'old-request'").get()).toEqual({
      project_id: null,
    });
  });

  it('refuses a project with neither a repository nor a source to import it from', () => {
    const database = databaseBefore();
    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('ada', 'Ada', 'ada@example.com', 1, 1, 1);
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('ada-own', 'ada', 'account', 'active', 1, 1);
    `);
    expect(() =>
      database.exec(
        `INSERT INTO org_projects (id, connection_id, name, origin, created_at) VALUES ('p', 'ada-own', 'P', 'imported', 1)`,
      ),
    ).toThrow(/CHECK constraint failed/);
  });
});
