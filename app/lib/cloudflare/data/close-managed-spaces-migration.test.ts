import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sqlite: typeof NodeSqlite = require('node:sqlite');

const MIGRATION = '0075_close_managed_spaces.sql';
const HOST = 'f2ab805b-1a7b-4459-b6fa-48556c4b5888';

/** The control-plane database while CloudChef ran spaces in its operator's account. */
function databaseBefore() {
  const database = new sqlite.DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  for (const migration of readdirSync('migrations').sort()) {
    if (migration >= MIGRATION) {
      break;
    }
    database.exec(readFileSync(join('migrations', migration), 'utf8'));
  }
  // The operator's own team; Sam's space by subscription, with Gia invited; Pat, in the host team by subscription
  // from before spaces were a subscriber's own; Ada, whom the operator invited; and a space on its own account.
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, managed_space_waitlist_at) VALUES
      ('owner', 'Owner', 'owner@example.com', 1, 1, 1, NULL), ('sam', 'Sam', 'sam@example.com', 1, 1, 1, NULL),
      ('gia', 'Gia', 'gia@example.com', 1, 1, 1, NULL), ('pat', 'Pat', 'pat@example.com', 1, 1, 1, NULL),
      ('ada', 'Ada', 'ada@example.com', 1, 1, 1, 5);
    INSERT INTO organizations (id, name, created_at, updated_at, managed_host_org_id) VALUES
      ('${HOST}', 'Host', 1, 1, NULL), ('sam-space', 'Sam’s space', 1, 1, '${HOST}'), ('acme', 'Acme', 1, 1, NULL);
    INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
      ('${HOST}', 'owner', 'admin', 1), ('${HOST}', 'pat', 'member', 1), ('${HOST}', 'ada', 'member', 1),
      ('sam-space', 'sam', 'admin', 1), ('sam-space', 'gia', 'member', 1), ('acme', 'ada', 'admin', 1);
    INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at,
      connection_generation) VALUES
      ('host-connection', '${HOST}', 'operator', 'active', 1, 1, 1),
      ('sam-connection', 'sam-space', 'operator', 'active', 1, 1, 1),
      ('acme-connection', 'acme', 'acme-account', 'active', 1, 1, 1);
    INSERT INTO organization_invites (id, org_id, email, role, token_hash, expires_at, created_at) VALUES
      ('invite-1', 'sam-space', 'new@example.com', 'member', 'hash-1', 9999999999999, 1),
      ('invite-2', 'acme', 'new@example.com', 'member', 'hash-2', 9999999999999, 1);
    INSERT INTO managed_subscriptions (user_id, stripe_customer_id, status, created_at, updated_at, space_org_id)
      VALUES ('sam', 'cus_1', 'active', 1, 1, 'sam-space'), ('pat', 'cus_2', 'active', 1, 1, NULL);
    INSERT INTO space_credit_purchases (checkout_session_id, org_id, user_id, amount_usd, created_at)
      VALUES ('cs_1', 'sam-space', 'sam', 20, 1);
  `);
  return database;
}

describe(MIGRATION, () => {
  it('closes the spaces CloudChef ran and leaves every other space as it was', () => {
    const database = databaseBefore();
    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    expect(database.prepare('SELECT id, status FROM cloudflare_connections ORDER BY id').all()).toEqual([
      { id: 'acme-connection', status: 'active' },
      { id: 'host-connection', status: 'active' },
      { id: 'sam-connection', status: 'revoked' },
    ]);
    const paused = database
      .prepare('SELECT org_id, user_id FROM organization_members WHERE paused_at IS NOT NULL ORDER BY user_id')
      .all();
    // Everyone in the space, and whoever was in the host team by subscription; nobody the operator invited.
    expect(paused).toEqual([
      { org_id: 'sam-space', user_id: 'gia' },
      { org_id: HOST, user_id: 'pat' },
      { org_id: 'sam-space', user_id: 'sam' },
    ]);
    expect(database.prepare('SELECT id FROM organization_invites').all()).toEqual([{ id: 'invite-2' }]);
    expect(database.prepare('SELECT COUNT(*) AS kept FROM managed_subscriptions').get()).toEqual({ kept: 0 });
    expect(database.prepare('SELECT COUNT(*) AS kept FROM space_credit_purchases').get()).toEqual({ kept: 0 });
    expect(
      database.prepare('SELECT COUNT(*) AS waiting FROM "user" WHERE managed_space_waitlist_at IS NOT NULL').get(),
    ).toEqual({ waiting: 0 });
  });

  it('lets no such space be made again', () => {
    const database = databaseBefore();
    database.exec(readFileSync(join('migrations', MIGRATION), 'utf8'));

    expect(() =>
      database.exec(
        `INSERT INTO organizations (id, name, created_at, updated_at, managed_host_org_id)
         VALUES ('again', 'Again', 1, 1, '${HOST}')`,
      ),
    ).toThrow('CloudChef runs no spaces');
    expect(() => database.exec(`UPDATE organizations SET managed_host_org_id = '${HOST}' WHERE id = 'acme'`)).toThrow(
      'CloudChef runs no spaces',
    );
    database.exec(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('fine', 'Fine', 1, 1)`);
  });
});
