import { findCloudflareConnectionForOrganization } from './cloudflare-connection-repository';
import { openConnectionAccountApi } from './connection-account-api';
import { findUserWorkspaceRuntime } from './user-workspace-runtime-repository';
import { deriveUserWorkspaceRuntimeSecret } from './user-workspace-runtime-secret';
import { CANONICAL_ORIGIN } from '~/lib/.server/public-origin';
import { mintRuntimeCapability } from '~/lib/cloudflare/runtime-capability';
import { workspaceRuntimeNames } from '~/workflows/user-workspace-runtime-provisioning';

/**
 * Deletes a person's workspace (its Worker, its workspace and project builder containers, and its database: their chats and project files)
 * from a team's Cloudflare account, with the team's authorization. Used when they are removed or
 * leave, when the team is deleted, and when they erase their CloudChef account. Throws when it
 * can't: the caller says the workspace is left behind.
 */
export async function deleteTeamWorkspace(env: Env, orgId: string, userId: string): Promise<void> {
  const connection = await findCloudflareConnectionForOrganization(env.DB, orgId);
  if (connection?.status !== 'active' || !connection.credentialHandle) {
    throw new Error('The team has no active Cloudflare connection.');
  }
  await forgetSavedBranches(env, connection, userId).catch(() =>
    console.warn({ event: 'saved_branches_not_forgotten', orgId }),
  );
  const accountApi = await openConnectionAccountApi(env, connection);
  await accountApi.deleteWorkspaceRuntime(await workspaceRuntimeNames(connection, userId));
}

/**
 * Asks the person's runtime, while it still exists, to delete the branches their workspaces saved in the team's
 * repositories: those outlive the runtime, and only it knows which are theirs. Best effort.
 */
async function forgetSavedBranches(
  env: Env,
  connection: { id: string; accountId: string; generation: number },
  userId: string,
): Promise<void> {
  const runtime = await findUserWorkspaceRuntime(env.DB, userId, connection.id);
  if (!runtime || !env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY) {
    return;
  }
  const secret = await deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64: env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY,
    userId,
    accountId: connection.accountId,
    connectionGeneration: connection.generation,
    organizationConnectionId: connection.id,
  });
  const { token } = await mintRuntimeCapability({ secret, subject: userId, origin: CANONICAL_ORIGIN });
  const answer = await fetch(new URL('/v1/workspaces/forget-saved-branches', runtime.endpoint), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin: CANONICAL_ORIGIN },
    signal: AbortSignal.timeout(60_000),
  });
  await answer.body?.cancel();
}
