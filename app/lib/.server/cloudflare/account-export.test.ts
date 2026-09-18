import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncInstance, SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_EXPORT_ROW_LIMIT, ACCOUNT_EXPORT_SCHEMA_VERSION, exportControlPlaneAccount } from './account-export';

// Values that exist in the control plane and must never leave it. Each is checked
// against the serialized document rather than against a field, so a new field
// carrying one of them fails the test.
const CIPHERTEXT = 'ciphertext-must-never-be-exported';
const INITIALISATION_VECTOR = 'iv-must-never-be-exported';
const SESSION_TOKEN_HASH = 'token-hash-must-never-be-exported';
const PROVIDER_SESSION_ID = 'provider-session-must-never-be-exported';
const CREDENTIAL_HANDLE = 'credential-handle-must-never-be-exported';

describe('control-plane account export', () => {
  it('exports every operator-held section for the account', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAccount(database);

    const exported = await exportControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' });

    expect(exported.schemaVersion).toBe(ACCOUNT_EXPORT_SCHEMA_VERSION);
    expect(Date.parse(exported.exportedAt)).not.toBeNaN();
    expect(exported).toMatchObject({ status: 'complete', unavailableSections: [] });
    expect(exported.sections.account).toEqual({
      status: 'exported',
      account: {
        id: 'user-1',
        name: 'Test',
        email: 'user-1@example.test',
        emailVerified: true,
        image: null,
        cloudflareSubject: 'user-1',
        createdAt: '1970-01-01T00:00:00.001Z',
        updatedAt: '1970-01-01T00:00:00.001Z',
      },
    });
    expect(exported.sections.cloudflareConnection).toEqual({
      status: 'exported',
      connection: {
        id: 'connection-user-1',
        accountId: 'account-1',
        accountName: 'Account',
        status: 'active',
        grantedCapabilities: ['workers'],
        grantedOAuthScopes: [],
        oauthScopeGrantStatus: 'unknown',
        aiBillingEnabled: true,
        connectedAt: '1970-01-01T00:00:00.001Z',
        updatedAt: '1970-01-01T00:00:00.001Z',
        generation: 1,
      },
    });
    expect(exported.sections.encryptedCredential).toEqual({
      status: 'exported',
      encryptedCredential: { keyVersion: 3, storedAt: '1970-01-01T00:00:00.001Z', rotatedAt: null },
    });
    expect(exported.sections.computerRuntime).toMatchObject({
      status: 'exported',
      computerRuntime: { workerName: 'worker', endpoint: 'https://runtime.example', status: 'ready' },
    });
    expect(exported.sections.authSessions).toEqual({
      status: 'exported',
      total: 1,
      truncated: false,
      sessions: [
        {
          id: 'session-user-1',
          createdAt: '1970-01-01T00:00:00.001Z',
          updatedAt: '1970-01-01T00:00:00.001Z',
          expiresAt: '2286-11-20T17:46:39.999Z',
        },
      ],
    });
    expect(exported.sections.oauthStates).toMatchObject({
      status: 'exported',
      total: 1,
      truncated: false,
      states: [{ id: 'state-user-1', status: 'completed', returnTo: '/' }],
    });
    expect(exported.omits.join('\n')).toContain('unpromoted preview versions');
    expect(exported.omits.join('\n')).toContain('production and preview D1 databases');
  });

  it('never exports encrypted credential material, credential handles, or session tokens', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAccount(database);

    const serialized = JSON.stringify(await exportControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' }));

    for (const secret of [
      CIPHERTEXT,
      INITIALISATION_VECTOR,
      SESSION_TOKEN_HASH,
      PROVIDER_SESSION_ID,
      CREDENTIAL_HANDLE,
    ]) {
      expect({ secret, present: serialized.includes(secret) }).toEqual({ secret, present: false });
    }
    // The credential is still reported as existing, so the omission cannot be read
    // as "CloudChef holds nothing here".
    expect(serialized).toContain('"keyVersion":3');
  });

  it('exports an account with no connection, credential, or runtime as an empty but complete document', async () => {
    const { database, db } = controlPlaneDatabase();
    seedUser(database, 'user-1');

    const exported = await exportControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' });

    expect(exported.status).toBe('complete');
    expect(exported.sections.cloudflareConnection).toEqual({ status: 'exported', connection: null });
    expect(exported.sections.encryptedCredential).toEqual({ status: 'exported', encryptedCredential: null });
    expect(exported.sections.computerRuntime).toEqual({ status: 'exported', computerRuntime: null });
    expect(exported.sections.authSessions).toEqual({ status: 'exported', total: 0, truncated: false, sessions: [] });
    expect(exported.sections.oauthStates).toEqual({ status: 'exported', total: 0, truncated: false, states: [] });
  });

  it('bounds an unusual number of sessions and says how many it left behind', async () => {
    const { database, db } = controlPlaneDatabase();
    seedUser(database, 'user-1');
    const excess = ACCOUNT_EXPORT_ROW_LIMIT + 17;
    for (let index = 0; index < excess; index += 1) {
      seedAuthSession(database, 'user-1', index);
    }

    const exported = await exportControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' });

    expect(exported.sections.authSessions).toMatchObject({
      status: 'exported',
      total: excess,
      truncated: true,
    });
    expect(exported.sections.authSessions).toHaveProperty('sessions');
    const { sessions } = exported.sections.authSessions as { sessions: { id: string }[] };
    expect(sessions).toHaveLength(ACCOUNT_EXPORT_ROW_LIMIT);
    // Most recent first, so the page kept is the newest one.
    expect(sessions[0].id).toBe(`session-user-1-${excess - 1}`);
    expect(exported.status).toBe('complete');
  });

  it('names a section it could not read and refuses to call the export complete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database, db } = controlPlaneDatabase({ failOn: /FROM cloudflare_auth_sessions/ });
    seedAccount(database);

    const exported = await exportControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' });

    expect(exported.status).toBe('incomplete');
    expect(exported.unavailableSections).toEqual(['authSessions']);
    expect(exported.sections.authSessions).toEqual({
      status: 'unavailable',
      error: 'CloudChef could not read this section, so it is missing from this export.',
    });
    // The sections that did read are still there, and the account section is not
    // quietly downgraded because a neighbour failed.
    expect(exported.sections.account.status).toBe('exported');
    expect(exported.sections.oauthStates.status).toBe('exported');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('authSessions'),
      expect.stringContaining('cloudflare_auth_sessions is unavailable'),
    );
    warn.mockRestore();
  });

  it('reports every section as unavailable when the whole database is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = controlPlaneDatabase({ failOn: /./ });

    const exported = await exportControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' });

    expect(exported.status).toBe('incomplete');
    expect(exported.unavailableSections).toEqual([
      'account',
      'cloudflareConnection',
      'encryptedCredential',
      'computerRuntime',
      'authSessions',
      'oauthStates',
    ]);
    warn.mockRestore();
  });

  it('exports nothing belonging to another account', async () => {
    const { database, db } = controlPlaneDatabase();
    seedAccount(database, 'user-2');

    const exported = await exportControlPlaneAccount({ env: { DB: db } as Env, userId: 'user-1' });

    expect(exported.status).toBe('complete');
    expect(JSON.stringify(exported)).not.toContain('user-2');
    expect(exported.sections.account).toEqual({ status: 'exported', account: null });
  });
});

function seedUser(database: DatabaseSyncInstance, userId: string): void {
  database
    .prepare(
      `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, cloudflare_subject)
       VALUES (?, 'Test', ?, 1, NULL, 1, 1, ?)`,
    )
    .run(userId, `${userId}@example.test`, userId);
}

function seedAuthSession(database: DatabaseSyncInstance, userId: string, index: number): void {
  database
    .prepare(
      `INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 9999999999999, ?, ?)`,
    )
    .run(`session-${userId}-${index}`, userId, `${SESSION_TOKEN_HASH}-${index}`, index + 1, index + 1);
}

function seedAccount(database: DatabaseSyncInstance, userId = 'user-1'): void {
  seedUser(database, userId);
  database
    .prepare(
      `INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, key_version, created_at, rotated_at)
       VALUES (?, ?, ?, 3, 1, NULL)`,
    )
    .run(`${CREDENTIAL_HANDLE}-${userId}`, `${CIPHERTEXT}-${userId}`, `${INITIALISATION_VECTOR}-${userId}`);
  database
    .prepare(
      `INSERT INTO cloudflare_connections
        (id, user_id, account_id, account_name, status, credential_handle, granted_capabilities_json,
         ai_billing_enabled, connected_at, created_at, updated_at)
       VALUES (?, ?, 'account-1', 'Account', 'active', ?, '["workers"]', 1, 1, 1, 1)`,
    )
    .run(`connection-${userId}`, userId, `${CREDENTIAL_HANDLE}-${userId}`);
  database
    .prepare(
      `INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 9999999999999, 1, 1)`,
    )
    .run(`session-${userId}`, userId, `${SESSION_TOKEN_HASH}-${userId}`);
  database
    .prepare(
      `INSERT INTO cloudflare_oauth_states
        (id, provider_session_id, return_to, status, expires_at, authenticated_user_id, created_at, updated_at)
       VALUES (?, ?, '/', 'completed', 9999999999999, ?, 1, 1)`,
    )
    .run(`state-${userId}`, `${PROVIDER_SESSION_ID}-${userId}`, userId);
  database
    .prepare(
      `INSERT INTO user_computer_runtimes
        (user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
         last_error, created_at, updated_at)
       VALUES (?, ?, 1, 'worker', 'https://runtime.example', 'sha', 'ready', NULL, 1, 1)`,
    )
    .run(userId, `connection-${userId}`);
}

function controlPlaneDatabase(options: { failOn?: RegExp } = {}): {
  database: DatabaseSyncInstance;
  db: D1Database;
} {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (location: string) => DatabaseSyncInstance;
  };
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  // Apply the shipped migrations so the export is proven against the real schema.
  for (const migration of readdirSync('migrations').sort()) {
    database.exec(readFileSync(join('migrations', migration), 'utf8'));
  }
  const refuse = (sql: string) => {
    if (options.failOn?.test(sql)) {
      const table = /FROM\s+"?(\w+)"?/i.exec(sql)?.[1] ?? 'the control plane';
      throw new Error(`D1_ERROR: ${table} is unavailable`);
    }
  };
  const db = {
    prepare(sql: string) {
      const statement = (values: unknown[]) => ({
        run: async () => {
          refuse(sql);
          const result = database.prepare(sql).run(...(values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
        },
        first: async () => {
          refuse(sql);
          return database.prepare(sql).get(...(values as SQLInputValue[])) ?? null;
        },
        all: async () => {
          refuse(sql);
          return { success: true, results: database.prepare(sql).all(...(values as SQLInputValue[])) } as D1Result;
        },
      });
      return { ...statement([]), bind: (...values: unknown[]) => statement(values) };
    },
  } as unknown as D1Database;
  return { database, db };
}
