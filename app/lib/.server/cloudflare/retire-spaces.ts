import { organizationWorkspaceOwners } from '~/lib/cloudflare/data/organizations.server';
import { deleteOrganization } from './account-deletion';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { deleteTeamWorkspace } from './team-workspace';

/** How many leftover spaces one sweep removes, so a run stays short. */
const SPACES_PER_SWEEP = 5;

/**
 * Removes what is left of a space made beside a person's own: nobody is offered one any more, and migration 0081
 * moved their projects into their makers' own accounts. One with no project in it goes, with each of its people's
 * workspaces in the Cloudflare account (their old chats and files there), as deleting it by hand did. A space whose
 * workspaces can't all be deleted now (Cloudflare unreachable, its connection lapsed) is left for the next sweep,
 * so nothing is orphaned in the account. The account's authorization stays while a person's own space builds there.
 */
export async function retireEmptySpaces(
  env: Env,
  deleteWorkspace: typeof deleteTeamWorkspace = deleteTeamWorkspace,
  revokeGrant: (credentialHandle: string) => Promise<boolean> = (credentialHandle) =>
    D1CloudflareCredentialVault.fromEnv(env).revokeOAuthCredential(credentialHandle),
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM organizations
     WHERE personal_user_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM org_projects WHERE org_projects.org_id = organizations.id)
     ORDER BY created_at LIMIT ?`,
  )
    .bind(SPACES_PER_SWEEP)
    .all<{ id: string }>();
  let retired = 0;
  for (const { id } of results) {
    const owners = await organizationWorkspaceOwners(env.DB, id);
    const deleted = await Promise.all(
      owners.map((owner) =>
        owner.reachable
          ? deleteWorkspace(env, id, owner.userId).then(
              () => true,
              () => false,
            )
          : false,
      ),
    );
    if (deleted.includes(false)) {
      console.warn({ event: 'leftover_space_not_retired', workspacesLeft: deleted.filter((done) => !done).length });
      continue;
    }
    await deleteOrganization(env.DB, id, revokeGrant);
    retired += 1;
  }
  return retired;
}

/** `retireEmptySpaces`, for scheduled maintenance: a failure is logged and tried again at the next run. */
export async function retireEmptySpacesBestEffort(env: Env): Promise<void> {
  try {
    await retireEmptySpaces(env);
  } catch {
    console.error('Unable to retire leftover spaces');
  }
}
