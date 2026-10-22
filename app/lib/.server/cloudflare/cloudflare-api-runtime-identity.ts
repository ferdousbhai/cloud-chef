import type { CloudflareOAuthScopeGrantStatus } from './cloudflare-oauth-scope-manifest';

export type CloudflareApiRuntimeIdentity = {
  userId: string;
  accountId: string;
  connectionId: string;
  connectionGeneration: number;
  oauthScopeGrantStatus: CloudflareOAuthScopeGrantStatus;
};

export type CloudflareApiRuntimeEnv = Pick<
  Env,
  | 'CLOUDCHEF_USER_RUNTIME'
  | 'CLOUDCHEF_USER_ID'
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDCHEF_CONNECTION_ID'
  | 'CLOUDCHEF_CONNECTION_GENERATION'
  | 'CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS'
  | 'CLOUDCHEF_SHARED_ACCOUNT'
>;

/**
 * The connection identity a user-owned runtime sends Cloudflare API requests as, or null when its
 * bindings are missing or malformed, or when this person may not use the account's API. Callers re-read
 * it before each operation, so a demoted admin or a replaced connection stops newly admitted work.
 */
export async function readCloudflareApiRuntimeIdentity(
  env: CloudflareApiRuntimeEnv,
  /** In an organization's account: whether this person is now one of its active admins. */
  isOrganizationAdmin: () => Promise<boolean> = async () => false,
): Promise<CloudflareApiRuntimeIdentity | null> {
  const identity = runtimeIdentity(env);
  if (!identity) {
    return null;
  }
  // In an organization's account, only its admins: its authorization reaches every member's workspace,
  // Worker code and storage, even read-only. Members change their resources through the deployment
  // pipeline (or GitHub), which touches only their own. Asked afresh each time, so a demoted admin stops.
  if (env.CLOUDCHEF_SHARED_ACCOUNT === '1' && !(await isOrganizationAdmin().catch(() => false))) {
    return null;
  }
  return identity;
}

/** The person, account, connection generation and known grant a user-owned runtime was provisioned for. */
export function runtimeIdentity(env: CloudflareApiRuntimeEnv): CloudflareApiRuntimeIdentity | null {
  const connection = runtimeConnectionIdentity(env);
  const oauthScopeGrantStatus = env.CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS;
  if (
    !connection ||
    (oauthScopeGrantStatus !== 'core' && oauthScopeGrantStatus !== 'partial' && oauthScopeGrantStatus !== 'full')
  ) {
    return null;
  }
  return { ...connection, oauthScopeGrantStatus };
}

export type RuntimeConnectionIdentity = Omit<CloudflareApiRuntimeIdentity, 'oauthScopeGrantStatus'>;

/** The bindings naming a runtime's connection; one without its user-runtime marker is not a user runtime. */
export type RuntimeConnectionEnv = Pick<
  Env,
  'CLOUDCHEF_USER_ID' | 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDCHEF_CONNECTION_ID' | 'CLOUDCHEF_CONNECTION_GENERATION'
> &
  Partial<Pick<Env, 'CLOUDCHEF_USER_RUNTIME'>>;

/** The person, account and connection generation a user-owned runtime was provisioned for, from its bindings. */
export function runtimeConnectionIdentity(env: RuntimeConnectionEnv): RuntimeConnectionIdentity | null {
  const connectionGeneration = Number(env.CLOUDCHEF_CONNECTION_GENERATION);
  if (
    env.CLOUDCHEF_USER_RUNTIME !== '1' ||
    !env.CLOUDCHEF_USER_ID ||
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.CLOUDCHEF_CONNECTION_ID ||
    !Number.isSafeInteger(connectionGeneration) ||
    connectionGeneration < 1
  ) {
    return null;
  }
  return {
    userId: env.CLOUDCHEF_USER_ID,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    connectionId: env.CLOUDCHEF_CONNECTION_ID,
    connectionGeneration,
  };
}
