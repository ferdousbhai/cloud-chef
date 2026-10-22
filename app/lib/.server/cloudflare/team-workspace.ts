import { findCloudflareConnectionForOrganization } from './cloudflare-connection-repository';
import { openConnectionAccountApi } from './connection-account-api';
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
  const accountApi = await openConnectionAccountApi(env, connection);
  await accountApi.deleteWorkspaceRuntime(await workspaceRuntimeNames(connection, userId));
}
