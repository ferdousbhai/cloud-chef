import { describe, expect, it } from 'vitest';
import { readCloudflareApiRuntimeIdentity, type CloudflareApiRuntimeEnv } from './cloudflare-api-runtime-identity';

function testEnv(): CloudflareApiRuntimeEnv {
  return {
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_USER_ID: 'user-1',
    CLOUDFLARE_ACCOUNT_ID: 'account-1',
    CLOUDCHEF_CONNECTION_ID: 'connection-1',
    CLOUDCHEF_CONNECTION_GENERATION: '3',
  };
}

describe('Cloudflare API runtime identity', () => {
  it('admits complete bindings', async () => {
    await expect(readCloudflareApiRuntimeIdentity(testEnv())).resolves.toEqual({
      userId: 'user-1',
      accountId: 'account-1',
      connectionId: 'connection-1',
      connectionGeneration: 3,
    });
  });

  it.each([
    { label: 'shared organization account', env: { ...testEnv(), CLOUDCHEF_SHARED_ACCOUNT: '1' } },
    { label: 'missing generation', env: { ...testEnv(), CLOUDCHEF_CONNECTION_GENERATION: '' } },
  ])('fails closed for a $label', async ({ env }) => {
    await expect(readCloudflareApiRuntimeIdentity(env)).resolves.toBeNull();
  });

  it("admits an organization's active admin, and nobody else, in its account", async () => {
    const shared = { ...testEnv(), CLOUDCHEF_SHARED_ACCOUNT: '1' };
    await expect(readCloudflareApiRuntimeIdentity(shared, async () => true)).resolves.not.toBeNull();
    await expect(readCloudflareApiRuntimeIdentity(shared, async () => false)).resolves.toBeNull();
    // An access check that can't be answered admits nobody.
    await expect(
      readCloudflareApiRuntimeIdentity(shared, async () => {
        throw new Error('control plane unreachable');
      }),
    ).resolves.toBeNull();
  });
});
