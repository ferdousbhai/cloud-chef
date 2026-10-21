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

/**
 * AI Gateway finds a provider key's secret by its name, `{gateway}_{provider}_{alias}`, not by the id
 * a provider key records, so only a secret named that way can be linked.
 */
const LINKABLE_SECRET_NAME = new RegExp(`^${CLAUDE_GATEWAY_ID}_${ANTHROPIC_PROVIDER_SLUG}_([A-Za-z0-9_-]{1,64})$`);

/** The alias a Secrets Store secret is linked under, or null when its name does not follow the convention. */
export function linkableSecretAlias(secretName: string): string | null {
  return LINKABLE_SECRET_NAME.exec(secretName)?.[1] ?? null;
}

/** What Settings and the runtimes need of the connected account's Cloudflare API. */
export type ClaudeKeyAccountApi = Pick<
  UserCloudflareAccountApi,
  'listAiGatewayProviderKeys' | 'addAiGatewayProviderKey' | 'deleteAiGatewayProviderKey' | 'listAiGatewaySecrets'
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
