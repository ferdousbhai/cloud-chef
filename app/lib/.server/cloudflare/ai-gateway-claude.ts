import type { CloudflareConnection } from './cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { UserCloudflareAccountApi, type AiGatewayProviderKey } from './user-account-api';

/**
 * Claude runs in a connected account only with that account's own Anthropic key, stored on its
 * `default` AI Gateway as a provider key (BYOK) in the account's Secrets Store. CloudChef links and
 * unlinks the key with the connection's Cloudflare authorization and asks whether one is there; it
 * never stores, reads, or returns the key itself.
 */
export const CLAUDE_GATEWAY_ID = 'default';
export const ANTHROPIC_PROVIDER_SLUG = 'anthropic';

/** The alias CloudChef links the account's Anthropic key under. */
export const CLAUDE_KEY_ALIAS = 'cloudchef';

/**
 * The Secrets Store secret Cloudflare keeps that key in: AI Gateway names a provider key's secret
 * `{gateway}_{provider}_{alias}`. The name is CloudChef's, so relinking and unlinking delete it.
 */
export const CLAUDE_KEY_SECRET_NAME = `${CLAUDE_GATEWAY_ID}_${ANTHROPIC_PROVIDER_SLUG}_${CLAUDE_KEY_ALIAS}`;

/** What Settings and the runtimes need of the connected account's Cloudflare API. */
export type ClaudeKeyAccountApi = Pick<
  UserCloudflareAccountApi,
  | 'listAiGatewayProviderKeys'
  | 'addAiGatewayProviderKey'
  | 'deleteAiGatewayProviderKey'
  | 'prepareAiGatewayForKeys'
  | 'listSecretsStores'
  | 'listAiGatewaySecrets'
  | 'deleteSecret'
>;

export type OpenClaudeKeyAccountApi = (env: Env, connection: CloudflareConnection) => Promise<ClaudeKeyAccountApi>;

/** The connected account's API, with its stored authorization, refreshed once if Cloudflare refuses it. */
export const openClaudeKeyAccountApi: OpenClaudeKeyAccountApi = async (env, connection) => {
  const handle = connection.credentialHandle;
  if (!handle) {
    throw new Error('The Cloudflare connection has no authorization.');
  }
  const vault = D1CloudflareCredentialVault.fromEnv(env);
  return new UserCloudflareAccountApi(connection.accountId, await vault.resolve(handle), fetch, undefined, () =>
    vault.resolve(handle, { forceRefresh: true }),
  );
};

/** Whether the connection's authorization lets CloudChef manage the gateway's provider keys at all. */
export function canManageAiGatewayKeys(connection: Pick<CloudflareConnection, 'grantedCapabilities'>): boolean {
  return connection.grantedCapabilities.includes('ai_gateway_keys');
}

/** The Anthropic key on the account's default gateway, the one requests without an alias use. */
export async function findClaudeKey(api: ClaudeKeyAccountApi): Promise<AiGatewayProviderKey | null> {
  const keys = (await api.listAiGatewayProviderKeys(CLAUDE_GATEWAY_ID)).filter(
    ({ providerSlug }) => providerSlug === ANTHROPIC_PROVIDER_SLUG,
  );
  return keys.find(({ isDefault }) => isDefault) ?? keys.at(0) ?? null;
}

/**
 * Whether Claude can run in this account now: asked of Cloudflare, so a key removed in the dashboard
 * stops Claude at once. Anything unanswerable (no authorization to ask with, Cloudflare unreachable)
 * is a no: Claude runs only with a key confirmed linked.
 */
export async function isClaudeLinked(
  env: Env,
  connection: CloudflareConnection,
  open: OpenClaudeKeyAccountApi = openClaudeKeyAccountApi,
): Promise<boolean> {
  if (!canManageAiGatewayKeys(connection)) {
    return false;
  }
  try {
    return (await findClaudeKey(await open(env, connection))) !== null;
  } catch {
    console.warn('Unable to confirm whether the account has an Anthropic key linked.');
    return false;
  }
}
