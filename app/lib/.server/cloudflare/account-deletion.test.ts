import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  eraseControlPlaneAccount,
  OrganizationAdminRequiredError,
  organizationsNeedingAnotherAdmin,
} from './account-deletion';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { controlPlaneDatabase, envWith, withStatementHook } from '~/test/control-plane-d1';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe('control-plane account erasure', () => {
  it('erases the account and revokes its Cloudflare grant', async () => {
    const { database, db } = controlPlaneDatabase();
    const revoke = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const vault = new D1CloudflareCredentialVault(db, ENCRYPTION_KEY, {
      clientId: 'client',
      clientSecret: 'secret',
      request: revoke,
    });
    const handle = await vault.storeOAuthCredential({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    seedAccount(database, handle);

    await expect(eraseControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1', vault })).resolves.toEqual({
      cloudflareAuthorizationRevoked: true,
      workspacesLeftIn: [],
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect(rowCount(database, 'user')).toBe(0);
    expect(rowCount(database, 'cloudflare_credentials')).toBe(0);
  });

  it('leaves another account untouched', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAccount(database, null, 'user-2');

    await eraseControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' });

    expect(rowCount(database, 'user')).toBe(1);
    expect(rowCount(database, 'cloudflare_connections')).toBe(1);
  });

  it('deletes the invites to their proven email, in any case, but not to an email they never proved', async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['user-1', 'user-2', 'admin']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      UPDATE "user" SET email_proven_at = 5 WHERE id = 'user-1';
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('acme', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('acme', 'admin', 'admin', 1);
      INSERT INTO organization_invites (id, org_id, email, role, token_hash, invited_by, expires_at, created_at)
        VALUES ('accepted', 'acme', 'user-1@example.test', 'member', 'hash-a', 'admin', 10, 1),
               ('pending', 'acme', 'USER-1@Example.test', 'member', 'hash-b', 'admin', 10, 1),
               ('unproven', 'acme', 'user-2@example.test', 'member', 'hash-c', 'admin', 10, 1);
    `);

    await eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'user-1' });
    await eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'user-2' });

    expect(database.prepare('SELECT id FROM organization_invites').all()).toEqual([{ id: 'unproven' }]);
  });

  it("never revokes an organization's grant while others still build in it, but takes a sole member's organization along", async () => {
    const { database, db } = controlPlaneDatabase();
    const revoke = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const vault = new D1CloudflareCredentialVault(db, ENCRYPTION_KEY, {
      clientId: 'client',
      clientSecret: 'secret',
      request: revoke,
    });
    const shared = await vault.storeOAuthCredential({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
    });
    const solo = await vault.storeOAuthCredential({
      accessToken: 'b',
      refreshToken: 's',
      expiresAt: Date.now() + 3_600_000,
    });
    seedAccount(database, null, 'user-1');
    seedAccount(database, null, 'user-2');
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('shared', 'Acme', 1, 1), ('solo', 'Side', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('shared', 'user-1', 'member', 1), ('shared', 'user-2', 'admin', 1), ('solo', 'user-1', 'admin', 1);
    `);
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, org_id, account_id, status, credential_handle, created_at, updated_at)
         VALUES (?, ?, 'org-account', 'active', ?, 1, 1)`,
      )
      .run('shared-connection', 'shared', shared);
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, org_id, account_id, status, credential_handle, created_at, updated_at)
         VALUES (?, ?, 'side-account', 'active', ?, 1, 1)`,
      )
      .run('solo-connection', 'solo', solo);

    await eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'user-1', vault });

    expect(revoke).toHaveBeenCalledOnce();
    expect(database.prepare('SELECT id, status FROM cloudflare_connections WHERE org_id IS NOT NULL').all()).toEqual([
      { id: 'shared-connection', status: 'active' },
    ]);
    expect(database.prepare('SELECT id FROM organizations').all()).toEqual([{ id: 'shared' }]);
  });

  it('never lets the last active admins both leave an organization others still belong to', async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['admin-a', 'admin-b', 'member']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('org', 'admin-a', 'admin', 1), ('org', 'admin-b', 'admin', 1), ('org', 'member', 'member', 1);
    `);

    await eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'admin-a' });
    await expect(eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'admin-b' })).rejects.toBeInstanceOf(
      OrganizationAdminRequiredError,
    );
    expect(database.prepare("SELECT user_id FROM organization_members WHERE role = 'admin'").all()).toEqual([
      { user_id: 'admin-b' },
    ]);
    expect(database.prepare("SELECT status FROM cloudflare_connections WHERE user_id = 'admin-b'").get()).toEqual({
      status: 'active',
    });
  });

  it('leaves no team at all when one of them would be left without an active admin', async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['admin', 'member']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('alpha', 'Alpha', 1, 1), ('beta', 'Beta', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('alpha', 'admin', 'member', 1), ('beta', 'admin', 'admin', 1), ('beta', 'member', 'member', 1);
    `);

    await expect(eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'admin' })).rejects.toBeInstanceOf(
      OrganizationAdminRequiredError,
    );

    expect(database.prepare("SELECT org_id FROM organization_members WHERE user_id = 'admin'").all()).toEqual([
      { org_id: 'alpha' },
      { org_id: 'beta' },
    ]);
  });

  it('asks for another admin only where the person is the sole active one, as leaving decides it', async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['admin', 'member']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('alpha', 'Alpha', 1, 1), ('beta', 'Beta', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at, paused_at) VALUES
        ('alpha', 'admin', 'admin', 1, NULL), ('alpha', 'member', 'member', 1, NULL),
        ('beta', 'admin', 'admin', 1, 5), ('beta', 'member', 'member', 1, NULL);
    `);

    expect(await organizationsNeedingAnotherAdmin(db, 'admin')).toEqual(['Alpha']);

    // A paused admin is no team's active admin: once Alpha has another, nothing holds them back.
    database.exec(`UPDATE organization_members SET role = 'admin' WHERE org_id = 'alpha' AND user_id = 'member'`);
    expect(await organizationsNeedingAnotherAdmin(db, 'admin')).toEqual([]);
    await eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'admin' });
    expect(database.prepare("SELECT org_id FROM organization_members WHERE user_id = 'admin'").all()).toEqual([]);
  });

  it("deletes the person's workspace in each team's account before they leave, and names the teams where it couldn't be", async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['user-1', 'admin']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at)
        VALUES ('acme', 'Acme', 1, 1), ('side', 'Side', 1, 1), ('idle', 'Idle', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('acme', 'user-1', 'member', 1), ('acme', 'admin', 'admin', 1),
        ('side', 'user-1', 'member', 1), ('side', 'admin', 'admin', 1),
        ('idle', 'user-1', 'member', 1), ('idle', 'admin', 'admin', 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at) VALUES
        ('acme-connection', 'acme', 'acme-account', 'active', 1, 1),
        ('side-connection', 'side', 'side-account', 'active', 1, 1),
        ('idle-connection', 'idle', 'idle-account', 'active', 1, 1);
    `);
    for (const connectionId of ['acme-connection', 'side-connection']) {
      database
        .prepare(
          `INSERT INTO user_computer_runtimes
             (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
              last_error, created_at, updated_at)
           VALUES ('user-1', ?, 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
        )
        .run(connectionId);
    }
    const deleted: string[] = [];

    const erasure = await eraseControlPlaneAccount({
      env: envWith({ DB: db }),
      userId: 'user-1',
      deleteWorkspace: async (_env, orgId, userId) => {
        // Still in the team, with the team's connection in place, when it's asked: leaving comes last.
        expect(
          database.prepare('SELECT COUNT(*) AS count FROM organization_members WHERE user_id = ?').get(userId),
        ).toEqual({ count: 3 });
        expect(database.prepare('SELECT status FROM cloudflare_connections WHERE org_id = ?').get(orgId)).toEqual({
          status: 'active',
        });
        if (orgId === 'side') {
          throw new Error('Cloudflare is unavailable');
        }
        deleted.push(`${orgId}:${userId}`);
      },
    });

    // Idle has no workspace of theirs to delete.
    expect(deleted).toEqual(['acme:user-1']);
    expect(erasure.workspacesLeftIn).toEqual(['Side']);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM user_computer_runtimes WHERE user_id = 'user-1'").get(),
    ).toEqual({
      count: 0,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM organization_members WHERE user_id = 'user-1'").get(),
    ).toEqual({ count: 0 });
  });

  it('deletes no workspace when the erasure is refused for a team left without an admin', async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['user-1', 'member']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('acme', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('acme', 'user-1', 'admin', 1), ('acme', 'member', 'member', 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
        VALUES ('acme-connection', 'acme', 'acme-account', 'active', 1, 1);
      INSERT INTO user_computer_runtimes
        (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
         last_error, created_at, updated_at)
        VALUES ('user-1', 'acme-connection', 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1);
    `);
    const deleted: string[] = [];

    await expect(
      eraseControlPlaneAccount({
        env: envWith({ DB: db }),
        userId: 'user-1',
        deleteWorkspace: async (_env, orgId) => {
          deleted.push(orgId);
        },
      }),
    ).rejects.toBeInstanceOf(OrganizationAdminRequiredError);

    expect(deleted).toEqual([]);
    expect(rowCount(database, 'organization_members')).toBe(2);
  });

  it('names a team whose connection is no longer active as left behind, but not a team going with them', async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['user-1', 'admin']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('acme', 'Acme', 1, 1), ('solo', 'Solo', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('acme', 'user-1', 'member', 1), ('acme', 'admin', 'admin', 1), ('solo', 'user-1', 'admin', 1);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at) VALUES
        ('acme-connection', 'acme', 'acme-account', 'revoked', 1, 1),
        ('solo-connection', 'solo', 'solo-account', 'revoked', 1, 1);
    `);
    for (const connectionId of ['acme-connection', 'solo-connection']) {
      insertRuntime(database, 'user-1', connectionId);
    }
    const deleted: string[] = [];

    const erasure = await eraseControlPlaneAccount({
      env: envWith({ DB: db }),
      userId: 'user-1',
      deleteWorkspace: async (_env, orgId) => {
        deleted.push(orgId);
      },
    });

    expect(deleted).toEqual([]);
    expect(erasure.workspacesLeftIn).toEqual(['Acme']);
  });

  it('refuses at the write if another admin stepped down meanwhile, and a retry then finishes', async () => {
    const { database, db } = controlPlaneDatabase();
    for (const userId of ['user-1', 'admin']) {
      seedAccount(database, null, userId);
    }
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('acme', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('acme', 'user-1', 'member', 1), ('acme', 'admin', 'admin', 1);
      CREATE TRIGGER refuse_leaving BEFORE DELETE ON organization_members
      BEGIN SELECT RAISE(ABORT, 'refused'); END;
    `);

    await expect(eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'user-1' })).rejects.toThrow('refused');
    expect(rowCount(database, 'organization_members')).toBe(2);
    expect(database.prepare("SELECT status FROM cloudflare_connections WHERE user_id = 'user-1'").get()).toEqual({
      status: 'active',
    });

    database.exec('DROP TRIGGER refuse_leaving');
    await eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'user-1' });
    expect(database.prepare('SELECT user_id FROM organization_members').all()).toEqual([{ user_id: 'admin' }]);
  });

  describe.each([
    [
      'before revoking the teams only they belong to',
      /SET status = 'revoked', updated_at = \? WHERE org_id = \?/,
      ['acme', 'solo'],
    ],
    ['before leaving their teams', /DELETE FROM organization_members/, ['acme']],
    ['before revoking their own connection', /WHERE user_id = \? AND status = 'active'/, ['acme']],
    ['before the last write', /DELETE FROM "user"/, ['acme']],
  ])('an erasure interrupted %s', (_stage, interruptedStatement, retriedWorkspaces) => {
    it('is finished by a retry, which reports truthfully', async () => {
      const { database, db } = controlPlaneDatabase();
      const revoke = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
      const vault = new D1CloudflareCredentialVault(db, ENCRYPTION_KEY, {
        clientId: 'client',
        clientSecret: 'secret',
        request: revoke,
      });
      const store = (refreshToken: string) =>
        vault.storeOAuthCredential({ accessToken: 'a', refreshToken, expiresAt: Date.now() + 3_600_000 });
      const [own, acme, solo] = [await store('own'), await store('acme'), await store('solo')];
      seedAccount(database, own, 'user-1');
      seedAccount(database, null, 'admin');
      database.exec(`
        INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('acme', 'Acme', 1, 1), ('solo', 'Solo', 1, 1);
        INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
          ('acme', 'user-1', 'member', 1), ('acme', 'admin', 'admin', 1), ('solo', 'user-1', 'admin', 1);
      `);
      for (const [orgId, handle] of [
        ['acme', acme],
        ['solo', solo],
      ]) {
        database
          .prepare(
            `INSERT INTO cloudflare_connections (id, org_id, account_id, status, credential_handle, created_at, updated_at)
             VALUES (?, ?, 'team-account', 'active', ?, 1, 1)`,
          )
          .run(`${orgId}-connection`, orgId, handle);
        insertRuntime(database, 'user-1', `${orgId}-connection`);
      }

      await expect(
        eraseControlPlaneAccount({
          env: envWith({ DB: interruptedAt(db, interruptedStatement) }),
          userId: 'user-1',
          vault,
          deleteWorkspace: async () => undefined,
        }),
      ).rejects.toThrow('interrupted');
      const deleted: string[] = [];
      const erasure = await eraseControlPlaneAccount({
        env: envWith({ DB: db }),
        userId: 'user-1',
        vault,
        deleteWorkspace: async (_env, orgId) => {
          deleted.push(orgId);
        },
      });

      expect(erasure).toEqual({ cloudflareAuthorizationRevoked: true, workspacesLeftIn: [] });
      expect(deleted).toEqual(retriedWorkspaces);
      expect(database.prepare('SELECT id FROM "user"').all()).toEqual([{ id: 'admin' }]);
      expect(database.prepare('SELECT id FROM organizations').all()).toEqual([{ id: 'acme' }]);
      expect(database.prepare('SELECT org_id, user_id FROM organization_members').all()).toEqual([
        { org_id: 'acme', user_id: 'admin' },
      ]);
      expect(database.prepare('SELECT handle FROM cloudflare_credentials').all()).toEqual([{ handle: acme }]);
      expect(rowCount(database, 'user_computer_runtimes')).toBe(1);
      const revokedTokens = revoke.mock.calls.map(([, init]) => String(init?.body)).join(' ');
      expect(revokedTokens).toContain('token=own');
      expect(revokedTokens).toContain('token=solo');
      expect(revokedTokens).not.toContain('token=acme');
    });
  });
});

/** The database as an erasure sees it when the Worker stops just as it is about to run `statement`. */
function interruptedAt(db: D1Database, statement: RegExp): D1Database {
  return withStatementHook(db, (query) => {
    if (statement.test(query)) {
      throw new Error('interrupted');
    }
  });
}

function insertRuntime(database: DatabaseSyncInstance, userId: string, connectionId: string): void {
  database
    .prepare(
      `INSERT INTO user_computer_runtimes
         (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
          last_error, created_at, updated_at)
       VALUES (?, ?, 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
    )
    .run(userId, connectionId);
}

function seedAccount(database: DatabaseSyncInstance, credentialHandle: string | null, userId = 'user-1'): void {
  database
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, cloudflare_subject)
       VALUES (?, 'Test', ?, 1, NULL, 1, 1, ?)`,
    )
    .run(userId, `${userId}@example.test`, userId);
  database
    .prepare(
      `INSERT INTO cloudflare_connections
        (id, user_id, account_id, account_name, status, credential_handle, connected_at, created_at, updated_at)
       VALUES (?, ?, 'account-1', 'Account', 'active', ?, 1, 1, 1)`,
    )
    .run(`connection-${userId}`, userId, credentialHandle);
  database
    .prepare(
      `INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 9999999999999, 1, 1)`,
    )
    .run(`session-${userId}`, userId, `hash-${userId}`);
  database
    .prepare(
      `INSERT INTO cloudflare_oauth_states
        (id, provider_session_id, return_to, status, expires_at, authenticated_user_id, created_at, updated_at)
       VALUES (?, ?, '/', 'completed', 9999999999999, ?, 1, 1)`,
    )
    .run(`state-${userId}`, `provider-${userId}`, userId);
  database
    .prepare(
      `INSERT INTO user_computer_runtimes
        (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
         last_error, created_at, updated_at)
       VALUES (?, ?, 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
    )
    .run(userId, `connection-${userId}`);
}

function rowCount(database: DatabaseSyncInstance, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS total FROM "${table}"`).get() as { total: number }).total);
}
