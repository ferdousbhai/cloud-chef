import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { deleteTeamWorkspace, type DeleteTeamWorkspace } from './team-workspace';

/**
 * Erase operator-held account data and revoke the OAuth grant. Resources deployed into the user's
 * Cloudflare account remain theirs. Their workspace in each team's account (chats and project files
 * there) is deleted first, best-effort, as removing them from the team would; the names of teams
 * where it couldn't be are returned. Revoking the connection first also makes any in-flight
 * provisioning Workflow fail its connection check before its next provider operation.
 */
export async function eraseControlPlaneAccount(args: {
  env: Env;
  userId: string;
  vault?: D1CloudflareCredentialVault;
  deleteWorkspace?: DeleteTeamWorkspace;
}): Promise<{ cloudflareAuthorizationRevoked: boolean; workspacesLeftIn: string[] }> {
  const db = args.env.DB;
  // Project resource cleanup runs in the user workspace and needs the Cloudflare authorization
  // revoked here, so it cannot be drained from the control plane: the project GC receipts live in
  // the workspace database, which this erasure deliberately never touches. The settings UI names
  // the ordering this implies — delete projects and let their scheduled cleanup finish first.
  // Organizations nobody else belongs to go with their last member, their Cloudflare grant revoked.
  // A member's own erasure never touches the grant of an organization others still build in.
  // Nothing is written until every check passes: an erasure that must be refused changes nothing.
  if ((await organizationsNeedingAnotherAdmin(db, args.userId)).length > 0) {
    throw new OrganizationAdminRequiredError('Make someone else an admin of your team first.');
  }
  // While each team's authorization still works: nothing reaches those workspaces once they're gone.
  const workspacesLeftIn = await deleteTeamWorkspaces(
    args.env,
    args.userId,
    args.deleteWorkspace ?? deleteTeamWorkspace,
  );
  const soleOrgIds = await soleMemberOrganizations(db, args.userId);
  await leaveOrganizations(db, args.userId);
  const soleOrganizations = await revokeSoleMemberOrganizations(db, args.userId, soleOrgIds);
  const credentialHandle = await revokeConnection(db, args.userId);
  const handles = [credentialHandle, ...soleOrganizations.handles].filter((handle) => handle !== null);
  const vault = handles.length > 0 ? (args.vault ?? safeCredentialVault(args.env)) : null;
  const revocations = await Promise.all(
    handles.map((handle) =>
      vault
        ? vault.revokeOAuthCredential(handle).catch(() => {
            console.warn('Unable to revoke the Cloudflare grant during account erasure');
            return false;
          })
        : false,
    ),
  );
  const cloudflareAuthorizationRevoked = handles.length > 0 && revocations.every(Boolean);

  await db.batch([
    db.prepare('DELETE FROM cloudflare_oauth_states WHERE authenticated_user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_oauth_states WHERE linking_user_id = ?').bind(args.userId),
    db
      .prepare('DELETE FROM email_sign_in_tokens WHERE email = (SELECT lower(email) FROM "user" WHERE id = ?)')
      .bind(args.userId),
    db.prepare('DELETE FROM user_computer_runtimes WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_auth_sessions WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_connections WHERE user_id = ?').bind(args.userId),
    db
      .prepare(
        `DELETE FROM cloudflare_credentials
         WHERE handle = ? AND NOT EXISTS (
           SELECT 1 FROM cloudflare_connections WHERE credential_handle = ?
         )`,
      )
      .bind(credentialHandle, credentialHandle),
    // Still only theirs at this moment: someone who joined meanwhile keeps the organization.
    ...soleOrganizations.orgIds.map((orgId) =>
      db
        .prepare(
          `DELETE FROM organizations WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM organization_members WHERE org_id = ?1 AND user_id <> ?2)`,
        )
        .bind(orgId, args.userId),
    ),
    ...soleOrganizations.handles.map((handle) =>
      db
        .prepare(
          `DELETE FROM cloudflare_credentials
           WHERE handle = ?1 AND NOT EXISTS (SELECT 1 FROM cloudflare_connections WHERE credential_handle = ?1)`,
        )
        .bind(handle),
    ),
    db.prepare('DELETE FROM "user" WHERE id = ?').bind(args.userId),
  ]);

  return { cloudflareAuthorizationRevoked, workspacesLeftIn };
}

/**
 * Deletes this person's workspace in every team account they build in, one at a time; the names of
 * the teams where it couldn't be. A team without an active connection has no workspace CloudChef can
 * reach, so it isn't tried.
 */
async function deleteTeamWorkspaces(env: Env, userId: string, deleteWorkspace: DeleteTeamWorkspace): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT organizations.id, organizations.name
     FROM organization_members AS mine
     JOIN organizations ON organizations.id = mine.org_id
     JOIN cloudflare_connections AS connections ON connections.org_id = mine.org_id AND connections.status = 'active'
     JOIN user_computer_runtimes AS runtimes ON runtimes.connection_id = connections.id AND runtimes.user_id = mine.user_id
     WHERE mine.user_id = ?
     ORDER BY organizations.name`,
  )
    .bind(userId)
    .all<{ id: string; name: string }>();
  const left: string[] = [];
  for (const team of results) {
    try {
      await deleteWorkspace(env, team.id, userId);
    } catch {
      console.warn('Unable to delete a team workspace during account erasure');
      left.push(team.name);
    }
  }
  return left;
}

/**
 * Organizations where this person is the only one left that would be blocked from their own admin
 * pages: the names of those they are the sole active admin of while others still belong. Erasure is
 * refused until they appoint another admin.
 */
export async function organizationsNeedingAnotherAdmin(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT organizations.name
       FROM organization_members AS mine
       JOIN organizations ON organizations.id = mine.org_id
       WHERE mine.user_id = ?1 AND mine.role = 'admin'
         AND EXISTS (SELECT 1 FROM organization_members AS other WHERE other.org_id = mine.org_id AND other.user_id <> ?1)
         AND NOT EXISTS (
           SELECT 1 FROM organization_members AS other
           WHERE other.org_id = mine.org_id AND other.user_id <> ?1 AND other.role = 'admin' AND other.paused_at IS NULL
         )
       ORDER BY organizations.name`,
    )
    .bind(userId)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

/** Raised when erasing would leave an organization others belong to without an active admin. */
export class OrganizationAdminRequiredError extends Error {}

/**
 * Leaves every organization, all or none, in one write that keeps each one's last active admin: it
 * deletes nothing while any of them would be left with others in it and no active admin. Two sole
 * admins erasing their accounts at once can't both leave; the one left over stops with every
 * membership still in place.
 */
export async function leaveOrganizations(db: D1Database, userId: string): Promise<void> {
  // The condition doesn't depend on the row being deleted, so SQLite settles it once, before deleting.
  await db
    .prepare(
      `DELETE FROM organization_members
       WHERE user_id = ?1 AND NOT EXISTS (
         SELECT 1 FROM organization_members AS mine
         WHERE mine.user_id = ?1 AND mine.role = 'admin' AND mine.paused_at IS NULL
           AND EXISTS (
             SELECT 1 FROM organization_members AS other WHERE other.org_id = mine.org_id AND other.user_id <> ?1
           )
           AND NOT EXISTS (
             SELECT 1 FROM organization_members AS other
             WHERE other.org_id = mine.org_id AND other.user_id <> ?1
               AND other.role = 'admin' AND other.paused_at IS NULL
           )
       )`,
    )
    .bind(userId)
    .run();
  const remaining = await db
    .prepare('SELECT COUNT(*) AS remaining FROM organization_members WHERE user_id = ?')
    .bind(userId)
    .first<{ remaining: number }>();
  if ((remaining?.remaining ?? 0) > 0) {
    // The write above deleted all of them or none: here, none.
    throw new OrganizationAdminRequiredError('Make someone else an admin of your team first.');
  }
}

/** The organizations this person is the only member of, which go with them. */
async function soleMemberOrganizations(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT mine.org_id FROM organization_members AS mine
       WHERE mine.user_id = ?1
         AND NOT EXISTS (SELECT 1 FROM organization_members AS other WHERE other.org_id = mine.org_id AND other.user_id <> ?1)`,
    )
    .bind(userId)
    .all<{ org_id: string }>();
  return results.map((row) => row.org_id);
}

/** Revokes those organizations' connections, while still nobody else belongs to them. */
async function revokeSoleMemberOrganizations(
  db: D1Database,
  userId: string,
  orgIds: string[],
): Promise<{ orgIds: string[]; handles: string[] }> {
  const handles: string[] = [];
  for (const orgId of orgIds) {
    const revoked = await db
      .prepare(
        `UPDATE cloudflare_connections SET status = 'revoked', updated_at = ?1
         WHERE org_id = ?2 AND NOT EXISTS (SELECT 1 FROM organization_members WHERE org_id = ?2 AND user_id <> ?3)
         RETURNING credential_handle`,
      )
      .bind(Date.now(), orgId, userId)
      .first<{ credential_handle: string | null }>();
    if (revoked?.credential_handle) {
      handles.push(revoked.credential_handle);
    }
  }
  return { orgIds, handles };
}

async function revokeConnection(db: D1Database, userId: string): Promise<string | null> {
  const revoked = await db
    .prepare(
      `UPDATE cloudflare_connections SET status = 'revoked', updated_at = ?
       WHERE user_id = ? AND status = 'active'
       RETURNING credential_handle`,
    )
    .bind(Date.now(), userId)
    .first<{ credential_handle: string | null }>();
  const connection =
    revoked ??
    (await db
      .prepare('SELECT credential_handle FROM cloudflare_connections WHERE user_id = ?')
      .bind(userId)
      .first<{ credential_handle: string | null }>());
  return connection?.credential_handle ?? null;
}

function safeCredentialVault(env: Env): D1CloudflareCredentialVault | null {
  try {
    return D1CloudflareCredentialVault.fromEnv(env);
  } catch (error) {
    console.warn(
      'Cloudflare credential configuration is unavailable, so the grant must be revoked from the ' +
        'Cloudflare dashboard',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
