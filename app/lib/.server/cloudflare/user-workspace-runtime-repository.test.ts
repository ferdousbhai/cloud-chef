import { describe, expect, it } from 'vitest';
import { controlPlaneDatabase } from '~/test/control-plane-d1';
import {
  findUserWorkspaceRuntime,
  listOutdatedUserWorkspaceRuntimes,
  recordUserWorkspaceRuntimeSession,
  upsertUserWorkspaceRuntime,
} from './user-workspace-runtime-repository';

describe('workspace runtime locator', () => {
  it('stores and replaces the ready runtime for a user', async () => {
    const db = runtimeDatabase();

    await upsertUserWorkspaceRuntime(runtimeArgs(db, { runtimeVersion: 'a'.repeat(64), now: 1 }));
    await upsertUserWorkspaceRuntime(runtimeArgs(db, { runtimeVersion: 'b'.repeat(64), now: 2 }));

    await expect(findUserWorkspaceRuntime(db, 'user-1', 'connection-1')).resolves.toMatchObject({
      runtimeVersion: 'b'.repeat(64),
    });
  });

  it('keeps a separate runtime for each account a person builds in', async () => {
    const db = runtimeDatabase();

    await upsertUserWorkspaceRuntime(runtimeArgs(db, { runtimeVersion: 'a'.repeat(64), now: 1 }));
    await upsertUserWorkspaceRuntime({
      ...runtimeArgs(db, { runtimeVersion: 'b'.repeat(64), now: 2 }),
      connectionId: 'org-connection',
      endpoint: 'https://org-workspace.example',
    });

    await expect(findUserWorkspaceRuntime(db, 'user-1', 'connection-1')).resolves.toMatchObject({
      endpoint: 'https://workspace.example',
    });
    await expect(findUserWorkspaceRuntime(db, 'user-1', 'org-connection')).resolves.toMatchObject({
      endpoint: 'https://org-workspace.example',
    });
  });

  it('records the protocol a runtime speaks, and counts its provisioning as its latest use', async () => {
    const db = runtimeDatabase();
    await upsertUserWorkspaceRuntime(runtimeArgs(db, { runtimeVersion: 'a'.repeat(64), now: 1_000 }));

    await expect(findUserWorkspaceRuntime(db, 'user-1', 'connection-1')).resolves.toMatchObject({
      protocolVersion: 1,
    });
    await expect(lastSessionAt(db)).resolves.toBe(1_000);
  });

  it('records when a session was last issued, at most once a minute', async () => {
    const db = runtimeDatabase();
    await upsertUserWorkspaceRuntime(runtimeArgs(db, { runtimeVersion: 'a'.repeat(64), now: 1_000 }));

    await recordUserWorkspaceRuntimeSession(db, { userId: 'user-1', connectionId: 'connection-1', now: 30_000 });
    await expect(lastSessionAt(db)).resolves.toBe(1_000);

    await recordUserWorkspaceRuntimeSession(db, { userId: 'user-1', connectionId: 'connection-1', now: 61_001 });
    await expect(lastSessionAt(db)).resolves.toBe(61_001);
  });

  it('lists the outdated runtimes a session could still be issued for, most recently used first', async () => {
    const db = runtimeDatabase();
    const current = { runtimeVersion: 'c'.repeat(64), imageDigest: 'image@sha256:current', protocolVersion: 2 };
    const ready = (overrides: Partial<Parameters<typeof upsertUserWorkspaceRuntime>[0]>) =>
      upsertUserWorkspaceRuntime({
        ...runtimeArgs(db, { runtimeVersion: 'a'.repeat(64), now: 1 }),
        imageDigest: current.imageDigest,
        protocolVersion: current.protocolVersion,
        ...overrides,
      });
    await ready({ connectionId: 'connection-1', now: 1_000 });
    await ready({ connectionId: 'org-connection', endpoint: 'https://org.example', now: 2_000 });
    await expect(listOutdatedUserWorkspaceRuntimes(db, { ...current, limit: 10, rotation: 0 })).resolves.toEqual([
      { userId: 'user-1', connectionId: 'org-connection', connectionGeneration: 1 },
      { userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 1 },
    ]);
    await expect(listOutdatedUserWorkspaceRuntimes(db, { ...current, limit: 1, rotation: 0 })).resolves.toHaveLength(1);

    // Current; on another image; speaking another protocol; for a connection generation since replaced.
    await ready({ connectionId: 'connection-1', runtimeVersion: current.runtimeVersion });
    await ready({ connectionId: 'org-connection', runtimeVersion: current.runtimeVersion, imageDigest: 'old-image' });
    await expect(listOutdatedUserWorkspaceRuntimes(db, { ...current, limit: 10, rotation: 0 })).resolves.toEqual([
      { userId: 'user-1', connectionId: 'org-connection', connectionGeneration: 1 },
    ]);
    await ready({ connectionId: 'org-connection', protocolVersion: 1 });
    await expect(listOutdatedUserWorkspaceRuntimes(db, { ...current, limit: 10, rotation: 0 })).resolves.toEqual([]);
    await ready({ connectionId: 'org-connection' });
    await db.prepare(`UPDATE cloudflare_connections SET connection_generation = 2 WHERE id = 'org-connection'`).run();
    await expect(listOutdatedUserWorkspaceRuntimes(db, { ...current, limit: 10, rotation: 0 })).resolves.toEqual([]);
    await db.prepare(`UPDATE cloudflare_connections SET connection_generation = 1, status = 'revoked'`).run();
    await expect(listOutdatedUserWorkspaceRuntimes(db, { ...current, limit: 10, rotation: 0 })).resolves.toEqual([]);
  });

  it('reads a later page of the outdated runtimes on each sweep, wrapping around to the first', async () => {
    const db = runtimeDatabase();
    const current = { runtimeVersion: 'c'.repeat(64), imageDigest: 'image@sha256:current', protocolVersion: 1 };
    for (const [connectionId, now] of [
      ['connection-a', 3_000],
      ['connection-b', 2_000],
      ['connection-c', 1_000],
    ] as const) {
      const userId = `user-of-${connectionId}`;
      await db
        .prepare(
          `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'User', ?, 1, 1, 1)`,
        )
        .bind(userId, `${userId}@example.com`)
        .run();
      await db
        .prepare(
          `INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', 1, 1)`,
        )
        .bind(connectionId, userId, `account-${connectionId}`)
        .run();
      await upsertUserWorkspaceRuntime({
        ...runtimeArgs(db, { runtimeVersion: 'a'.repeat(64), now }),
        userId,
        connectionId,
        endpoint: `https://${connectionId}.example`,
      });
    }
    const sweep = async (rotation: number) =>
      (await listOutdatedUserWorkspaceRuntimes(db, { ...current, limit: 2, rotation })).map(
        ({ connectionId }) => connectionId,
      );

    await expect(sweep(0)).resolves.toEqual(['connection-a', 'connection-b']);
    await expect(sweep(1)).resolves.toEqual(['connection-c', 'connection-a']);
    await expect(sweep(2)).resolves.toEqual(['connection-b', 'connection-c']);
  });

  it('does not return an unfinished legacy row', async () => {
    const db = runtimeDatabase();
    await db
      .prepare(
        `INSERT INTO user_computer_runtimes
          (user_id, connection_id, connection_generation, worker_name, endpoint,
           runtime_version, status, created_at, updated_at)
         VALUES ('user-1', 'connection-1', 1, 'worker', 'https://workspace.example', 'old',
                 'provisioning', 1, 1)`,
      )
      .run();

    await expect(findUserWorkspaceRuntime(db, 'user-1', 'connection-1')).resolves.toBeNull();
  });
});

function runtimeArgs(db: D1Database, overrides: { runtimeVersion: string; now: number }) {
  return {
    db,
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    workerName: 'worker',
    endpoint: 'https://workspace.example',
    runtimeVersion: overrides.runtimeVersion,
    imageDigest: 'docker.io/cloudflare/sandbox@sha256:test',
    protocolVersion: 1,
    now: overrides.now,
  };
}

/** A user with their own connection, and an organization connection they also build in. */
function runtimeDatabase(): D1Database {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('user-1', 'User', 'user@example.com', 1, 1, 1);
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1);
    INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
      VALUES ('connection-1', 'user-1', 'account-1', 'active', 1, 1);
    INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
      VALUES ('org-connection', 'org-1', 'account-2', 'active', 1, 1);
  `);
  return db;
}

async function lastSessionAt(db: D1Database): Promise<number | undefined> {
  const row = await db
    .prepare(
      "SELECT last_session_at FROM user_computer_runtimes WHERE user_id = 'user-1' AND connection_id = 'connection-1'",
    )
    .first<{ last_session_at: number }>();
  return row?.last_session_at;
}
