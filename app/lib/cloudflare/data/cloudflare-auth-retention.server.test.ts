import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncInstance, SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pruneCloudflareAuthData,
  pruneCloudflareAuthDataBestEffort,
  UNREFERENCED_CREDENTIAL_RETENTION_MS,
} from './cloudflare-auth-retention.server';
import { ORGANIZATION_QUOTA_WINDOW_MS } from './organizations.server';

/** Prunes with the clock at `now`. */
function pruneAt(db: D1Database, now: number) {
  vi.useFakeTimers({ toFake: ['Date'], now });
  return pruneCloudflareAuthData(db);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Cloudflare authorization retention', () => {
  it('prunes each expired class and preserves live credential references', async () => {
    const { database, db } = retentionDatabase();
    const now = 2 * UNREFERENCED_CREDENTIAL_RETENTION_MS;
    const insertState = database.prepare(
      'INSERT INTO cloudflare_oauth_states (id, status, expires_at) VALUES (?, ?, ?)',
    );
    for (const id of ['state-1', 'state-2', 'state-3']) {
      insertState.run(id, 'pending', now - 1);
    }
    insertState.run('state-live', 'pending', now + 1);
    const insertSession = database.prepare('INSERT INTO cloudflare_auth_sessions (id, expires_at) VALUES (?, ?)');
    for (const id of ['session-1', 'session-2', 'session-3']) {
      insertSession.run(id, now - 1);
    }
    insertSession.run('session-live', now + 1);
    const insertCredential = database.prepare(
      'INSERT INTO cloudflare_credentials (handle, created_at, rotated_at) VALUES (?, ?, ?)',
    );
    for (const handle of ['credential-1', 'credential-2', 'credential-3', 'credential-referenced']) {
      insertCredential.run(handle, 1, null);
    }
    insertCredential.run('credential-fresh', now, null);
    insertCredential.run('credential-recently-rotated', 1, now);
    database
      .prepare('INSERT INTO cloudflare_connections (id, credential_handle) VALUES (?, ?)')
      .run('connection-1', 'credential-referenced');
    const insertEmailToken = database.prepare(
      'INSERT INTO email_sign_in_tokens (token_hash, created_at) VALUES (?, ?)',
    );
    // Sent over an hour ago, and one sent 20 minutes ago: expired, but still counting toward the hourly limit.
    for (const hash of ['link-1', 'link-2', 'link-3']) {
      insertEmailToken.run(hash, now - 61 * 60_000);
    }
    insertEmailToken.run('link-live', now - 20 * 60_000);
    const insertGoogleState = database.prepare('INSERT INTO google_sign_in_states (id, expires_at) VALUES (?, ?)');
    insertGoogleState.run('google-expired', now - 1);
    insertGoogleState.run('google-live', now + 1);
    const insertGitHubState = database.prepare('INSERT INTO github_install_states (id, expires_at) VALUES (?, ?)');
    insertGitHubState.run('github-expired', now - 1);
    insertGitHubState.run('github-live', now + 1);
    const insertInvite = database.prepare(
      'INSERT INTO organization_invites (id, expires_at, accepted_at) VALUES (?, ?, ?)',
    );
    insertInvite.run('invite-expired', now - 1, null);
    insertInvite.run('invite-accepted-expired', now - 1, now - 2);
    insertInvite.run('invite-accepted-live', now + 1, now - 2);
    insertInvite.run('invite-live', now + 1, null);

    await expect(pruneAt(db, now)).resolves.toBeUndefined();
    expect(values(database, 'cloudflare_oauth_states', 'id')).toEqual(['state-live']);
    expect(values(database, 'cloudflare_auth_sessions', 'id')).toEqual(['session-live']);
    expect(values(database, 'email_sign_in_tokens', 'token_hash')).toEqual(['link-live']);
    expect(values(database, 'google_sign_in_states', 'id')).toEqual(['google-live']);
    expect(values(database, 'github_install_states', 'id')).toEqual(['github-live']);
    expect(values(database, 'organization_invites', 'id')).toEqual(['invite-accepted-live', 'invite-live']);
    expect(values(database, 'cloudflare_credentials', 'handle')).toEqual([
      'credential-fresh',
      'credential-recently-rotated',
      'credential-referenced',
    ]);

    await expect(pruneAt(db, now)).resolves.toBeUndefined();
    expect(values(database, 'cloudflare_credentials', 'handle')).toContain('credential-referenced');
  });

  it('keeps deleting while a table still has a full batch, up to a bound per sweep', async () => {
    const { database, db } = retentionDatabase();
    const now = 2 * UNREFERENCED_CREDENTIAL_RETENTION_MS;
    const insertState = database.prepare(
      'INSERT INTO cloudflare_oauth_states (id, status, expires_at) VALUES (?, ?, ?)',
    );
    for (let index = 0; index < 250; index += 1) {
      insertState.run(`state-${index}`, 'pending', now - 1);
    }
    insertState.run('state-live', 'pending', now + 1);
    const insertSession = database.prepare('INSERT INTO cloudflare_auth_sessions (id, expires_at) VALUES (?, ?)');
    for (let index = 0; index < 3; index += 1) {
      insertSession.run(`session-${index}`, now - 1);
    }

    await pruneAt(db, now);
    expect(values(database, 'cloudflare_oauth_states', 'id')).toEqual(['state-live']);
    expect(values(database, 'cloudflare_auth_sessions', 'id')).toEqual([]);

    // Bounded: at most 25 batches of 100 in one sweep.
    for (let index = 0; index < 2_510; index += 1) {
      insertState.run(`again-${index}`, 'pending', now - 1);
    }
    await pruneAt(db, now);
    expect(values(database, 'cloudflare_oauth_states', 'id')).toHaveLength(11);
  });

  it('keeps invite and team-creation entries for as long as the limits they count toward', async () => {
    const { database, db } = retentionDatabase();
    const now = 2 * ORGANIZATION_QUOTA_WINDOW_MS;
    const insert = database.prepare(
      `INSERT INTO organization_quota_events (kind, user_id, org_id, created_at) VALUES (?, 'user-1', 'org-1', ?)`,
    );
    insert.run('invite', now - ORGANIZATION_QUOTA_WINDOW_MS - 1);
    insert.run('team', now - ORGANIZATION_QUOTA_WINDOW_MS + 1);
    insert.run('invite', now - 60_000);

    await pruneAt(db, now);

    expect(values(database, 'organization_quota_events', 'kind')).toEqual(['invite', 'team']);
    expect(database.prepare('SELECT MIN(created_at) AS oldest FROM organization_quota_events').get()?.oldest).toBe(
      now - ORGANIZATION_QUOTA_WINDOW_MS + 1,
    );
  });

  it('contains scheduled pruning failures', async () => {
    const error = new Error('D1 unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn() })) })),
      batch: vi.fn(async () => Promise.reject(error)),
    } as unknown as D1Database;

    await expect(pruneCloudflareAuthDataBestEffort(db)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('Unable to prune expired Cloudflare authorization data');
    expect(JSON.stringify(log.mock.calls)).not.toContain('D1 unavailable');
    log.mockRestore();
  });
});

function retentionDatabase(): { database: DatabaseSyncInstance; db: D1Database } {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (location: string) => DatabaseSyncInstance;
  };
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE cloudflare_oauth_states (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE cloudflare_auth_sessions (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE cloudflare_credentials (
      handle TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER
    );
    CREATE TABLE cloudflare_connections (
      id TEXT PRIMARY KEY,
      credential_handle TEXT REFERENCES cloudflare_credentials(handle)
    );
    CREATE TABLE email_sign_in_tokens (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE google_sign_in_states (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE github_install_states (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE github_approval_states (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE organization_invites (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER
    );
    CREATE TABLE organization_quota_events (
      kind TEXT NOT NULL,
      user_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            run: async () => {
              const result = database.prepare(sql).run(...(values as SQLInputValue[]));
              return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
            },
          };
        },
      };
    },
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database;
  return { database, db };
}

function values(database: DatabaseSyncInstance, table: string, column: string): string[] {
  return database
    .prepare(`SELECT ${column} AS value FROM ${table} ORDER BY ${column}`)
    .all()
    .map((row) => row.value as string);
}
