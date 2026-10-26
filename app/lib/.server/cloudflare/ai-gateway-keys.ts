import type { CloudflareConnection } from './cloudflare-connection-repository';
import { missingCoreOAuthScopes } from './cloudflare-oauth-scope-manifest';
import { openConnectionAccountApi } from './connection-account-api';
import type { AiGatewayProviderKey, UserCloudflareAccountApi } from './user-account-api';
import {
  GATEWAY_KEY_ALIAS,
  GATEWAY_PROVIDER_SLUGS,
  type GatewayKey,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';

/**
 * A gateway provider's models run in a connected account only with that account's own key for the
 * provider, stored on its `default` AI Gateway as a provider key (BYOK) under the alias `default`
 * (`GATEWAY_KEY_ALIAS`) in the account's Secrets Store, whoever added it: an admin in Cloudflare's
 * dashboard, or CloudChef from Settings. CloudChef reads which keys are there from the account itself
 * each time, links and unlinks keys with the connection's Cloudflare authorization, and never stores,
 * reads, or returns a key itself.
 */
export const AI_GATEWAY_ID = 'default';

/**
 * The Secrets Store secret Cloudflare keeps a provider's `default` key in: AI Gateway names a provider
 * key's secret `{gateway}_{provider}_{alias}`, and refuses a new key while that name is taken, so
 * relinking and unlinking delete it with the key.
 */
export function defaultKeySecretName(provider: GatewayProviderSlug): string {
  return `${AI_GATEWAY_ID}_${provider}_${GATEWAY_KEY_ALIAS}`;
}

/** Whether a listed key is under the alias CloudChef's requests use; Cloudflare may list it with none. */
export function isDefaultAlias(alias: string): boolean {
  return alias === '' || alias === GATEWAY_KEY_ALIAS;
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
export const openGatewayKeyAccountApi: OpenGatewayKeyAccountApi = openConnectionAccountApi;

/**
 * The key each gateway provider's requests use on the account's default gateway: the provider's key aliased
 * `default`. Providers CloudChef does not offer, and keys under any other alias, are left out.
 */
export async function findGatewayKeys(
  api: Pick<GatewayKeyAccountApi, 'listAiGatewayProviderKeys'>,
): Promise<Map<GatewayProviderSlug, AiGatewayProviderKey>> {
  const keys = await api.listAiGatewayProviderKeys(AI_GATEWAY_ID);
  const found = new Map<GatewayProviderSlug, AiGatewayProviderKey>();
  for (const provider of GATEWAY_PROVIDER_SLUGS) {
    const key = keys.find(({ providerSlug, alias }) => providerSlug === provider && isDefaultAlias(alias));
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
  if (missingCoreOAuthScopes(connection.grantedOAuthScopes).length > 0) {
    return [];
  }
  try {
    const keys = await findGatewayKeys(await open(env, connection));
    return [...keys].map(([provider, { id, modifiedAt }]) => ({
      provider,
      revision: `${id}@${modifiedAt ?? ''}`.slice(0, 256),
    }));
  } catch {
    console.warn('Unable to confirm which provider keys the account has on its AI Gateway.');
    return [];
  }
}
