import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { eraseControlPlaneAccount, OrganizationAdminRequiredError } from './account-deletion';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';

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
});

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
        (id, user_id, account_id, account_name, status, credential_handle, granted_capabilities_json,
         ai_billing_enabled, connected_at, created_at, updated_at)
       VALUES (?, ?, 'account-1', 'Account', 'active', ?, '["workers"]', 1, 1, 1, 1)`,
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
