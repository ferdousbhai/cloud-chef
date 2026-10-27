import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

const MIGRATION = '0045_public_projects_and_copies.sql';

/** The control-plane database before public projects: every migration up to this one. */
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
  it('keeps every project with its grants, requests and publishes, all private, and drops what 0039 and 0040 left', () => {
    const database = databaseBefore();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
        ('ada', 'Ada', 'ada@example.com', 1, 1, 1), ('sara', 'Sara', 'sara@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES ('org', 'Team', 'ada', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org', 'sara', 'member', 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
        VALUES ('team', 'org', 'account', 'active', 1, 1);
      INSERT INTO org_projects (id, connection_id, org_id, name, slug, artifact_repo, created_from, deploys_with,
          deploy_worker_name, created_by, created_at)
        VALUES ('site', 'team', 'org', 'Site', 'site', 't-site', 'zip', 'cloudchef', 'site', 'ada', 1);
      INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at)
        VALUES ('site', 'sara', 'view', 'ada', 2);
      INSERT INTO production_requests (id, org_id, requested_by, title, status, project_id, created_at)
        VALUES ('request', 'org', 'sara', 'Site', 'approved', 'site', 3);
      INSERT INTO project_deployments (id, project_id, kind, branch, commit_sha, state, attempt, created_at,
          updated_at, step) VALUES ('deploy', 'site', 'production', 'main', '${'a'.repeat(40)}', 'succeeded', 1, 4, 5,
          'publishing');
    `);

    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    expect(
      database
        .prepare('SELECT id, slug, created_from, visibility, copied_from, deploy_worker_name FROM org_projects')
        .all(),
    ).toEqual([
      {
        id: 'site',
        slug: 'site',
        created_from: 'zip',
        visibility: 'private',
        copied_from: null,
        deploy_worker_name: 'site',
      },
    ]);
    expect(database.prepare('SELECT project_id, role FROM org_project_access').all()).toEqual([
      { project_id: 'site', role: 'view' },
    ]);
    expect(database.prepare('SELECT id, project_id FROM production_requests').all()).toEqual([
      { id: 'request', project_id: 'site' },
    ]);
    expect(database.prepare('SELECT id, project_id, step FROM project_deployments').all()).toEqual([
      { id: 'deploy', project_id: 'site', step: 'publishing' },
    ]);
    const columns = database.prepare(`SELECT name FROM pragma_table_info('org_projects')`).all();
    expect(columns).not.toContainEqual({ name: 'origin' });
    expect(
      database.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'org_projects'`).all(),
    ).toEqual([]);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // A copy names what it was copied from; a public project is one with that visibility.
    database.exec(`INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, created_from, copied_from,
      visibility, created_by, created_at) VALUES ('copy', 'team', 'org', 'Copy', 't-copy', 'copy', 'site', 'public',
      'sara', 6)`);
    expect(() => database.exec(`UPDATE org_projects SET visibility = 'unlisted' WHERE id = 'copy'`)).toThrow(/CHECK/);
    database.exec(`DELETE FROM org_projects WHERE id = 'site'`);
    expect(database.prepare(`SELECT copied_from FROM org_projects WHERE id = 'copy'`).get()).toEqual({
      copied_from: null,
    });
  });
});
