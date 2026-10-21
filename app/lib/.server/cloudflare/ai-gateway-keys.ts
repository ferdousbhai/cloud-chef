import type { CloudflareConnection } from './cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { UserCloudflareAccountApi, type AiGatewayProviderKey } from './user-account-api';
import { GATEWAY_PROVIDER_SLUGS, type GatewayKey, type GatewayProviderSlug } from '~/lib/workers-ai-model';

/**
 * A gateway provider's models run in a connected account only with that account's own key for the
 * provider, stored on its `default` AI Gateway as a provider key (BYOK) in the account's Secrets
 * Store, whoever added it: an admin in Cloudflare's dashboard, under any alias, or CloudChef from
 * Settings. CloudChef reads which keys are there from the account itself each time, links and
 * unlinks its own with the connection's Cloudflare authorization, and never stores, reads, or
 * returns a key itself.
 */
export const AI_GATEWAY_ID = 'default';

/** The alias CloudChef links a pasted key under; any other alias is a key added outside CloudChef. */
export const CLOUDCHEF_KEY_ALIAS = 'cloudchef';

/**
 * The Secrets Store secret Cloudflare keeps a key CloudChef linked in: AI Gateway names a provider
 * key's secret `{gateway}_{provider}_{alias}`. The name is CloudChef's, so relinking and unlinking
 * delete it.
 */
export function cloudchefKeySecretName(provider: GatewayProviderSlug): string {
  return `${AI_GATEWAY_ID}_${provider}_${CLOUDCHEF_KEY_ALIAS}`;
}

/** What Settings and the runtimes need of the connected account's Cloudflare API. */
export type GatewayKeyAccountApi = Pick<
  UserCloudflareAccountApi,
  | 'listAiGatewayProviderKeys'
  | 'addAiGatewayProviderKey'
  | 'deleteAiGatewayProviderKey'
  | 'prepareAiGatewayForKeys'
  | 'listSecretsStores'
  | 'listAiGatewaySecrets'
  | 'deleteSecret'
>;

export type OpenGatewayKeyAccountApi = (env: Env, connection: CloudflareConnection) => Promise<GatewayKeyAccountApi>;

/** The connected account's API, with its stored authorization, refreshed once if Cloudflare refuses it. */
export const openGatewayKeyAccountApi: OpenGatewayKeyAccountApi = async (env, connection) => {
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

/**
 * The key each gateway provider's requests use on the account's default gateway: the provider's
 * default key when it has one, and otherwise its first. Providers CloudChef does not offer are left out.
 */
export async function findGatewayKeys(
  api: Pick<GatewayKeyAccountApi, 'listAiGatewayProviderKeys'>,
): Promise<Map<GatewayProviderSlug, AiGatewayProviderKey>> {
  const keys = await api.listAiGatewayProviderKeys(AI_GATEWAY_ID);
  const found = new Map<GatewayProviderSlug, AiGatewayProviderKey>();
  for (const provider of GATEWAY_PROVIDER_SLUGS) {
    const own = keys.filter(({ providerSlug }) => providerSlug === provider);
    const key = own.find(({ isDefault }) => isDefault) ?? own.at(0);
    if (key) {
      found.set(provider, key);
    }
  }
  return found;
}

/**
 * The provider keys the account's runtimes may use now: asked of Cloudflare, so a key removed in the
 * dashboard stops its provider's models at once. Anything unanswerable (no authorization to ask
 * with, Cloudflare unreachable) is none: a provider's model runs only with a key confirmed there.
 */
export async function linkedGatewayKeys(
  env: Env,
  connection: CloudflareConnection,
  open: OpenGatewayKeyAccountApi = openGatewayKeyAccountApi,
): Promise<GatewayKey[]> {
  if (!canManageAiGatewayKeys(connection)) {
    return [];
  }
  try {
    const keys = await findGatewayKeys(await open(env, connection));
    // A key Cloudflare lists without an alias is the provider's default one.
    return [...keys].map(([provider, { alias }]) => ({ provider, alias: alias || 'default' }));
  } catch {
    console.warn('Unable to confirm which provider keys the account has on its AI Gateway.');
    return [];
  }
}
