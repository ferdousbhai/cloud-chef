import type { CloudflareOAuthScopeGrantStatus } from './cloudflare-oauth-scope-manifest';

export const CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS = [
  'cloudflare_mcp',
  'cloudflare_mcp_execute',
  'cloudflare_mcp_billable',
  'cloudflare_mcp_credentials',
  'cloudflare_mcp_registrar',
] as const;

export type CloudflareMcpRuntimeControlKey = (typeof CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS)[number];

export type CloudflareMcpRuntimeControls = Record<CloudflareMcpRuntimeControlKey, boolean>;

/**
 * Execute code is intentionally treated as unclassified in this phase. Until a later static
 * analysis phase can prove the affected operation classes, every mutation-class switch must be
 * enabled before the tool is admitted.
 */
export function cloudflareMcpExecuteEnabled(controls: CloudflareMcpRuntimeControls): boolean {
  return (
    controls.cloudflare_mcp &&
    controls.cloudflare_mcp_execute &&
    controls.cloudflare_mcp_billable &&
    controls.cloudflare_mcp_credentials &&
    controls.cloudflare_mcp_registrar
  );
}

export type CloudflareMcpRuntimeIdentity = {
  userId: string;
  accountId: string;
  connectionId: string;
  connectionGeneration: number;
  oauthScopeGrantStatus: Exclude<CloudflareOAuthScopeGrantStatus, 'unknown'>;
};

type RuntimeControlRow = {
  key: string;
  enabled: number;
};

type CloudflareMcpRuntimeEnv = Pick<
  Env,
  | 'DB'
  | 'CLOUDCHEF_USER_RUNTIME'
  | 'CLOUDCHEF_USER_ID'
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDCHEF_CONNECTION_ID'
  | 'CLOUDCHEF_CONNECTION_GENERATION'
  | 'CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS'
>;

/**
 * Read the operator controls and authenticated connection identity from the user-owned runtime.
 * Missing bindings, unknown grants, absent control rows, duplicate rows, and malformed values all
 * disable the integration. Callers re-read this before each operation so a kill switch prevents
 * newly admitted work without taking workspace reads or deployments offline.
 */
export async function readCloudflareMcpRuntimeAdmission(
  env: CloudflareMcpRuntimeEnv,
): Promise<{ identity: CloudflareMcpRuntimeIdentity; controls: CloudflareMcpRuntimeControls } | null> {
  const identity = runtimeIdentity(env);
  if (!identity) {
    return null;
  }
  const placeholders = CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT key, enabled FROM runtime_controls WHERE key IN (${placeholders}) ORDER BY key`,
  )
    .bind(...CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS)
    .all<RuntimeControlRow>();
  if (result.results.length !== CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS.length) {
    return null;
  }
  const values = new Map(result.results.map((row) => [row.key, row.enabled]));
  if (
    values.size !== CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS.length ||
    CLOUDFLARE_MCP_RUNTIME_CONTROL_KEYS.some((key) => values.get(key) !== 0 && values.get(key) !== 1)
  ) {
    return null;
  }
  return {
    identity,
    controls: {
      cloudflare_mcp: values.get('cloudflare_mcp') === 1,
      cloudflare_mcp_execute: values.get('cloudflare_mcp_execute') === 1,
      cloudflare_mcp_billable: values.get('cloudflare_mcp_billable') === 1,
      cloudflare_mcp_credentials: values.get('cloudflare_mcp_credentials') === 1,
      cloudflare_mcp_registrar: values.get('cloudflare_mcp_registrar') === 1,
    },
  };
}

function runtimeIdentity(env: CloudflareMcpRuntimeEnv): CloudflareMcpRuntimeIdentity | null {
  const connectionGeneration = Number(env.CLOUDCHEF_CONNECTION_GENERATION);
  const oauthScopeGrantStatus = env.CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS;
  if (
    env.CLOUDCHEF_USER_RUNTIME !== '1' ||
    !env.CLOUDCHEF_USER_ID ||
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.CLOUDCHEF_CONNECTION_ID ||
    !Number.isSafeInteger(connectionGeneration) ||
    connectionGeneration < 1 ||
    (oauthScopeGrantStatus !== 'core' && oauthScopeGrantStatus !== 'partial' && oauthScopeGrantStatus !== 'full')
  ) {
    return null;
  }
  return {
    userId: env.CLOUDCHEF_USER_ID,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    connectionId: env.CLOUDCHEF_CONNECTION_ID,
    connectionGeneration,
    oauthScopeGrantStatus,
  };
}
