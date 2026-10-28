import { ADOPTED_APP_MESSAGE } from '~/lib/common/adopted-app';
import type { RuntimeConnectionIdentity } from './cloudflare-api-runtime-identity';
import { appAdoption } from './linked-project-client';
import { confirmUserWorkspaceAccess, type ConfirmUserWorkspaceAccess } from './user-workspace-cloudflare-credential';

/**
 * Why the person may not use their own app's repository `repo` through git now, or null while they may: they must
 * still be able to use their workspace, and in a team's account the app must not have become one of the team's
 * projects (an admin approved it as a draft), whose repository only the project, with its roles, changes or reads.
 */
export async function appGitRefusal(
  env: Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET' | 'CLOUDCHEF_SHARED_ACCOUNT'>,
  identity: RuntimeConnectionIdentity,
  repo: string,
  confirm: ConfirmUserWorkspaceAccess = confirmUserWorkspaceAccess,
): Promise<string | null> {
  if (!(await confirm(env, identity))) {
    return 'You no longer have access to this workspace.';
  }
  return env.CLOUDCHEF_SHARED_ACCOUNT === '1' && (await appAdoption(env, identity, repo)) ? ADOPTED_APP_MESSAGE : null;
}
