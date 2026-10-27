import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

const MIGRATION = '0044_usernames_and_project_names.sql';

/** The control-plane database before usernames: every migration up to this one. */
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
  it('names the two people here, and gives every project an address name unique for its author', () => {
    const database = databaseBefore();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
        ('owner', 'Ferdous', 'ferdousbd@gmail.com', 1, 1, 1),
        ('sara', 'Sara', 'saraadolfsen@gmail.com', 1, 1, 1),
        ('new', 'New', 'new@example.com', 1, 1, 1);
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('own', 'owner', 'account', 'active', 1, 1);
      INSERT INTO org_projects (id, connection_id, name, artifact_repo, created_from, created_by, created_at) VALUES
        ('glossary', 'own', 'alberta-plan-glossary', 't-glossary', 'zip', 'owner', 1),
        ('shop', 'own', 'Sara''s Shop (v2)', 't-shop', 'zip', 'sara', 2),
        ('again', 'own', 'Alberta Plan Glossary', 't-again', 'zip', 'owner', 3),
        ('orphan', 'own', 'Orphan', 't-orphan', 'zip', NULL, 4);
    `);

    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    expect(database.prepare('SELECT id, username FROM "user" ORDER BY id').all()).toEqual([
      { id: 'new', username: null },
      { id: 'owner', username: 'ferdous' },
      { id: 'sara', username: 'sara' },
    ]);
    expect(database.prepare('SELECT id, slug FROM org_projects ORDER BY created_at').all()).toEqual([
      { id: 'glossary', slug: 'alberta-plan-glossary' },
      { id: 'shop', slug: 'sara-s-shop-v2' },
      { id: 'again', slug: 'alberta-plan-glossary-agai' },
      { id: 'orphan', slug: 'orphan' },
    ]);
    expect(() =>
      database.exec(`INSERT INTO org_projects (id, connection_id, name, artifact_repo, created_from, created_by,
        created_at, slug) VALUES ('dup', 'own', 'Dup', 't-dup', 'zip', 'owner', 5, 'alberta-plan-glossary')`),
    ).toThrow(/UNIQUE/);
    expect(() => database.exec(`UPDATE "user" SET username = 'sara' WHERE id = 'new'`)).toThrow(/UNIQUE/);
  });
});
