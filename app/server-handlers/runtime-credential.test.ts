import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';

const mocks = vi.hoisted(() => ({
  requireActiveCloudflareConnection: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', () => ({
  requireActiveCloudflareConnection: mocks.requireActiveCloudflareConnection,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: {
    fromEnv: () => ({ resolve: mocks.resolve }),
  },
}));

import { runtimeCredentialAction } from './runtime-credential';

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
  grantedCapabilities: [],
  requestedOAuthScopes: [],
  grantedOAuthScopes: [],
  oauthScopeProfileVersion: null,
  oauthScopeGrantStatus: 'unknown',
  aiBillingEnabled: true,
  connectedAt: 1,
  generation: 3,
};

beforeEach(() => {
  mocks.requireActiveCloudflareConnection.mockReset().mockResolvedValue(connection);
  mocks.resolve.mockReset().mockResolvedValue('fresh-access-token');
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
      request: new Request('https://cloudchef.build/api/cloudflare/runtime-credential', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          connectionId: 'connection-1',
          connectionGeneration: 3,
          forceRefresh: true,
        }),
      }),
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

function request(
  secret: string,
  body: { userId: string; connectionId: string; connectionGeneration: number } = {
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 3,
  },
): Request {
  return new Request('https://cloudchef.build/api/cloudflare/runtime-credential', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function runtimeSecret(): Promise<string> {
  return deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64,
    userId: connection.userId,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
  });
}
