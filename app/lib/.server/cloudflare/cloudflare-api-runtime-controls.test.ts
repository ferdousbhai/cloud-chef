import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_API_RUNTIME_CONTROL_KEYS,
  cloudflareApiWriteEnabled,
  readCloudflareApiRuntimeAdmission,
} from './cloudflare-api-runtime-controls';

const enabledRows = CLOUDFLARE_API_RUNTIME_CONTROL_KEYS.map((key) => ({ key, enabled: 1 }));

function testEnv(rows = enabledRows, grant = 'full') {
  return {
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_USER_ID: 'user-1',
    CLOUDFLARE_ACCOUNT_ID: 'account-1',
    CLOUDCHEF_CONNECTION_ID: 'connection-1',
    CLOUDCHEF_CONNECTION_GENERATION: '3',
    CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS: grant,
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: rows }),
        }),
      }),
    },
  };
}

describe('Cloudflare API runtime controls', () => {
  it('admits a known grant only when every typed row is present and well formed', async () => {
    // SAFETY: testEnv supplies every runtime binding read by this function and a D1 result stub.
    const admission = await readCloudflareApiRuntimeAdmission(testEnv() as never);

    expect(admission).toEqual({
      identity: {
        userId: 'user-1',
        accountId: 'account-1',
        connectionId: 'connection-1',
        connectionGeneration: 3,
        oauthScopeGrantStatus: 'full',
      },
      controls: { cloudflare_api: true, cloudflare_api_write: true },
    });
  });

  it.each([
    { label: 'unknown grant', env: testEnv(enabledRows, 'unknown') },
    { label: 'missing row', env: testEnv(enabledRows.slice(1)) },
    {
      label: 'malformed row',
      env: testEnv(enabledRows.map((row) => (row.key === 'cloudflare_api' ? { ...row, enabled: 2 } : row))),
    },
  ])('fails closed for a $label', async ({ env }) => {
    // SAFETY: each case mutates only the boundary value under test; the remaining runtime shape is complete.
    await expect(readCloudflareApiRuntimeAdmission(env as never)).resolves.toBeNull();
  });

  it('admits writes only when both switches are enabled', () => {
    expect(cloudflareApiWriteEnabled({ cloudflare_api: true, cloudflare_api_write: true })).toBe(true);
    expect(cloudflareApiWriteEnabled({ cloudflare_api: false, cloudflare_api_write: true })).toBe(false);
    expect(cloudflareApiWriteEnabled({ cloudflare_api: true, cloudflare_api_write: false })).toBe(false);
  });
});
