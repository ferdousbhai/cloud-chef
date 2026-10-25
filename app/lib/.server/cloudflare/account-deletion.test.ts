import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteOrganization,
  eraseControlPlaneAccount,
  OrganizationAdminRequiredError,
  organizationsNeedingAnotherAdmin,
} from './account-deletion';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { controlPlaneDatabase, envWith, withStatementHook } from '~/test/control-plane-d1';

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

afterEach(() => {
  vi.unstubAllGlobals();
});

/** An Env that can open the credential vault: the database, the encryption key, and the OAuth client. */
function vaultEnv(db: D1Database): Env {
  return envWith({
    DB: db,
    CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
    CLOUDFLARE_OAUTH_CLIENT_ID: 'client',
    CLOUDFLARE_OAUTH_CLIENT_SECRET: 'secret',
  });
}

/**
 * Cloudflare as an erasure reaches it, in place of the global fetch: each team account's API, where a
 * workspace's Worker is deleted (`onDelete` sees each, by account) and nothing else is found, and the
 * OAuth revocation endpoint, whose request bodies are `revoked`. Every call into an account listed in
 * `unavailable` fails.
 */
function stubCloudflare({
  unavailable = [],
  onDelete = () => undefined,
}: { unavailable?: string[]; onDelete?: (accountId: string) => void } = {}) {
  const deletedIn: string[] = [];
  const revoked: string[] = [];
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://dash.cloudflare.com/oauth2/revoke') {
      revoked.push(String(init?.body));
      return new Response(null, { status: 200 });
    }
    const accountId = /\/accounts\/([^/]+)\//.exec(url.pathname)?.[1] ?? '';
    if (unavailable.includes(accountId)) {
      return Response.json(
        { success: false, errors: [{ code: 7000, message: 'Cloudflare is unavailable' }] },
        { status: 400 },
      );
    }
    if (init?.method === 'DELETE' && url.pathname.includes('/workers/scripts/')) {
      onDelete(accountId);
      deletedIn.push(accountId);
    }
    return Response.json({ success: true, result: [], result_info: { total_pages: 1 } });
  });
  vi.stubGlobal('fetch', request);
  return { request, deletedIn, revoked };
}

/** Stores an unexpired OAuth grant under `refreshToken` and returns its handle. */
function storeGrant(env: Env, refreshToken: string, accessToken = 'access'): Promise<string> {
  return D1CloudflareCredentialVault.fromEnv(env).storeOAuthCredential({
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 3_600_000,
  });
}

describe('control-plane account erasure', () => {
  it('erases the account and revokes its Cloudflare grant', async () => {
    const { database, db } = controlPlaneDatabase();
    const env = vaultEnv(db);
    const cloudflare = stubCloudflare();
    seedAccount(database, await storeGrant(env, 'refresh'));

    await expect(eraseControlPlaneAccount({ env, userId: 'user-1' })).resolves.toEqual({
      cloudflareAuthorizationRevoked: true,
      cloudflareAuthorizationsKept: [],
      workspacesLeftIn: [],
    });
    expect(cloudflare.revoked).toHaveLength(1);
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
    const env = vaultEnv(db);
    const cloudflare = stubCloudflare();
    const shared = await storeGrant(env, 'r', 'a');
    const solo = await storeGrant(env, 's', 'b');
    seedAccount(database, null, 'user-1');
    seedAccount(database, null, 'user-2');
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('shared', 'Acme', 1, 1), ('solo', 'Side', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('shared', 'user-1', 'member', 1), ('shared', 'user-2', 'admin', 1), ('solo', 'user-1', 'admin', 1);
    `);
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
         VALUES (?, ?, 'org-account', 'active', 1, 1)`,
      )
      .run('shared-connection', 'shared');
    authorize(database, 'org-account', shared);
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
         VALUES (?, ?, 'side-account', 'active', 1, 1)`,
      )
      .run('solo-connection', 'solo');
    authorize(database, 'side-account', solo);

    await eraseControlPlaneAccount({ env, userId: 'user-1' });

    expect(cloudflare.revoked).toHaveLength(1);
    expect(database.prepare('SELECT id, status FROM cloudflare_connections WHERE org_id IS NOT NULL').all()).toEqual([
      { id: 'shared-connection', status: 'active' },
    ]);
    expect(database.prepare('SELECT id FROM organizations').all()).toEqual([{ id: 'shared' }]);
  });

  it("keeps an account's shared authorization while a team or a person's own space still builds there with it", async () => {
    const { database, db } = controlPlaneDatabase();
    const env = vaultEnv(db);
    const cloudflare = stubCloudflare();
    const shared = await storeGrant(env, 'shared');
    seedAccount(database, null, 'user-1');
    seedAccount(database, null, 'sara');
    // user-1's own space and their teams Sites (with Sara) and Side (only them) all build in account-1.
    database.exec(`
      DELETE FROM cloudflare_connections WHERE user_id = 'user-1';
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('sites', 'Sites', 1, 1), ('side', 'Side', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('sites', 'user-1', 'admin', 1), ('sites', 'sara', 'admin', 1), ('side', 'user-1', 'admin', 1);
      INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, status, created_at, updated_at) VALUES
        ('own', 'user-1', NULL, 'account-1', 'active', 1, 1),
        ('sites-connection', NULL, 'sites', 'account-1', 'active', 1, 1),
        ('side-connection', NULL, 'side', 'account-1', 'active', 1, 1);
    `);
    database
      .prepare(
        `INSERT INTO cloudflare_authorizations (account_id, credential_handle, created_at, updated_at)
         VALUES ('account-1', ?, 1, 1)`,
      )
      .run(shared);

    // Side goes with them, and their own space; Sites, which Sara still builds in, keeps the authorization.
    await expect(eraseControlPlaneAccount({ env, userId: 'user-1' })).resolves.toEqual({
      cloudflareAuthorizationRevoked: null,
      cloudflareAuthorizationsKept: [{ teams: ['Sites'], someoneElsesOwnSpace: false }],
      workspacesLeftIn: [],
    });
    expect(cloudflare.revoked).toEqual([]);
    expect(database.prepare('SELECT id FROM cloudflare_connections WHERE account_id = ?').all('account-1')).toEqual([
      { id: 'sites-connection' },
    ]);
    expect(database.prepare('SELECT credential_handle FROM cloudflare_authorizations').all()).toEqual([
      { credential_handle: shared },
    ]);

    // The last space in the account goes: the grant is revoked with Cloudflare and nothing of it is kept.
    const vault = D1CloudflareCredentialVault.fromEnv(env);
    await expect(deleteOrganization(db, 'sites', (handle) => vault.revokeOAuthCredential(handle))).resolves.toBe(true);
    expect(cloudflare.revoked).toHaveLength(1);
    expect(rowCount(database, 'cloudflare_authorizations')).toBe(0);
    expect(database.prepare('SELECT handle FROM cloudflare_credentials WHERE handle = ?').get(shared)).toBeUndefined();
  });

  it("keeps their account's authorization for someone else's own space there, saying so without saying whose", async () => {
    const { database, db } = controlPlaneDatabase();
    const env = vaultEnv(db);
    const cloudflare = stubCloudflare();
    const shared = await storeGrant(env, 'shared');
    seedAccount(database, shared, 'user-1');
    seedAccount(database, null, 'sara');
    // Sara's own space builds in user-1's account too, and no team does.
    database.exec(`UPDATE cloudflare_connections SET account_id = 'account-user-1' WHERE user_id = 'sara'`);

    await expect(eraseControlPlaneAccount({ env, userId: 'user-1' })).resolves.toEqual({
      cloudflareAuthorizationRevoked: null,
      cloudflareAuthorizationsKept: [{ teams: [], someoneElsesOwnSpace: true }],
      workspacesLeftIn: [],
    });
    expect(cloudflare.revoked).toEqual([]);
    expect(database.prepare('SELECT credential_handle FROM cloudflare_authorizations').all()).toEqual([
      { credential_handle: shared },
    ]);
  });

  it('reports the authorization kept for others in the account of a team that went with them', async () => {
    const { database, db } = controlPlaneDatabase();
    const env = vaultEnv(db);
    const cloudflare = stubCloudflare();
    const own = await storeGrant(env, 'own');
    const theirs = await storeGrant(env, 'theirs');
    seedAccount(database, own, 'user-1');
    seedAccount(database, theirs, 'sara');
    // user-1's team Side, only them, builds in Sara's account, where Sara's own space builds too.
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('side', 'Side', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('side', 'user-1', 'admin', 1);
      INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, status, created_at, updated_at) VALUES
        ('side-connection', NULL, 'side', 'account-sara', 'active', 1, 1);
    `);

    await expect(eraseControlPlaneAccount({ env, userId: 'user-1' })).resolves.toEqual({
      cloudflareAuthorizationRevoked: true,
      cloudflareAuthorizationsKept: [{ teams: [], someoneElsesOwnSpace: true }],
      workspacesLeftIn: [],
    });
    // Only their own account's grant was revoked; Sara's stays.
    expect(cloudflare.revoked).toHaveLength(1);
    expect(database.prepare('SELECT credential_handle FROM cloudflare_authorizations').all()).toEqual([
      { credential_handle: theirs },
    ]);
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
    `);
    const env = vaultEnv(db);
    for (const orgId of ['acme', 'side', 'idle']) {
      database
        .prepare(
          `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', 1, 1)`,
        )
        .run(`${orgId}-connection`, orgId, `${orgId}-account`);
      authorize(database, `${orgId}-account`, await storeGrant(env, orgId));
    }
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
    const cloudflare = stubCloudflare({
      unavailable: ['side-account'],
      onDelete: (accountId) => {
        // Still in the team, with the team's connection in place, when it's asked: leaving comes last.
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM organization_members WHERE user_id = 'user-1'").get(),
        ).toEqual({ count: 3 });
        expect(
          database.prepare('SELECT status FROM cloudflare_connections WHERE account_id = ?').get(accountId),
        ).toEqual({ status: 'active' });
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const erasure = await eraseControlPlaneAccount({ env, userId: 'user-1' });
    warn.mockRestore();

    // Idle has no workspace of theirs to delete.
    expect(cloudflare.deletedIn).toEqual(['acme-account']);
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
    const cloudflare = stubCloudflare();

    await expect(eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'user-1' })).rejects.toBeInstanceOf(
      OrganizationAdminRequiredError,
    );

    expect(cloudflare.request).not.toHaveBeenCalled();
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
    const cloudflare = stubCloudflare();

    const erasure = await eraseControlPlaneAccount({ env: envWith({ DB: db }), userId: 'user-1' });

    expect(cloudflare.deletedIn).toEqual([]);
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
      const env = vaultEnv(db);
      const cloudflare = stubCloudflare();
      const store = (refreshToken: string) => storeGrant(env, refreshToken, 'a');
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
            `INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
             VALUES (?, ?, ?, 'active', 1, 1)`,
          )
          .run(`${orgId}-connection`, orgId, `${orgId}-account`);
        authorize(database, `${orgId}-account`, handle);
        insertRuntime(database, 'user-1', `${orgId}-connection`);
      }

      await expect(
        eraseControlPlaneAccount({ env: { ...env, DB: interruptedAt(db, interruptedStatement) }, userId: 'user-1' }),
      ).rejects.toThrow('interrupted');
      cloudflare.deletedIn.length = 0;
      const erasure = await eraseControlPlaneAccount({ env, userId: 'user-1' });

      expect(erasure).toEqual({
        cloudflareAuthorizationRevoked: true,
        cloudflareAuthorizationsKept: [],
        workspacesLeftIn: [],
      });
      expect(cloudflare.deletedIn).toEqual(retriedWorkspaces.map((orgId) => `${orgId}-account`));
      expect(database.prepare('SELECT id FROM "user"').all()).toEqual([{ id: 'admin' }]);
      expect(database.prepare('SELECT id FROM organizations').all()).toEqual([{ id: 'acme' }]);
      expect(database.prepare('SELECT org_id, user_id FROM organization_members').all()).toEqual([
        { org_id: 'acme', user_id: 'admin' },
      ]);
      expect(database.prepare('SELECT handle FROM cloudflare_credentials').all()).toEqual([{ handle: acme }]);
      expect(rowCount(database, 'user_computer_runtimes')).toBe(1);
      const revokedTokens = cloudflare.revoked.join(' ');
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

/** Gives `accountId` its one authorization, the stored credential `credentialHandle`. */
function authorize(database: DatabaseSyncInstance, accountId: string, credentialHandle: string): void {
  database
    .prepare(
      `INSERT INTO cloudflare_authorizations (account_id, credential_handle, created_at, updated_at)
       VALUES (?, ?, 1, 1)`,
    )
    .run(accountId, credentialHandle);
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
        (id, user_id, account_id, account_name, status, connected_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Account', 'active', 1, 1, 1)`,
    )
    .run(`connection-${userId}`, userId, `account-${userId}`);
  if (credentialHandle) {
    authorize(database, `account-${userId}`, credentialHandle);
  }
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
