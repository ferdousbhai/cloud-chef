import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';

/**
 * Who may build with a space's Cloudflare connection: the space's members who aren't paused. Every control-plane
 * path that hands out a workspace or a Cloudflare token asks this one question, so pausing or removing a member
 * takes effect at their very next request.
 */
export type OrganizationRole = 'admin' | 'member';

export type Membership = {
  orgId: string;
  orgName: string;
  role: OrganizationRole;
  pausedAt: number | null;
  /** Whether they start new apps here, which only an admin does: anyone else works on the projects they're given. */
  draftsAllowed: boolean;
};

/**
 * A space a person can build in, as the workspace switcher lists them: the one made for them, one they made, or
 * one they were invited into. Every one has the same shape, however many people are in it.
 */
export type WorkspaceContextOption = {
  connectionId: string;
  accountName: string | null;
  orgId: string;
  orgName: string;
  role: OrganizationRole;
  draftsAllowed: boolean;
  /** Only this person is in it: to them it is their own account, not a team, until someone else joins. */
  solo: boolean;
  /** The space made for this person, on a Cloudflare account of their own: the one signing in with it connects. */
  personal: boolean;
};

export async function canUseConnection(
  db: D1Database,
  userId: string,
  connection: Pick<CloudflareConnection, 'orgId'>,
): Promise<boolean> {
  return (await findMembership(db, connection.orgId, userId))?.pausedAt === null;
}

export async function findMembership(db: D1Database, orgId: string, userId: string): Promise<Membership | null> {
  const row = await db
    .prepare(
      `SELECT members.org_id, organizations.name AS org_name, members.role, members.paused_at
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       WHERE members.org_id = ? AND members.user_id = ?`,
    )
    .bind(orgId, userId)
    .first<MembershipRow>();
  return row ? membershipFromRow(row) : null;
}
/**
 * Every space this person can build in right now, whose connection is active and where they aren't paused: the
 * one made for them first, then the rest by name.
 */
export async function listWorkspaceContexts(db: D1Database, userId: string): Promise<WorkspaceContextOption[]> {
  const { results } = await db
    .prepare(
      `SELECT connections.id AS connection_id, connections.account_name, organizations.id AS org_id,
              organizations.name AS org_name, members.role,
              (SELECT COUNT(*) FROM organization_members AS people WHERE people.org_id = organizations.id) = 1 AS solo,
              organizations.personal_user_id IS ?1 AS personal
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       JOIN cloudflare_connections AS connections
         ON connections.org_id = members.org_id AND connections.status = 'active'
       WHERE members.user_id = ?1 AND members.paused_at IS NULL
       ORDER BY organizations.personal_user_id IS ?1 DESC, org_name, org_id`,
    )
    .bind(userId)
    .all<ContextRow>();
  return results.map((row) => ({
    connectionId: row.connection_id,
    accountName: row.account_name,
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
    draftsAllowed: draftsAllowed(row.role),
    solo: row.solo === 1,
    personal: row.personal === 1,
  }));
}

/**
 * An admin who isn't paused: who may run the space (its people, invites and projects) and act on its Cloudflare
 * account itself (connect it, change it directly, approve changes to it, choose its models).
 */
export function isActiveAdmin(membership: Pick<Membership, 'role' | 'pausedAt'> | null): boolean {
  return membership?.role === 'admin' && membership.pausedAt === null;
}

/** Whether someone starts new apps in a space: only its admins, whose account it is. */
export function draftsAllowed(role: OrganizationRole): boolean {
  return role === 'admin';
}

/** The role is one of the two the table's CHECK allows. */
type MembershipRow = {
  org_id: string;
  org_name: string;
  role: OrganizationRole;
  paused_at: number | null;
};

type ContextRow = {
  connection_id: string;
  account_name: string | null;
  org_id: string;
  org_name: string;
  role: OrganizationRole;
  solo: number;
  personal: number;
};

function membershipFromRow(row: MembershipRow): Membership {
  return {
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
    pausedAt: row.paused_at,
    draftsAllowed: draftsAllowed(row.role),
  };
}
