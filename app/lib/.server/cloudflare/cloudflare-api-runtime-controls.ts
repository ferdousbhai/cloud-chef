import type { CloudflareOAuthScopeGrantStatus } from './cloudflare-oauth-scope-manifest';

export const CLOUDFLARE_API_RUNTIME_CONTROL_KEYS = ['cloudflare_api', 'cloudflare_api_write'] as const;

type CloudflareApiRuntimeControlKey = (typeof CLOUDFLARE_API_RUNTIME_CONTROL_KEYS)[number];

type CloudflareApiRuntimeControls = Record<CloudflareApiRuntimeControlKey, boolean>;

/** Writes need both switches; `cloudflare_api` alone admits read-only requests. */
export function cloudflareApiWriteEnabled(controls: CloudflareApiRuntimeControls): boolean {
  return controls.cloudflare_api && controls.cloudflare_api_write;
}

export type CloudflareApiRuntimeAdmission = {
  identity: CloudflareApiRuntimeIdentity;
  controls: CloudflareApiRuntimeControls;
};

export type CloudflareApiRuntimeIdentity = {
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

type CloudflareApiRuntimeEnv = Pick<
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
export async function readCloudflareApiRuntimeAdmission(
  env: CloudflareApiRuntimeEnv,
): Promise<CloudflareApiRuntimeAdmission | null> {
  const identity = runtimeIdentity(env);
  if (!identity) {
    return null;
  }
  const placeholders = CLOUDFLARE_API_RUNTIME_CONTROL_KEYS.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT key, enabled FROM runtime_controls WHERE key IN (${placeholders}) ORDER BY key`,
  )
    .bind(...CLOUDFLARE_API_RUNTIME_CONTROL_KEYS)
    .all<RuntimeControlRow>();
  if (result.results.length !== CLOUDFLARE_API_RUNTIME_CONTROL_KEYS.length) {
    return null;
  }
  const values = new Map(result.results.map((row) => [row.key, row.enabled]));
  if (
    values.size !== CLOUDFLARE_API_RUNTIME_CONTROL_KEYS.length ||
    CLOUDFLARE_API_RUNTIME_CONTROL_KEYS.some((key) => values.get(key) !== 0 && values.get(key) !== 1)
  ) {
    return null;
  }
  return {
    identity,
    controls: {
      cloudflare_api: values.get('cloudflare_api') === 1,
      cloudflare_api_write: values.get('cloudflare_api_write') === 1,
    },
  };
}

function runtimeIdentity(env: CloudflareApiRuntimeEnv): CloudflareApiRuntimeIdentity | null {
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
