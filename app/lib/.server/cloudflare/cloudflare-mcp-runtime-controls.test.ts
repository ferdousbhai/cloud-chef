import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS,
  cloudflareMcpExecuteEnabled,
  readCloudflareMcpRuntimeAdmission,
} from './cloudflare-mcp-runtime-controls';

const enabledRows = CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS.map((key) => ({ key, enabled: 1 }));

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

describe('Cloudflare MCP runtime controls', () => {
  it('admits a known grant only when every typed row is present and well formed', async () => {
    // SAFETY: testEnv supplies every runtime binding read by this function and a D1 result stub.
    const admission = await readCloudflareMcpRuntimeAdmission(testEnv() as never);

    expect(admission).toEqual({
      identity: {
        userId: 'user-1',
        accountId: 'account-1',
        connectionId: 'connection-1',
        connectionGeneration: 3,
        oauthScopeGrantStatus: 'full',
      },
      controls: {
        cloudflare_mcp: true,
        cloudflare_mcp_execute: true,
        cloudflare_mcp_billable: true,
        cloudflare_mcp_credentials: true,
        cloudflare_mcp_registrar: true,
      },
    });
  });

  it.each([
    { label: 'unknown grant', env: testEnv(enabledRows, 'unknown') },
    { label: 'missing row', env: testEnv(enabledRows.slice(1)) },
    {
      label: 'malformed row',
      env: testEnv(enabledRows.map((row) => (row.key === 'cloudflare_mcp' ? { ...row, enabled: 2 } : row))),
    },
  ])('fails closed for a $label', async ({ env }) => {
    // SAFETY: each case mutates only the boundary value under test; the remaining runtime shape is complete.
    await expect(readCloudflareMcpRuntimeAdmission(env as never)).resolves.toBeNull();
  });

  it('keeps execute disabled until every unclassified mutation-class switch is enabled', () => {
    const controls = {
      cloudflare_mcp: true,
      cloudflare_mcp_execute: true,
      cloudflare_mcp_billable: true,
      cloudflare_mcp_credentials: true,
      cloudflare_mcp_registrar: true,
    };
    expect(cloudflareMcpExecuteEnabled(controls)).toBe(true);
    for (const key of CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS) {
      expect(cloudflareMcpExecuteEnabled({ ...controls, [key]: false })).toBe(false);
    }
  });
});
