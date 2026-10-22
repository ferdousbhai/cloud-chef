import type { CloudflareConnection } from './cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { UserCloudflareAccountApi } from './user-account-api';

/** A connection's account API, with its stored authorization, refreshed once if Cloudflare refuses it. */
export async function openConnectionAccountApi(
  env: Env,
  connection: Pick<CloudflareConnection, 'accountId' | 'credentialHandle'>,
): Promise<UserCloudflareAccountApi> {
  const handle = connection.credentialHandle;
  if (!handle) {
    throw new Error('The Cloudflare connection has no authorization.');
  }
  const vault = D1CloudflareCredentialVault.fromEnv(env);
  return new UserCloudflareAccountApi(connection.accountId, await vault.resolve(handle), fetch, () =>
    vault.resolve(handle, { forceRefresh: true }),
  );
}
