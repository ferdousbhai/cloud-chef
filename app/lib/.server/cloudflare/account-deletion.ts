import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import {
  CREDENTIAL_UNREFERENCED,
  deleteUnusedCloudflareAuthorization,
  findCloudflareAuthorization,
  unusedCloudflareAuthorization,
} from './cloudflare-connection-repository';
import { deleteTeamWorkspace } from './team-workspace';

/**
 * Erase operator-held account data and revoke the OAuth grant, unless another space still builds in that
 * account with it. Resources deployed into the user's
 * Cloudflare account remain theirs. Their workspace in each team's account (chats and project files
 * there) is deleted first, best-effort, as removing them from the team would; the names of teams
 * where it couldn't be are returned. Revoking the connection first also makes any in-flight
 * provisioning Workflow fail its connection check before its next provider operation.
 *
 * Resumable: each step finds its work again from what the earlier ones leave behind, so retrying an
 * erasure interrupted at any point finishes it and reports what it finds then. Team workspaces are
 * found from this person's runtime rows, which stay until the last write, not from their memberships.
 * A team only they belong to is deleted with their membership in it, in one write, so no team is ever
 * left behind with nobody in it.
 */
export async function eraseControlPlaneAccount(args: { env: Env; userId: string }): Promise<{
  /** Whether Cloudflare confirmed every revocation erasure asked for; null when it asked for none. */
  cloudflareAuthorizationRevoked: boolean | null;
  /**
   * Each Cloudflare account they built in (their own, or a team's that went with them) whose authorization
   * was kept, not revoked, because others still build there with it.
   */
  cloudflareAuthorizationsKept: KeptCloudflareAuthorization[];
  workspacesLeftIn: string[];
}> {
  const db = args.env.DB;
  // Project resource cleanup runs in the user workspace and needs the Cloudflare authorization
  // revoked here, so it cannot be drained from the control plane: the project GC receipts live in
  // the workspace database, which this erasure deliberately never touches. The settings UI names
  // the ordering this implies — delete projects and let their scheduled cleanup finish first.
  // Organizations nobody else belongs to go with their last member, their Cloudflare grant revoked unless another
  // space still builds in their account.
  // A member's own erasure never touches the grant of an organization others still build in.
  // An erasure that must be refused is refused here, before anything changes. Leaving checks again
  // as it writes: only another admin stepping down in between can still refuse it there, after the
  // workspaces and the teams only they belonged to are gone, and a retry then picks up from there.
  if ((await organizationsNeedingAnotherAdmin(db, args.userId)).length > 0) {
    throw new OrganizationAdminRequiredError('Make someone else an admin of your team first.');
  }
  // While each team's authorization still works: nothing reaches those workspaces once it's revoked.
  const workspacesLeftIn = await deleteTeamWorkspaces(
    args.env,
    args.userId,
    await teamsWithWorkspaces(db, args.userId),
  );
  let vault: D1CloudflareCredentialVault | null | undefined;
  const revokeGrant = (handle: string) => {
    vault = vault === undefined ? safeCredentialVault(args.env) : vault;
    return vault ? vault.revokeOAuthCredential(handle) : Promise.resolve(false);
  };
  const revocations: boolean[] = [];
  // Each team only they belong to goes with them, as deleting it would; a retry finds any left from
  // their membership, which goes with the team.
  const accountsBuiltIn = new Set<string>();
  for (const orgId of await soleMemberOrganizations(db, args.userId)) {
    const teamAccount = await db
      .prepare('SELECT account_id FROM cloudflare_connections WHERE org_id = ?')
      .bind(orgId)
      .first<{ account_id: string }>();
    if (teamAccount) {
      accountsBuiltIn.add(teamAccount.account_id);
    }
    const revoked = await deleteOrganization(db, orgId, revokeGrant);
    if (revoked !== null && revoked !== 'kept') {
      revocations.push(revoked);
    }
  }
  await leaveOrganizations(db, args.userId);
  // Their own connection stays in place until the last write, so a retry finds its grant again. The grant is
  // the account's, shared with any team still building there: it is revoked only once none is.
  const { accountId, credentialHandle } = await revokeConnection(db, args.userId);
  if (credentialHandle) {
    revocations.push(await revokeOrWarn(revokeGrant, credentialHandle));
  }
  if (accountId) {
    accountsBuiltIn.add(accountId);
  }
  const cloudflareAuthorizationsKept: KeptCloudflareAuthorization[] = [];
  for (const account of accountsBuiltIn) {
    const kept = await keptCloudflareAuthorization(db, account, args.userId);
    if (kept) {
      cloudflareAuthorizationsKept.push(kept);
    }
  }
  const cloudflareAuthorizationRevoked = revocations.length > 0 ? revocations.every(Boolean) : null;

  await db.batch([
    db.prepare('DELETE FROM cloudflare_oauth_states WHERE authenticated_user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_oauth_states WHERE linking_user_id = ?').bind(args.userId),
    db
      .prepare('DELETE FROM email_sign_in_tokens WHERE email = (SELECT lower(email) FROM "user" WHERE id = ?)')
      .bind(args.userId),
    // The invites addressed to them, as the export lists them: only to an email CloudChef proved, so
    // erasing an account whose Cloudflare login merely reports an address can't withdraw invites to it.
    db
      .prepare(
        `DELETE FROM organization_invites
         WHERE email = (SELECT email FROM "user" WHERE id = ? AND email_proven_at IS NOT NULL) COLLATE NOCASE`,
      )
      .bind(args.userId),
    db.prepare('DELETE FROM user_computer_runtimes WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_auth_sessions WHERE user_id = ?').bind(args.userId),
    db.prepare('DELETE FROM cloudflare_connections WHERE user_id = ?').bind(args.userId),
    ...(accountId ? [deleteUnusedCloudflareAuthorization(db, accountId)] : []),
    ...(credentialHandle ? [deleteUnusedCredential(db, credentialHandle)] : []),
    db.prepare('DELETE FROM "user" WHERE id = ?').bind(args.userId),
  ]);

  return { cloudflareAuthorizationRevoked, cloudflareAuthorizationsKept, workspacesLeftIn };
}

/**
 * Deletes a team, as its admin deleting it or its last member's erasure does. Its connection is
 * revoked first, so nothing builds there, then CloudChef's grant on the account is revoked with
 * Cloudflare, unless a person's own space or another team still builds in that account with it,
 * then the team's records go: the team, and with it (by their foreign keys) its
 * memberships, invites, usage counts, GitHub installations and connection states, linked projects and
 * who may work on each, production requests and their drafts, its Cloudflare connection and every
 * workspace locator in it, and the account's stored authorization once nothing uses it. Whether
 * Cloudflare confirmed the grant revoked; 'kept' when another space still builds with it, null when the
 * team had none. A connection an earlier, interrupted deletion already revoked is revoked again.
 */
export async function deleteOrganization(
  db: D1Database,
  orgId: string,
  revokeGrant: (credentialHandle: string) => Promise<boolean>,
): Promise<boolean | 'kept' | null> {
  const revoked = await db
    .prepare(
      `UPDATE cloudflare_connections SET status = 'revoked', updated_at = ? WHERE org_id = ?
       RETURNING account_id`,
    )
    .bind(Date.now(), orgId)
    .first<{ account_id: string }>();
  const accountId = revoked?.account_id ?? null;
  const credentialHandle = accountId ? await unusedCloudflareAuthorization(db, accountId) : null;
  const grantRevoked = credentialHandle
    ? await revokeOrWarn(revokeGrant, credentialHandle)
    : accountId && (await findCloudflareAuthorization(db, accountId))
      ? 'kept'
      : null;
  await db.batch([
    db.prepare('DELETE FROM organizations WHERE id = ?').bind(orgId),
    ...(accountId ? [deleteUnusedCloudflareAuthorization(db, accountId)] : []),
    ...(credentialHandle ? [deleteUnusedCredential(db, credentialHandle)] : []),
  ]);
  return grantRevoked;
}

/** Deletes a stored credential once no authorization names it. */
function deleteUnusedCredential(db: D1Database, credentialHandle: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM cloudflare_credentials WHERE handle = ?1 AND ${CREDENTIAL_UNREFERENCED}`)
    .bind(credentialHandle);
}

async function revokeOrWarn(
  revokeGrant: (credentialHandle: string) => Promise<boolean>,
  credentialHandle: string,
): Promise<boolean> {
  return revokeGrant(credentialHandle).catch(() => {
    console.warn('Unable to revoke a Cloudflare grant');
    return false;
  });
}

/**
 * The teams this person has a workspace in, found from their runtime rows rather than their
 * memberships, so a retry after they've already left still finds them. A team whose connection isn't
 * active has a workspace CloudChef can't reach: it's named as left behind, unless only this person
 * belongs to it (it goes with them, in their own team account, its grant revoked by this erasure unless another
 * space still builds there).
 */
async function teamsWithWorkspaces(
  db: D1Database,
  userId: string,
): Promise<{ id: string; name: string; reachable: boolean }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT organizations.id, organizations.name,
         connections.status = 'active' AS reachable,
         NOT EXISTS (
           SELECT 1 FROM organization_members AS other WHERE other.org_id = organizations.id AND other.user_id <> ?1
         ) AS sole
       FROM user_computer_runtimes AS runtimes
       JOIN cloudflare_connections AS connections ON connections.id = runtimes.connection_id
       JOIN organizations ON organizations.id = connections.org_id
       WHERE runtimes.user_id = ?1
       ORDER BY organizations.name`,
    )
    .bind(userId)
    .all<{ id: string; name: string; reachable: number; sole: number }>();
  return results
    .filter((team) => team.reachable === 1 || team.sole === 0)
    .map((team) => ({ id: team.id, name: team.name, reachable: team.reachable === 1 }));
}

/** Deletes this person's workspace in each of those teams, one at a time; the names of the teams where it couldn't be. */
async function deleteTeamWorkspaces(
  env: Env,
  userId: string,
  teams: { id: string; name: string; reachable: boolean }[],
): Promise<string[]> {
  const left: string[] = [];
  for (const team of teams) {
    if (!team.reachable) {
      left.push(team.name);
      continue;
    }
    try {
      await deleteTeamWorkspace(env, team.id, userId);
    } catch {
      console.warn('Unable to delete a team workspace during account erasure');
      left.push(team.name);
    }
  }
  return left;
}

/**
 * A membership (`mine`) of the person bound as `?1` that is the sole active admin of an organization
 * others still belong to.
 */
const SOLE_ACTIVE_ADMIN_WITH_OTHERS = `mine.user_id = ?1 AND mine.role = 'admin' AND mine.paused_at IS NULL
  AND EXISTS (SELECT 1 FROM organization_members AS other WHERE other.org_id = mine.org_id AND other.user_id <> ?1)
  AND NOT EXISTS (
    SELECT 1 FROM organization_members AS other
    WHERE other.org_id = mine.org_id AND other.user_id <> ?1 AND other.role = 'admin' AND other.paused_at IS NULL
  )`;

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
       WHERE ${SOLE_ACTIVE_ADMIN_WITH_OTHERS}
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
async function leaveOrganizations(db: D1Database, userId: string): Promise<void> {
  // The condition doesn't depend on the row being deleted, so SQLite settles it once, before deleting.
  await db
    .prepare(
      `DELETE FROM organization_members
       WHERE user_id = ?1 AND NOT EXISTS (
         SELECT 1 FROM organization_members AS mine WHERE ${SOLE_ACTIVE_ADMIN_WITH_OTHERS}
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

/**
 * Revokes their own connection: the account it builds in, and the credential of that account's
 * authorization when no other space still builds there with it, for its grant to be revoked with Cloudflare.
 */
async function revokeConnection(
  db: D1Database,
  userId: string,
): Promise<{ accountId: string | null; credentialHandle: string | null }> {
  const revoked = await db
    .prepare(
      `UPDATE cloudflare_connections SET status = 'revoked', updated_at = ?
       WHERE user_id = ? AND status = 'active'
       RETURNING account_id`,
    )
    .bind(Date.now(), userId)
    .first<{ account_id: string }>();
  const connection =
    revoked ??
    (await db
      .prepare('SELECT account_id FROM cloudflare_connections WHERE user_id = ?')
      .bind(userId)
      .first<{ account_id: string }>());
  const accountId = connection?.account_id ?? null;
  return { accountId, credentialHandle: accountId ? await unusedCloudflareAuthorization(db, accountId) : null };
}

/**
 * Who still builds in a Cloudflare account with its authorization, which was therefore kept: the teams by
 * name, and whether someone else's own space does, never saying whose.
 */
type KeptCloudflareAuthorization = { teams: string[]; someoneElsesOwnSpace: boolean };

/** Who still builds in `accountId` with its authorization other than `userId`; null when no one does. */
async function keptCloudflareAuthorization(
  db: D1Database,
  accountId: string,
  userId: string,
): Promise<KeptCloudflareAuthorization | null> {
  const { results } = await db
    .prepare(
      `SELECT organizations.name AS team FROM cloudflare_connections AS connections
       JOIN cloudflare_authorizations AS authorizations ON authorizations.account_id = connections.account_id
       LEFT JOIN organizations ON organizations.id = connections.org_id
       WHERE connections.account_id = ?1 AND connections.status = 'active' AND connections.user_id IS NOT ?2
       ORDER BY organizations.name`,
    )
    .bind(accountId, userId)
    .all<{ team: string | null }>();
  if (results.length === 0) {
    return null;
  }
  return {
    teams: results.flatMap((row) => (row.team === null ? [] : [row.team])),
    someoneElsesOwnSpace: results.some((row) => row.team === null),
  };
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
