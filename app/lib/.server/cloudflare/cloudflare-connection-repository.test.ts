import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import {
  activateCloudflareConnection,
  CloudflareConnectionChangedError,
  findCloudflareConnectionForOrganization,
  findCloudflareConnectionForUser,
  runsEveryOtherSpaceInAccount,
} from './cloudflare-connection-repository';

/**
 * Owner's own space and their team "Sites" both build in `account-1` with one authorization (`credential-old`);
 * Sara is a member of Sites only. Generations 5 and 4, as each space was reconnected separately before.
 */
function sharedAccount() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
      ('owner', 'Owner', 'owner@example.com', 1, 1, 1), ('sara', 'Sara', 'sara@example.com', 1, 1, 1);
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('sites', 'Sites', 1, 1);
    INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
      ('sites', 'owner', 'admin', 1), ('sites', 'sara', 'member', 1);
    INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES
      ('credential-old', 'x', 'y', 1), ('credential-new', 'x', 'y', 2), ('credential-loser', 'x', 'y', 2);
    INSERT INTO cloudflare_connections (id, user_id, org_id, account_id, account_name, status, connected_at,
      created_at, updated_at, connection_generation) VALUES
      ('own', 'owner', NULL, 'account-1', 'Account', 'active', 1, 1, 1, 5),
      ('team', NULL, 'sites', 'account-1', 'Account', 'active', 1, 1, 1, 4);
    INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json, created_at, updated_at)
      VALUES ('account-1', 'credential-old', '["workers-scripts.write"]', 1, 1);
  `);
  return { database, db };
}

/** `db` with its batches run by `batch` instead: one whose answer is lost, or that never reaches D1. */
function withBatch(db: D1Database, batch: (statements: D1PreparedStatement[]) => Promise<never>): D1Database {
  return {
    prepare: (query) => db.prepare(query),
    batch,
    exec: (query) => db.exec(query),
    withSession: (constraintOrBookmark) => db.withSession(constraintOrBookmark),
    dump: () => db.dump(),
  };
}

function authorization(database: DatabaseSync) {
  return database
    .prepare('SELECT account_id, credential_handle, granted_oauth_scopes_json FROM cloudflare_authorizations')
    .all();
}

const reconnectOwn = {
  owner: { kind: 'user', userId: 'owner' },
  accountId: 'account-1',
  accountName: 'Account',
  credentialHandle: 'credential-new',
  grantedOAuthScopes: ['workers-scripts.write', 'ai.read'],
  expectedGeneration: 5,
  replacedCredentialHandle: 'credential-old',
} as const;

describe('activateCloudflareConnection', () => {
  it("reconnecting a person's own space updates the authorization their team in the same account uses", async () => {
    const { database, db } = sharedAccount();

    await activateCloudflareConnection({
      db,
      ...reconnectOwn,
      grantedOAuthScopes: [...reconnectOwn.grantedOAuthScopes],
    });

    const own = await findCloudflareConnectionForUser(db, 'owner');
    const team = await findCloudflareConnectionForOrganization(db, 'sites');
    expect(own).toMatchObject({ id: 'own', credentialHandle: 'credential-new', generation: 6 });
    expect(own?.grantedOAuthScopes).toEqual(['workers-scripts.write', 'ai.read']);
    // The team's space reads the same authorization, and keeps its generation: its workspaces carry on.
    expect(team).toMatchObject({ id: 'team', credentialHandle: 'credential-new', generation: 4 });
    expect(team?.grantedOAuthScopes).toEqual(['workers-scripts.write', 'ai.read']);
    expect(authorization(database)).toHaveLength(1);
  });

  it('rejects a stale OAuth completion instead of overwriting the winning authorization', async () => {
    const { database, db } = sharedAccount();

    await expect(
      activateCloudflareConnection({
        db,
        ...reconnectOwn,
        credentialHandle: 'credential-loser',
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: 4,
      }),
    ).rejects.toBeInstanceOf(CloudflareConnectionChangedError);

    expect(authorization(database)).toEqual([
      {
        account_id: 'account-1',
        credential_handle: 'credential-old',
        granted_oauth_scopes_json: '["workers-scripts.write"]',
      },
    ]);
    expect((await findCloudflareConnectionForUser(db, 'owner'))?.generation).toBe(5);
  });

  it('moves a space to another account without touching the authorization the others there use', async () => {
    const { database, db } = sharedAccount();

    await activateCloudflareConnection({
      db,
      ...reconnectOwn,
      accountId: 'account-2',
      accountName: 'Other',
      grantedOAuthScopes: ['workers-scripts.write'],
      replacedCredentialHandle: null,
    });

    expect(await findCloudflareConnectionForUser(db, 'owner')).toMatchObject({
      accountId: 'account-2',
      accountName: 'Other',
      credentialHandle: 'credential-new',
      generation: 6,
    });
    expect(await findCloudflareConnectionForOrganization(db, 'sites')).toMatchObject({
      accountId: 'account-1',
      accountName: 'Account',
      credentialHandle: 'credential-old',
    });
    expect(authorization(database)).toHaveLength(2);
  });

  it('writes nothing when the account was connected by someone else after its authorization was read', async () => {
    const { database, db } = sharedAccount();
    // Another connection into the account landed between reading its authorization and this one finishing.
    database.exec(`UPDATE cloudflare_authorizations SET credential_handle = 'credential-loser'`);

    await expect(
      activateCloudflareConnection({ db, ...reconnectOwn, grantedOAuthScopes: ['workers-scripts.write'] }),
    ).rejects.toBeInstanceOf(CloudflareConnectionChangedError);

    expect(authorization(database)[0]).toMatchObject({ credential_handle: 'credential-loser' });
    expect(await findCloudflareConnectionForUser(db, 'owner')).toMatchObject({
      generation: 5,
      credentialHandle: 'credential-loser',
    });
  });

  it("writes nothing for a team's first connection when the account gained an authorization meanwhile", async () => {
    const { database, db } = sharedAccount();
    database.exec(`DELETE FROM cloudflare_connections WHERE id = 'team'`);

    await expect(
      activateCloudflareConnection({
        db,
        ...reconnectOwn,
        owner: { kind: 'organization', orgId: 'sites' },
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: null,
        replacedCredentialHandle: null,
      }),
    ).rejects.toBeInstanceOf(CloudflareConnectionChangedError);

    expect(await findCloudflareConnectionForOrganization(db, 'sites')).toBeNull();
    expect(authorization(database)[0]).toMatchObject({ credential_handle: 'credential-old' });
  });

  it('adopts the exact committed write when its D1 acknowledgement is lost', async () => {
    const { db } = sharedAccount();
    const acknowledgementLost = new Error('D1 acknowledgement lost');
    const lossy = withBatch(db, async (statements) => {
      await db.batch(statements);
      throw acknowledgementLost;
    });

    await expect(
      activateCloudflareConnection({ db: lossy, ...reconnectOwn, grantedOAuthScopes: ['workers-scripts.write'] }),
    ).resolves.toBeUndefined();
    expect((await findCloudflareConnectionForUser(db, 'owner'))?.credentialHandle).toBe('credential-new');
  });

  it('preserves the D1 error when nothing was written', async () => {
    const { database, db } = sharedAccount();
    const unavailable = new Error('D1 unavailable');
    const failing = withBatch(db, async () => Promise.reject(unavailable));

    await expect(
      activateCloudflareConnection({ db: failing, ...reconnectOwn, grantedOAuthScopes: ['workers-scripts.write'] }),
    ).rejects.toBe(unavailable);
    expect(authorization(database)[0]).toMatchObject({ credential_handle: 'credential-old' });
  });

  it('connects a new space to an account no one has connected yet', async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('new', 'New', 'new@example.com', 1, 1, 1);
      INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES ('credential-new', 'x', 'y', 1);
    `);

    await activateCloudflareConnection({
      db,
      owner: { kind: 'user', userId: 'new' },
      accountId: 'account-new',
      accountName: null,
      credentialHandle: 'credential-new',
      grantedOAuthScopes: ['workers-scripts.write'],
      expectedGeneration: null,
      replacedCredentialHandle: null,
    });

    expect(await findCloudflareConnectionForUser(db, 'new')).toMatchObject({
      accountId: 'account-new',
      credentialHandle: 'credential-new',
      generation: 1,
      status: 'active',
    });
  });

  it('rejects a second first connection for the same space', async () => {
    const { db } = sharedAccount();

    await expect(
      activateCloudflareConnection({
        db,
        ...reconnectOwn,
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: null,
      }),
    ).rejects.toBeInstanceOf(CloudflareConnectionChangedError);
  });

  it('rejects corrupt persisted scopes instead of silently removing them', async () => {
    const { database, db } = sharedAccount();
    database.exec(
      `UPDATE cloudflare_authorizations SET granted_oauth_scopes_json = '{invalid' WHERE account_id = 'account-1'`,
    );

    await expect(findCloudflareConnectionForUser(db, 'owner')).rejects.toThrow(
      'Stored Cloudflare connection scopes are invalid',
    );
  });

  it('reads a space whose account has no authorization as having none, so it asks to reconnect', async () => {
    const { database, db } = sharedAccount();
    database.exec(`DELETE FROM cloudflare_authorizations`);

    expect(await findCloudflareConnectionForOrganization(db, 'sites')).toMatchObject({
      credentialHandle: null,
      grantedOAuthScopes: [],
    });
  });
});

describe('runsEveryOtherSpaceInAccount', () => {
  it('lets the person who runs every space in the account reconnect it from any of them', async () => {
    const { db } = sharedAccount();
    for (const owner of [
      { kind: 'user', userId: 'owner' },
      { kind: 'organization', orgId: 'sites' },
    ] as const) {
      expect(await runsEveryOtherSpaceInAccount(db, { userId: 'owner', owner, accountId: 'account-1' })).toBe(true);
    }
  });

  it("keeps a member, or anyone else, from replacing an authorization someone else's space uses", async () => {
    const { database, db } = sharedAccount();
    // Sara connecting her own space to the owner's account would replace the owner's authorization.
    expect(
      await runsEveryOtherSpaceInAccount(db, {
        userId: 'sara',
        owner: { kind: 'user', userId: 'sara' },
        accountId: 'account-1',
      }),
    ).toBe(false);
    // An admin of another team, too.
    database.exec(`
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('other', 'Other', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('other', 'sara', 'admin', 1);
    `);
    expect(
      await runsEveryOtherSpaceInAccount(db, {
        userId: 'sara',
        owner: { kind: 'organization', orgId: 'other' },
        accountId: 'account-1',
      }),
    ).toBe(false);
    // A paused admin no longer runs the team.
    database.exec(`UPDATE organization_members SET paused_at = 1 WHERE org_id = 'sites' AND user_id = 'owner'`);
    expect(
      await runsEveryOtherSpaceInAccount(db, {
        userId: 'owner',
        owner: { kind: 'user', userId: 'owner' },
        accountId: 'account-1',
      }),
    ).toBe(false);
  });

  it('keeps someone signing in for the first time, who runs no space yet, out of an account others build in', async () => {
    const { db } = sharedAccount();
    expect(await runsEveryOtherSpaceInAccount(db, { userId: null, owner: null, accountId: 'account-1' })).toBe(false);
    expect(await runsEveryOtherSpaceInAccount(db, { userId: null, owner: null, accountId: 'account-2' })).toBe(true);
  });

  it('keeps someone signing in for the first time out of an account only a team builds in', async () => {
    const { database, db } = sharedAccount();
    // No one's own space is in the account: only the team's.
    database.exec(`UPDATE cloudflare_connections SET status = 'revoked' WHERE id = 'own'`);
    expect(await runsEveryOtherSpaceInAccount(db, { userId: null, owner: null, accountId: 'account-1' })).toBe(false);
  });

  it('lets anyone connect an account no other space builds in', async () => {
    const { db } = sharedAccount();
    expect(
      await runsEveryOtherSpaceInAccount(db, {
        userId: 'sara',
        owner: { kind: 'user', userId: 'sara' },
        accountId: 'account-2',
      }),
    ).toBe(true);
  });
});
