import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

const MIGRATION = '0074_personal_spaces.sql';

/** The control-plane database while a person's own Cloudflare account was a connection of theirs alone. */
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

/** Ada with her own Cloudflare account, a project and a workspace there, and a team she is in beside it. */
function withAda(database: NodeSqlite.DatabaseSync) {
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
      ('ada', 'Ada Lovelace', 'ada@example.com', 1, 1, 1), ('bo', '', 'bo@example.com', 1, 1, 1);
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('acme', 'Acme', 1, 1);
    INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('acme', 'ada', 'member', 1);
    INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, status, created_at, updated_at,
      connection_generation) VALUES
      ('ada-own', 'ada', NULL, 'account-ada', 'active', 5, 6, 3),
      ('acme-connection', NULL, 'acme', 'account-acme', 'active', 1, 1, 1);
    INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, created_from, created_by, created_at)
      VALUES ('mine', 'ada-own', NULL, 'Mine', 't-mine', 'chat', 'ada', 7),
             ('shop', 'acme-connection', 'acme', 'Shop', 't-shop', 'chat', 'ada', 8);
    INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
      runtime_version, status, created_at, updated_at)
      VALUES ('ada', 'ada-own', 3, 'cloudchef-workspace-1', 'https://runtime.example', 'sha', 'ready', 1, 1);
    INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at,
      context_connection_id) VALUES ('session', 'ada', 'hash', 9999999999999, 1, 1, 'ada-own');
  `);
}

describe(MIGRATION, () => {
  it('makes a person’s own Cloudflare account a space with them alone in it, keeping its connection as it was', () => {
    const database = databaseBefore();
    withAda(database);

    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    expect(
      database.prepare('SELECT id, name, created_by, personal_user_id FROM organizations ORDER BY id').all(),
    ).toEqual([
      { id: 'acme', name: 'Acme', created_by: null, personal_user_id: null },
      { id: 'ada-own', name: 'Ada’s space', created_by: 'ada', personal_user_id: 'ada' },
    ]);
    expect(
      database
        .prepare("SELECT user_id, role, paused_at, drafts_allowed FROM organization_members WHERE org_id = 'ada-own'")
        .all(),
    ).toEqual([{ user_id: 'ada', role: 'admin', paused_at: null, drafts_allowed: 1 }]);
    // The connection is the same row: what is keyed by it (her session, her workspace, her projects) still finds it.
    expect(
      database
        .prepare(
          'SELECT id, user_id, org_id, account_id, status, connection_generation FROM cloudflare_connections ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'acme-connection',
        user_id: null,
        org_id: 'acme',
        account_id: 'account-acme',
        status: 'active',
        connection_generation: 1,
      },
      {
        id: 'ada-own',
        user_id: null,
        org_id: 'ada-own',
        account_id: 'account-ada',
        status: 'active',
        connection_generation: 3,
      },
    ]);
    expect(database.prepare('SELECT id, connection_id, org_id FROM org_projects ORDER BY id').all()).toEqual([
      { id: 'mine', connection_id: 'ada-own', org_id: 'ada-own' },
      { id: 'shop', connection_id: 'acme-connection', org_id: 'acme' },
    ]);
    expect(database.prepare('SELECT worker_name, status FROM user_computer_runtimes').all()).toEqual([
      { worker_name: 'cloudchef-workspace-1', status: 'ready' },
    ]);
    expect(database.prepare('SELECT context_connection_id FROM cloudflare_auth_sessions').get()).toEqual({
      context_connection_id: 'ada-own',
    });
  });

  it('makes what the release before it still writes the old way a space as it lands, and never a second one', () => {
    const database = databaseBefore();
    withAda(database);
    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    // Bo, who has no name, signs in with Cloudflare on the old release, and makes a project there.
    database.exec(`
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('bo-own', 'bo', 'account-bo', 'active', 9, 9);
      INSERT INTO org_projects (id, connection_id, name, artifact_repo, created_from, created_by, created_at)
        VALUES ('bos', 'bo-own', 'Bo’s', 't-bos', 'chat', 'bo', 10);
    `);
    expect(database.prepare("SELECT name, personal_user_id FROM organizations WHERE id = 'bo-own'").get()).toEqual({
      name: 'My space',
      personal_user_id: 'bo',
    });
    expect(database.prepare("SELECT user_id, org_id FROM cloudflare_connections WHERE id = 'bo-own'").get()).toEqual({
      user_id: null,
      org_id: 'bo-own',
    });
    expect(database.prepare("SELECT org_id FROM org_projects WHERE id = 'bos'").get()).toEqual({ org_id: 'bo-own' });

    // Ada has her space already: the old release can't give her another.
    expect(() =>
      database.exec(`INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('ada-again', 'ada', 'account-ada', 'active', 9, 9)`),
    ).toThrow(/UNIQUE/);
    expect(database.prepare('SELECT COUNT(*) AS spaces FROM organizations').get()).toEqual({ spaces: 3 });
  });
});
