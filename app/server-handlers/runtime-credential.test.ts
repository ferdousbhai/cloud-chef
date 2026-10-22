import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { runtimeIdentityHeaders, type RuntimeIdentity } from '~/lib/.server/cloudflare/runtime-identity-headers';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';

const mocks = vi.hoisted(() => ({
  requireActiveCloudflareConnection: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', () => ({
  findActiveCloudflareConnection: mocks.requireActiveCloudflareConnection,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: {
    fromEnv: () => ({ resolve: mocks.resolve }),
  },
}));

import { runtimeAccessAction, runtimeCredentialAction, runtimeUsageAction } from './runtime-credential';

function testEnv(encryptionKey: string = encryptionKeyBase64): Env {
  // SAFETY: `requireActiveCloudflareConnection` and the credential resolver are both mocked here,
  // so `DB` is only ever compared by identity and no other binding is read.
  return { DB: {} as D1Database, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKey } as Env;
}

const encryptionKeyBase64 = btoa('a'.repeat(32));
const connection = {
  id: 'connection-1',
  userId: 'user-1',
  accountId: '0123456789abcdef0123456789abcdef',
  accountName: 'Account',
  status: 'active',
  credentialHandle: 'credential-1',
  grantedOAuthScopes: [],
  connectedAt: 1,
  generation: 3,
};

beforeEach(() => {
  mocks.requireActiveCloudflareConnection.mockReset().mockResolvedValue(connection);
  mocks.resolve.mockReset().mockResolvedValue('fresh-access-token');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runtimeCredentialAction', () => {
  it('returns a freshly resolved token only to the exact runtime generation', async () => {
    const secret = await runtimeSecret();
    const env = testEnv();

    const response = await runtimeCredentialAction({ request: request(secret), env });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ accessToken: 'fresh-access-token' });
    expect(mocks.requireActiveCloudflareConnection).toHaveBeenCalledWith(env.DB, 'connection-1');
    expect(mocks.resolve).toHaveBeenCalledWith('credential-1', { forceRefresh: false });
  });

  it('forwards an explicit forced-refresh request only after authenticating the runtime identity', async () => {
    const secret = await runtimeSecret();
    const env = testEnv();
    const response = await runtimeCredentialAction({
      env,
      request: request(secret, undefined, { forceRefresh: true }),
    });

    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith('credential-1', { forceRefresh: true });
  });

  it.each([
    ['wrong secret', 'b'.repeat(43), { userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 3 }],
    ['wrong user', null, { userId: 'user-2', connectionId: 'connection-1', connectionGeneration: 3 }],
    ['stale generation', null, { userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 2 }],
  ])('rejects %s without resolving a token', async (_label, suppliedSecret, body) => {
    const secret = suppliedSecret ?? (await runtimeSecret());
    const response = await runtimeCredentialAction({
      request: request(secret, body),
      env: testEnv(),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('fails closed without exposing a vault failure', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('refresh token provider detail'));
    const response = await runtimeCredentialAction({
      request: request(await runtimeSecret()),
      env: testEnv(),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Cloudflare connection is unavailable.' });
  });

  it("serves an organization's token to each unpaused member's runtime, and to no one else", async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
        ('member-1', 'Sam', 'sam@acme.com', 1, 1, 1),
        ('outsider', 'Eve', 'eve@example.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1), ('org-2', 'Other', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('org-1', 'member-1', 'member', 1),
        ('org-2', 'outsider', 'admin', 1);
    `);
    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, userId: null, orgId: 'org-1' });
    const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKeyBase64 });
    const ask = async (userId: string) =>
      (
        await runtimeCredentialAction({
          request: request(await runtimeSecret(userId, 'connection-1'), {
            userId,
            connectionId: 'connection-1',
            connectionGeneration: 3,
          }),
          env,
        })
      ).status;

    expect(await ask('member-1')).toBe(200);
    expect(await ask('outsider')).toBe(401);
    // Each member's runtime has its own secret: one member's can't fetch the token as another.
    const borrowed = await runtimeCredentialAction({
      request: request(await runtimeSecret('member-1', 'connection-1'), {
        userId: 'outsider',
        connectionId: 'connection-1',
        connectionGeneration: 3,
      }),
      env,
    });
    expect(borrowed.status).toBe(401);
    database.exec(`UPDATE organization_members SET paused_at = 2 WHERE user_id = 'member-1'`);
    expect(await ask('member-1')).toBe(401);
    database.exec(`DELETE FROM organization_members WHERE user_id = 'member-1'`);
    expect(await ask('member-1')).toBe(401);
  });

  it('fails closed when the broker secret cannot be derived', async () => {
    const response = await runtimeCredentialAction({
      request: request(await runtimeSecret()),
      env: testEnv('invalid'),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Cloudflare connection is unavailable.' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});

describe('runtimeUsageAction', () => {
  it("adds each member's model use to their organization's daily totals, and records nothing for personal accounts", async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('member-1', 'Sam', 'sam@acme.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org-1', 'member-1', 'member', 1);
    `);
    const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKeyBase64 });
    const report = async (secret: string) =>
      runtimeUsageAction({
        request: request(
          secret,
          { userId: 'member-1', connectionId: 'connection-1', connectionGeneration: 3 },
          { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
        ),
        env,
      });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 18) });

    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, userId: null, orgId: 'org-1' });
    expect((await report(await runtimeSecret('member-1', 'connection-1'))).status).toBe(204);
    expect((await report(await runtimeSecret('member-1', 'connection-1'))).status).toBe(204);
    // A person's own-account secret is no good for their organization's connection.
    expect((await report(await runtimeSecret('member-1'))).status).toBe(401);
    expect((await report('x'.repeat(43))).status).toBe(401);
    expect(database.prepare('SELECT * FROM organization_usage_daily').all()).toEqual([
      {
        org_id: 'org-1',
        user_id: 'member-1',
        day: '2026-10-18',
        turns: 2,
        input_tokens: 200,
        output_tokens: 40,
        cached_tokens: 80,
      },
    ]);

    // Someone's own account: authenticated, but nothing to record.
    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, userId: 'member-1', orgId: null });
    database.exec('DELETE FROM organization_usage_daily');
    expect((await report(await runtimeSecret('member-1'))).status).toBe(204);
    expect(database.prepare('SELECT COUNT(*) AS rows FROM organization_usage_daily').get()).toEqual({ rows: 0 });
  });
});

describe('runtimeAccessAction', () => {
  it("says a member may build until they're paused", async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('member-1', 'Sam', 'sam@acme.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org-1', 'member-1', 'member', 1);
    `);
    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, userId: null, orgId: 'org-1' });
    const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKeyBase64 });
    const ask = async () => {
      const response = await runtimeAccessAction({
        request: request(await runtimeSecret('member-1', 'connection-1'), {
          userId: 'member-1',
          connectionId: 'connection-1',
          connectionGeneration: 3,
        }),
        env,
      });
      return { status: response.status, body: response.ok ? await response.json() : null };
    };

    // A member may build, but isn't an admin: the agent's direct Cloudflare tool stays off for them.
    // Their model requests are logged in the account's AI Gateway until they turn that off.
    expect(await ask()).toEqual({ status: 200, body: { organizationAdmin: false, aiGatewayContentLogging: true } });
    database.exec(`UPDATE organization_members SET role = 'admin'`);
    expect(await ask()).toEqual({ status: 200, body: { organizationAdmin: true, aiGatewayContentLogging: true } });
    // Their own opt-out holds in the team's account too.
    database.exec(`UPDATE "user" SET ai_gateway_content_logging = 0 WHERE id = 'member-1'`);
    expect(await ask()).toEqual({ status: 200, body: { organizationAdmin: true, aiGatewayContentLogging: false } });
    database.exec(`UPDATE organization_members SET paused_at = 2`);
    expect((await ask()).status).toBe(401);
  });
});

/** A runtime's call, naming `identity` in its headers as a runtime does, with `body`. */
function request(
  secret: string,
  identity: RuntimeIdentity = { userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 3 },
  body: Record<string, boolean | number> = {},
): Request {
  return new Request('https://cloudchef.build/api/cloudflare/runtime-credential', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      ...runtimeIdentityHeaders(identity),
    },
    body: JSON.stringify(body),
  });
}

/** A runtime's secret: a person's own (the default), or, given its connection, an organization's. */
function runtimeSecret(userId = connection.userId, organizationConnectionId: string | null = null): Promise<string> {
  return deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64,
    userId,
    organizationConnectionId,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
  });
}
