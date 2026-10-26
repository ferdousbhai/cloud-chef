import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

const MIGRATION = '0038_uploaded_projects.sql';

/** The control-plane database before projects could be uploaded: every migration up to this one. */
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
  it('records what every project was made from, keeping who may work on it and the requests naming it', () => {
    const database = databaseBefore();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('ada', 'Ada', 'ada@example.com', 1, 1, 1), ('sara', 'Sara', 'sara@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org', 'Sites', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org', 'ada', 'admin', 1), ('org', 'sara', 'member', 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
        VALUES ('team-connection', 'org', 'account', 'active', 1, 1);
      INSERT INTO org_projects (id, connection_id, org_id, name, import_repo_full_name, import_branch, artifact_repo,
        workers_builds_script_tag, site_url, origin, created_by, created_at)
        VALUES ('ff', 'team-connection', 'org', 'ff', 'ada/ff', 'main', 't-ff', 'tag', 'https://ff.example', 'imported', 'ada', 1),
               ('recipes', 'team-connection', 'org', 'Recipes', NULL, NULL, 'p-recipes', NULL, NULL, 'promoted', 'ada', 2);
      INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at) VALUES ('ff', 'sara', 'view', 'ada', 5);
      INSERT INTO production_requests (id, org_id, requested_by, title, status, project_id, created_at, draft_id, repo, commit_sha)
        VALUES ('request', 'org', 'sara', 'Recipes', 'approved', 'recipes', 1, 'draft', 'p-recipes', '${'a'.repeat(40)}');
    `);
    const projectsBefore = database.prepare('SELECT * FROM org_projects ORDER BY id').all();
    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    expect(database.prepare('SELECT * FROM org_projects ORDER BY id').all()).toEqual(
      projectsBefore.map((project) => ({
        ...project,
        created_from: project.origin === 'promoted' ? 'draft' : 'github',
      })),
    );
    expect(
      database.prepare('SELECT project_id, user_id, role, granted_by, granted_at FROM org_project_access').all(),
    ).toEqual([{ project_id: 'ff', user_id: 'sara', role: 'view', granted_by: 'ada', granted_at: 5 }]);
    expect(database.prepare('SELECT id, project_id, repo, commit_sha FROM production_requests').all()).toEqual([
      { id: 'request', project_id: 'recipes', repo: 'p-recipes', commit_sha: 'a'.repeat(40) },
    ]);
    database.exec(`
      INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, created_from, created_at)
        VALUES ('zip', 'team-connection', 'org', 'Bakery', 't-zip', 'zip', 3);
      INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, origin, created_at)
        VALUES ('old-worker', 'team-connection', 'org', 'Added during rollout', 'p-old', 'promoted', 4);
    `);
    // What the Worker serving during rollout adds is filled in from its origin.
    expect(
      database.prepare(`SELECT id, created_from FROM org_projects WHERE id IN ('zip', 'old-worker') ORDER BY id`).all(),
    ).toEqual([
      { id: 'old-worker', created_from: 'draft' },
      { id: 'zip', created_from: 'zip' },
    ]);
    expect(() =>
      database.exec(`INSERT INTO org_projects (id, connection_id, name, artifact_repo, created_from, created_at)
        VALUES ('other', 'team-connection', 'Other', 't-other', 'svn', 5)`),
    ).toThrow(/CHECK/);
    // Removing a project still removes its grants.
    database.exec(`DELETE FROM org_projects WHERE id = 'ff'`);
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_project_access').get()).toEqual({ n: 0 });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
