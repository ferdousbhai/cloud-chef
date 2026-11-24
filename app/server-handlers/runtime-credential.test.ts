import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { runtimeIdentityHeaders, type RuntimeIdentity } from '~/lib/.server/cloudflare/runtime-identity-headers';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import type * as ConnectionRepository from '~/lib/.server/cloudflare/cloudflare-connection-repository';

const mocks = vi.hoisted(() => ({
  requireActiveCloudflareConnection: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionRepository>()),
  findActiveCloudflareConnection: mocks.requireActiveCloudflareConnection,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: {
    fromEnv: () => ({ resolve: mocks.resolve }),
  },
}));

import { runtimeAccessAction, runtimeCredentialAction, runtimeUsageAction } from './runtime-credential';

/** The connection lookup and the credential resolver are mocked; the database holds who is in the space. */
function testEnv(encryptionKey: string = encryptionKeyBase64): Env {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-1', 'Sam', 'sam@example.com', 1, 1, 1);
    INSERT INTO organizations (id, name, created_at, updated_at, personal_user_id) VALUES ('space-1', 'Sam’s space', 1, 1, 'user-1');
    INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('space-1', 'user-1', 'admin', 1);
  `);
  return envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKey });
}

const encryptionKeyBase64 = btoa('a'.repeat(32));
const connection = {
  id: 'connection-1',
  // The space made for user-1, on their own Cloudflare account.
  orgId: 'space-1',
  personalUserId: 'user-1',
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
    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, orgId: 'org-1', personalUserId: null });
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
  it("adds each person's model use to their space's daily totals, in the space made for them as in any other", async () => {
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

    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, orgId: 'org-1', personalUserId: null });
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
        container_seconds: 0,
      },
    ]);

    // How long their workspace container ran is added beside, without counting a turn.
    const ran = (containerSeconds: number) => async () =>
      runtimeUsageAction({
        request: request(
          await runtimeSecret('member-1', 'connection-1'),
          { userId: 'member-1', connectionId: 'connection-1', connectionGeneration: 3 },
          { containerSeconds },
        ),
        env,
      });
    expect((await ran(300)()).status).toBe(204);
    expect((await ran(45)()).status).toBe(204);
    expect((await ran(86_401)()).status).toBe(400);
    expect(database.prepare('SELECT turns, container_seconds FROM organization_usage_daily').all()).toEqual([
      { turns: 2, container_seconds: 345 },
    ]);

    // The space made for them: their workspace there proves itself as it always did, and its use is counted too.
    mocks.requireActiveCloudflareConnection.mockResolvedValue({
      ...connection,
      orgId: 'org-1',
      personalUserId: 'member-1',
    });
    database.exec('DELETE FROM organization_usage_daily');
    expect((await report(await runtimeSecret('member-1'))).status).toBe(204);
    expect(database.prepare('SELECT COUNT(*) AS rows FROM organization_usage_daily').get()).toEqual({ rows: 1 });
  });
});

describe('runtimeAccessAction', () => {
  it("refuses a managed space's next model request once its month's allowance is used, and no other team's", async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('member-1', 'Sam', 'sam@acme.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Spaces', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org-1', 'member-1', 'member', 1);
    `);
    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, orgId: 'org-1', personalUserId: null });
    const managed = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_ID: 'price_1', MANAGED_SPACE_ORG_ID: 'org-1' };
    const ask = async (bindings: Record<string, string>) => {
      const response = await runtimeAccessAction({
        request: request(await runtimeSecret('member-1', 'connection-1'), {
          userId: 'member-1',
          connectionId: 'connection-1',
          connectionGeneration: 3,
        }),
        // SAFETY: the billing bindings' declared types are the empty text the configuration gives them; they are
        // read only as text.
        env: envWith({
          DB: db,
          CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKeyBase64,
          ...bindings,
        } as Partial<Env>),
      });
      const body: unknown = await response.json();
      return z.object({ modelRefusal: z.string().nullable() }).parse(body).modelRefusal;
    };
    expect(await ask(managed)).toBeNull();
    // A day of the workspace container alone is within the allowance.
    database
      .prepare(
        `INSERT INTO organization_usage_daily (org_id, user_id, day, container_seconds) VALUES ('org-1', 'member-1', ?, 86400)`,
      )
      .run(new Date().toISOString().slice(0, 10));
    expect(await ask(managed)).toBeNull();
    database.exec('DELETE FROM organization_usage_daily');
    // Far more output than a month's allowance buys on the default model.
    database
      .prepare(
        `INSERT INTO organization_usage_daily (org_id, user_id, day, turns, input_tokens, output_tokens, cached_tokens)
         VALUES ('org-1', 'member-1', ?, 1, 0, 1000000000, 0)`,
      )
      .run(new Date().toISOString().slice(0, 10));
    expect(await ask(managed)).toMatch(/^This space has used this month's building allowance\. It starts again on /);
    // The same use in a team that is not the one CloudChef runs spaces in is the team's own business.
    expect(await ask({ ...managed, MANAGED_SPACE_ORG_ID: 'another-org' })).toBeNull();
    // The team's admin, who pays for the account, is never held to it.
    database.exec(`UPDATE organization_members SET role = 'admin'`);
    expect(await ask(managed)).toBeNull();
  });

  it('holds a space CloudChef runs to one allowance for everyone in it, its subscriber included, and gives none of them the account', async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner-1', 'Sam', 'sam@acme.com', 1, 1, 1);
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('guest-1', 'Gia', 'gia@acme.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('host', 'Spaces', 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at, managed_host_org_id) VALUES ('space-1', 'Sam’s space', 1, 1, 'host');
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('space-1', 'owner-1', 'admin', 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('space-1', 'guest-1', 'member', 2);
    `);
    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, userId: null, orgId: 'space-1' });
    const ask = async () => {
      const response = await runtimeAccessAction({
        request: request(await runtimeSecret('owner-1', 'connection-1'), {
          userId: 'owner-1',
          connectionId: 'connection-1',
          connectionGeneration: 3,
        }),
        env: envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: encryptionKeyBase64 }),
      });
      const body: unknown = await response.json();
      return z.object({ organizationAdmin: z.boolean(), modelRefusal: z.string().nullable() }).parse(body);
    };
    // The subscriber runs the space, never the operator's Cloudflare account.
    expect(await ask()).toEqual({ organizationAdmin: false, modelRefusal: null });
    // Someone they invited uses the month's allowance up: it is the space's, so the subscriber is stopped too.
    database
      .prepare(
        `INSERT INTO organization_usage_daily (org_id, user_id, day, turns, input_tokens, output_tokens, cached_tokens)
         VALUES ('space-1', 'guest-1', ?, 1, 0, 1000000000, 0)`,
      )
      .run(new Date().toISOString().slice(0, 10));
    expect((await ask()).modelRefusal).toMatch(
      /^This space has used this month's building allowance\. Add credit in Settings to keep building now/,
    );
    // Credit bought for the space, more than the month has gone over by, lets everyone in it build again.
    database.exec(
      `INSERT INTO space_credit_purchases (checkout_session_id, org_id, user_id, amount_usd, created_at)
       VALUES ('cs_1', 'space-1', 'owner-1', 100000, 1)`,
    );
    expect((await ask()).modelRefusal).toBeNull();
  });

  it("says a member may build until they're paused", async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('member-1', 'Sam', 'sam@acme.com', 1, 1, 1);
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Acme', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org-1', 'member-1', 'member', 1);
    `);
    mocks.requireActiveCloudflareConnection.mockResolvedValue({ ...connection, orgId: 'org-1', personalUserId: null });
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
    expect(await ask()).toEqual({
      status: 200,
      body: {
        organizationAdmin: false,
        aiGatewayContentLogging: true,
        member: { name: 'Sam', email: 'sam@acme.com' },
        modelRefusal: null,
      },
    });
    database.exec(`UPDATE organization_members SET role = 'admin'`);
    expect(await ask()).toEqual({
      status: 200,
      body: {
        organizationAdmin: true,
        aiGatewayContentLogging: true,
        member: { name: 'Sam', email: 'sam@acme.com' },
        modelRefusal: null,
      },
    });
    // Their own opt-out holds in the team's account too.
    database.exec(`UPDATE "user" SET ai_gateway_content_logging = 0 WHERE id = 'member-1'`);
    expect(await ask()).toEqual({
      status: 200,
      body: {
        organizationAdmin: true,
        aiGatewayContentLogging: false,
        member: { name: 'Sam', email: 'sam@acme.com' },
        modelRefusal: null,
      },
    });
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
function runtimeSecret(userId = 'user-1', organizationConnectionId: string | null = null): Promise<string> {
  return deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64,
    userId,
    organizationConnectionId,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
  });
}
