import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';

/**
 * Who may build with a Cloudflare connection: its owner for a person's own connection, and an
 * organization's active, unpaused members for the organization's. Every control-plane path that hands
 * out a workspace or a Cloudflare token asks this one question, so pausing or removing a member takes
 * effect at their very next request.
 */
export type OrganizationRole = 'admin' | 'member';

export type Membership = {
  orgId: string;
  orgName: string;
  role: OrganizationRole;
  pausedAt: number | null;
  /** Whether they may build new apps of their own here, or only work on GitHub projects they're given. */
  draftsAllowed: boolean;
};

/** A Cloudflare account a person can build in, as the workspace switcher lists them. */
export type WorkspaceContextOption =
  | { kind: 'personal'; connectionId: string; accountName: string | null }
  | {
      kind: 'organization';
      connectionId: string;
      accountName: string | null;
      orgId: string;
      orgName: string;
      role: OrganizationRole;
      draftsAllowed: boolean;
    };

export async function canUseConnection(
  db: D1Database,
  userId: string,
  connection: Pick<CloudflareConnection, 'userId' | 'orgId'>,
): Promise<boolean> {
  if (connection.userId !== null) {
    return connection.userId === userId;
  }
  if (connection.orgId === null) {
    return false;
  }
  return (await findMembership(db, connection.orgId, userId))?.pausedAt === null;
}

export async function findMembership(db: D1Database, orgId: string, userId: string): Promise<Membership | null> {
  const row = await db
    .prepare(
      `SELECT members.org_id, organizations.name AS org_name, members.role, members.paused_at,
              members.drafts_allowed
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       WHERE members.org_id = ? AND members.user_id = ?`,
    )
    .bind(orgId, userId)
    .first<MembershipRow>();
  return row ? membershipFromRow(row) : null;
}
/**
 * Every Cloudflare account this person can build in right now: their own active connection first,
 * then each organization they are an unpaused member of whose connection is active.
 */
export async function listWorkspaceContexts(db: D1Database, userId: string): Promise<WorkspaceContextOption[]> {
  const { results } = await db
    .prepare(
      `SELECT connections.id AS connection_id, connections.account_name, NULL AS org_id, NULL AS org_name,
              NULL AS role, 1 AS drafts_allowed, 0 AS sort_group
       FROM cloudflare_connections AS connections
       WHERE connections.user_id = ?1 AND connections.status = 'active'
       UNION ALL
       SELECT connections.id, connections.account_name, organizations.id, organizations.name, members.role,
              members.drafts_allowed, 1
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       JOIN cloudflare_connections AS connections
         ON connections.org_id = members.org_id AND connections.status = 'active'
       WHERE members.user_id = ?1 AND members.paused_at IS NULL
       ORDER BY sort_group, org_name, org_id`,
    )
    .bind(userId)
    .all<ContextRow>();
  return results.map((row) =>
    row.org_id === null
      ? { kind: 'personal', connectionId: row.connection_id, accountName: row.account_name }
      : {
          kind: 'organization',
          connectionId: row.connection_id,
          accountName: row.account_name,
          orgId: row.org_id,
          orgName: row.org_name,
          role: row.role,
          draftsAllowed: draftsAllowed(row.role, row.drafts_allowed),
        },
  );
}

/** An admin who isn't paused: who may run the team. */
export function isActiveAdmin(membership: Pick<Membership, 'role' | 'pausedAt'> | null): boolean {
  return membership?.role === 'admin' && membership.pausedAt === null;
}

/** Whether a member builds new apps of their own, from its stored flag: an admin always may. */
export function draftsAllowed(role: OrganizationRole, stored: number): boolean {
  return role === 'admin' || stored === 1;
}

/** The role is one of the two the table's CHECK allows. */
type MembershipRow = {
  org_id: string;
  org_name: string;
  role: OrganizationRole;
  paused_at: number | null;
  drafts_allowed: number;
};

type ContextRow = { connection_id: string; account_name: string | null; drafts_allowed: number } & (
  { org_id: null; org_name: null; role: null } | { org_id: string; org_name: string; role: OrganizationRole }
);

function membershipFromRow(row: MembershipRow): Membership {
  return {
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
    pausedAt: row.paused_at,
    draftsAllowed: draftsAllowed(row.role, row.drafts_allowed),
  };
}
