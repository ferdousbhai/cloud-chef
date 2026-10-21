import { findCloudflareConnectionForOrganization } from './cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { UserCloudflareAccountApi } from './user-account-api';
import { workspaceRuntimeNames } from '~/workflows/user-workspace-runtime-provisioning';

/**
 * Deletes a person's workspace (its Worker, container and database: their chats and project files)
 * from a team's Cloudflare account, with the team's authorization. Used when they are removed or
 * leave, when the team is deleted, and when they erase their CloudChef account. Throws when it
 * can't: the caller says the workspace is left behind.
 */
export async function deleteTeamWorkspace(env: Env, orgId: string, userId: string): Promise<void> {
  const connection = await findCloudflareConnectionForOrganization(env.DB, orgId);
  if (connection?.status !== 'active' || !connection.credentialHandle) {
    throw new Error('The team has no active Cloudflare connection.');
  }
  const accessToken = await D1CloudflareCredentialVault.fromEnv(env).resolve(connection.credentialHandle);
  await new UserCloudflareAccountApi(connection.accountId, accessToken).deleteWorkspaceRuntime(
    await workspaceRuntimeNames(connection, userId),
  );
}

export type DeleteTeamWorkspace = typeof deleteTeamWorkspace;
