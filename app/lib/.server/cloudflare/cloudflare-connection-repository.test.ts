import { describe, expect, it } from 'vitest';
import {
  activateCloudflareConnection,
  CloudflareConnectionChangedError,
  findCloudflareConnectionForUser,
} from './cloudflare-connection-repository';

describe('activateCloudflareConnection', () => {
  it('rejects a stale OAuth completion instead of overwriting the winning credential handle', async () => {
    const database = connectionDatabase({ generation: 5, credentialHandle: 'credential-winner' });

    await expect(
      activateCloudflareConnection({
        db: database.db,
        owner: { kind: 'user', userId: 'user-1' },
        accountId: 'account-1',
        accountName: 'Account',
        credentialHandle: 'credential-loser',
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: 4,
        now: 100,
      }),
    ).rejects.toBeInstanceOf(CloudflareConnectionChangedError);

    expect(database.credentialHandle).toBe('credential-winner');
    expect(database.generation).toBe(5);
  });

  it('advances the generation when the observed connection is still current', async () => {
    const database = connectionDatabase({ generation: 5, credentialHandle: 'credential-old' });

    await expect(
      activateCloudflareConnection({
        db: database.db,
        owner: { kind: 'user', userId: 'user-1' },
        accountId: 'account-2',
        accountName: 'New account',
        credentialHandle: 'credential-new',
        grantedOAuthScopes: ['workers-scripts.write', 'ai.read'],
        expectedGeneration: 5,
        now: 200,
      }),
    ).resolves.toBeUndefined();

    expect(database.credentialHandle).toBe('credential-new');
    expect(database.generation).toBe(6);
  });

  it('commits the CAS update without a fallible follow-up read', async () => {
    const database = connectionDatabase({ generation: 2, credentialHandle: 'credential-old' }, { failSelect: true });

    await expect(
      activateCloudflareConnection({
        db: database.db,
        owner: { kind: 'user', userId: 'user-1' },
        accountId: 'account-2',
        accountName: 'New account',
        credentialHandle: 'credential-committed',
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: 2,
        now: 300,
      }),
    ).resolves.toBeUndefined();

    expect(database.selects).toBe(0);
    expect(database.credentialHandle).toBe('credential-committed');
  });

  it('adopts the exact committed update when its D1 acknowledgement is lost', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    const database = connectionDatabase(
      { generation: 2, credentialHandle: 'credential-old' },
      { updateErrorAfterCommit: acknowledgementError },
    );

    await expect(
      activateCloudflareConnection({
        db: database.db,
        owner: { kind: 'user', userId: 'user-1' },
        accountId: 'account-2',
        accountName: 'New account',
        credentialHandle: 'credential-committed',
        grantedOAuthScopes: ['workers-scripts.write', 'ai.read'],
        expectedGeneration: 2,
        now: 300,
      }),
    ).resolves.toBeUndefined();

    expect(database.selects).toBe(1);
  });

  it('preserves the D1 error when reconciliation observes a competing connection', async () => {
    const acknowledgementError = new Error('D1 unavailable');
    const database = connectionDatabase(
      { generation: 6, credentialHandle: 'credential-winner' },
      { updateErrorWithoutCommit: acknowledgementError },
    );

    await expect(
      activateCloudflareConnection({
        db: database.db,
        owner: { kind: 'user', userId: 'user-1' },
        accountId: 'account-2',
        accountName: 'New account',
        credentialHandle: 'credential-loser',
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: 5,
        now: 300,
      }),
    ).rejects.toBe(acknowledgementError);

    expect(database.credentialHandle).toBe('credential-winner');
    expect(database.generation).toBe(6);
  });

  it('inserts a new connection atomically', async () => {
    const db = newConnectionDatabase();

    await expect(
      activateCloudflareConnection({
        db,
        owner: { kind: 'user', userId: 'user-new' },
        accountId: 'account-new',
        accountName: null,
        credentialHandle: 'credential-new',
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: null,
        now: 400,
      }),
    ).resolves.toBeUndefined();
  });

  it('adopts the exact committed insert when its D1 acknowledgement is lost', async () => {
    const acknowledgementError = new Error('D1 acknowledgement lost');
    const db = newConnectionDatabase({ insertErrorAfterCommit: acknowledgementError });

    await expect(
      activateCloudflareConnection({
        db,
        owner: { kind: 'user', userId: 'user-new' },
        accountId: 'account-new',
        accountName: null,
        credentialHandle: 'credential-new',
        grantedOAuthScopes: ['workers-scripts.write'],
        expectedGeneration: null,
        now: 400,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects corrupt persisted scopes instead of silently removing them', async () => {
    const row = {
      id: 'connection-1',
      user_id: 'user-1',
      account_id: 'account-1',
      account_name: 'Account',
      status: 'active',
      credential_handle: 'credential-1',
      granted_oauth_scopes_json: '{invalid',
      connected_at: 1,
      updated_at: 1,
      connection_generation: 1,
    };
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    } as unknown as D1Database;

    await expect(findCloudflareConnectionForUser(db, 'user-1')).rejects.toThrow(
      'Stored Cloudflare connection scopes are invalid',
    );
  });
});

type FakeConnectionState = {
  generation: number;
  credentialHandle: string;
  accountId: string;
  accountName: string | null;
  grantedScopes: string[];
  connectedAt: number;
  updatedAt: number;
};

function connectionDatabase(
  initial: { generation: number; credentialHandle: string },
  options: {
    failSelect?: boolean;
    updateErrorAfterCommit?: Error;
    updateErrorWithoutCommit?: Error;
  } = {},
) {
  const state: FakeConnectionState = {
    generation: initial.generation,
    credentialHandle: initial.credentialHandle,
    accountId: 'account-1',
    accountName: 'Account',
    grantedScopes: ['workers-scripts.write'],
    connectedAt: 1,
    updatedAt: 1,
  };
  let selects = 0;
  const row = () => ({
    id: 'connection-1',
    user_id: 'user-1',
    account_id: state.accountId,
    account_name: state.accountName,
    status: 'active' as const,
    credential_handle: state.credentialHandle,
    granted_oauth_scopes_json: JSON.stringify(state.grantedScopes),
    connected_at: state.connectedAt,
    updated_at: state.updatedAt,
    connection_generation: state.generation,
  });
  const applyUpdate = (values: unknown[]) => {
    // SAFETY: mirrors the exact bind order of the repository's UPDATE statement, which the
    // assertions on the fake's observable state prove end to end.
    const [accountId, accountName, credentialHandle, grantedScopesJson, connectedAt, updatedAt, , expectedGeneration] =
      values as [string, string | null, string, string, number, number, string, number];
    if (expectedGeneration !== state.generation) {
      return false;
    }
    state.accountId = accountId;
    state.accountName = accountName;
    state.credentialHandle = credentialHandle;
    state.grantedScopes = JSON.parse(grantedScopesJson);
    state.connectedAt = connectedAt;
    state.updatedAt = updatedAt;
    state.generation++;
    return true;
  };
  const db = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              if (!query.includes('UPDATE cloudflare_connections')) {
                return changed(0);
              }
              return changed(applyUpdate(values) ? 1 : 0);
            },
            first: async () => {
              if (query.includes('UPDATE cloudflare_connections')) {
                if (options.updateErrorWithoutCommit) {
                  throw options.updateErrorWithoutCommit;
                }
                const committed = applyUpdate(values);
                if (committed && options.updateErrorAfterCommit) {
                  throw options.updateErrorAfterCommit;
                }
                return committed ? row() : null;
              }
              if (query.includes('SELECT')) {
                selects++;
                if (options.failSelect) {
                  throw new Error('follow-up read failed');
                }
                return row();
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    db,
    get generation() {
      return state.generation;
    },
    get credentialHandle() {
      return state.credentialHandle;
    },
    get selects() {
      return selects;
    },
  };
}

function newConnectionDatabase(options: { insertErrorAfterCommit?: Error } = {}): D1Database {
  let committed: ReturnType<typeof insertedConnectionRow> | null = null;
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (query.includes('INSERT INTO cloudflare_connections')) {
                expect(query).toContain('RETURNING');
                committed = insertedConnectionRow(values);
                if (options.insertErrorAfterCommit) {
                  throw options.insertErrorAfterCommit;
                }
                return committed;
              }
              expect(query).toContain('FROM cloudflare_connections');
              return committed;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function insertedConnectionRow(values: unknown[]) {
  // SAFETY: mirrors the exact bind order of the repository's INSERT statement, which the
  // returning-row assertions in the tests above prove end to end.
  const [id, userId, accountId, accountName, credentialHandle, grantedScopesJson, connectedAt, , updatedAt] =
    values as [string, string, string, string | null, string, string, number, number, number];
  return {
    id,
    user_id: userId,
    account_id: accountId,
    account_name: accountName,
    status: 'active' as const,
    credential_handle: credentialHandle,
    granted_oauth_scopes_json: grantedScopesJson,
    connected_at: connectedAt,
    updated_at: updatedAt,
    connection_generation: 1,
  };
}

function changed(changes: number) {
  return { success: true, meta: { changes } } as D1Result;
}
