import { spaceNameFor } from '~/lib/workspace-name';
import {
  draftsAllowed,
  findMembership,
  isActiveAdmin,
  type Membership,
  type OrganizationRole,
} from './organization-access.server';

export class OrganizationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410,
    /** `sole_member`: leaving would leave the space empty, so it is deleted instead. */
    readonly code?: 'sole_member',
  ) {
    super(message);
  }
}

type OrganizationMember = {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  joinedAt: number;
  pausedAt: number | null;
  /** This calendar month's Workers AI use in the organization's account (UTC). */
  usage: { turns: number; inputTokens: number; outputTokens: number };
};

type OrganizationSummary = Membership & {
  /** The person it was made for (their own Cloudflare account), who stays its admin. */
  ownerUserId: string | null;
  /** The space's Cloudflare account, once an admin has connected it. */
  connection: { accountName: string | null; active: boolean } | null;
  /** Only an admin sees who else is in the space. */
  members: OrganizationMember[] | null;
};

/** The space made for `userId`: the one their own Cloudflare sign-in connects. Null when they have none. */
export async function findPersonalSpace(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM organizations WHERE personal_user_id = ?')
    .bind(userId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * The space made for `userId`, made now when they have none: named for them, with them as its admin and nobody
 * else in it, and no Cloudflare connection yet. Two requests at once make one (`personal_user_id` is unique).
 */
export async function ensurePersonalSpace(db: D1Database, userId: string): Promise<string> {
  const existing = await findPersonalSpace(db, userId);
  if (existing) {
    return existing;
  }
  const orgId = crypto.randomUUID();
  const now = Date.now();
  const person = await db.prepare('SELECT name FROM "user" WHERE id = ?').bind(userId).first<{ name: string }>();
  await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, created_by, created_at, updated_at, personal_user_id)
         VALUES (?1, ?2, ?3, ?4, ?4, ?3) ON CONFLICT(personal_user_id) WHERE personal_user_id IS NOT NULL DO NOTHING`,
      )
      .bind(orgId, spaceNameFor(person?.name ?? ''), userId, now),
    db
      .prepare(
        `INSERT INTO organization_members (org_id, user_id, role, joined_at)
         SELECT ?1, ?2, 'admin', ?3 WHERE EXISTS (SELECT 1 FROM organizations WHERE id = ?1)`,
      )
      .bind(orgId, userId, now),
  ]);
  const made = await findPersonalSpace(db, userId);
  if (!made) {
    throw new Error('The account could not be made.');
  }
  return made;
}

/** An admin renames their team. */
export async function renameOrganization(
  db: D1Database,
  args: { orgId: string; actorId: string; name: string },
): Promise<void> {
  await requireAdmin(db, args.orgId, args.actorId);
  await db
    .prepare('UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?')
    .bind(args.name, Date.now(), args.orgId)
    .run();
}

/**
 * Who may delete a team: an active admin, or its only member (leaving would leave nobody). Changes
 * nothing.
 */
export async function prepareOrganizationDeletion(
  db: D1Database,
  args: { orgId: string; actorId: string },
): Promise<void> {
  const membership = await findMembership(db, args.orgId, args.actorId);
  if (!membership) {
    throw new OrganizationError('That account no longer exists, or you are not in it.', 404);
  }
  const { results } = await db
    .prepare('SELECT user_id FROM organization_members WHERE org_id = ? ORDER BY joined_at')
    .bind(args.orgId)
    .all<{ user_id: string }>();
  const memberIds = results.map((row) => row.user_id);
  const soleMember = memberIds.length === 1 && memberIds[0] === args.actorId;
  if (!soleMember && !isActiveAdmin(membership)) {
    throw new OrganizationError("Only an account's admin can delete it.", 403);
  }
}

/**
 * Who has a workspace in the team's Cloudflare account, whatever the state of the team's connection,
 * and whether CloudChef can reach it: only while the connection is active. One it can't reach is a
 * workspace left behind there, not one that isn't.
 */
export async function organizationWorkspaceOwners(
  db: D1Database,
  orgId: string,
): Promise<{ userId: string; reachable: boolean }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT runtimes.user_id, connections.status = 'active' AS reachable
       FROM cloudflare_connections AS connections
       JOIN user_computer_runtimes AS runtimes ON runtimes.connection_id = connections.id
       WHERE connections.org_id = ?
       ORDER BY runtimes.user_id`,
    )
    .bind(orgId)
    .all<{ user_id: string; reachable: number }>();
  return results.map((row) => ({ userId: row.user_id, reachable: row.reachable === 1 }));
}

/** Whoever runs the team `orgId`: one of its admins who isn't paused. Throws for anyone else. */
export async function requireAdmin(db: D1Database, orgId: string, userId: string): Promise<Membership> {
  const membership = await findMembership(db, orgId, userId);
  if (!membership || !isActiveAdmin(membership)) {
    throw new OrganizationError("Only an account's admin can do that.", 403);
  }
  return membership;
}

/** The spaces this person belongs to, with the people in each where they are an admin. */
export async function listOrganizations(db: D1Database, userId: string): Promise<OrganizationSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT members.org_id, organizations.name AS org_name, members.role, members.paused_at,
              connections.account_name, connections.status AS connection_status,
              organizations.personal_user_id AS owner_user_id
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       LEFT JOIN cloudflare_connections AS connections ON connections.org_id = members.org_id
       WHERE members.user_id = ?1
       -- The account made for them first, then the rest by name.
       ORDER BY owner_user_id IS ?1 DESC, organizations.name, organizations.id`,
    )
    .bind(userId)
    .all<{
      org_id: string;
      org_name: string;
      role: OrganizationRole;
      paused_at: number | null;
      account_name: string | null;
      connection_status: string | null;
      owner_user_id: string | null;
    }>();
  const now = Date.now();
  return Promise.all(
    results.map(async (row) => {
      const admin = isActiveAdmin({ role: row.role, pausedAt: row.paused_at });
      return {
        orgId: row.org_id,
        orgName: row.org_name,
        role: row.role,
        pausedAt: row.paused_at,
        draftsAllowed: draftsAllowed(row.role),
        ownerUserId: row.owner_user_id,
        connection:
          row.connection_status === null
            ? null
            : { accountName: row.account_name, active: row.connection_status === 'active' },
        members: admin ? await listMembers(db, row.org_id, now) : null,
      };
    }),
  );
}

async function listMembers(db: D1Database, orgId: string, now: number): Promise<OrganizationMember[]> {
  const monthStart = `${new Date(now).toISOString().slice(0, 7)}-01`;
  const { results } = await db
    .prepare(
      `SELECT members.user_id, users.name, users.email, members.role, members.joined_at, members.paused_at,
              COALESCE(SUM(usage.turns), 0) AS turns,
              COALESCE(SUM(usage.input_tokens), 0) AS input_tokens,
              COALESCE(SUM(usage.output_tokens), 0) AS output_tokens
       FROM organization_members AS members
       JOIN "user" AS users ON users.id = members.user_id
       LEFT JOIN organization_usage_daily AS usage
         ON usage.org_id = members.org_id AND usage.user_id = members.user_id AND usage.day >= ?
       WHERE members.org_id = ?
       GROUP BY members.user_id
       ORDER BY members.joined_at, users.email`,
    )
    .bind(monthStart, orgId)
    .all<{
      user_id: string;
      name: string;
      email: string;
      role: OrganizationRole;
      joined_at: number;
      paused_at: number | null;
      turns: number;
      input_tokens: number;
      output_tokens: number;
    }>();
  return results.map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
    role: row.role,
    joinedAt: row.joined_at,
    pausedAt: row.paused_at,
    usage: { turns: row.turns, inputTokens: row.input_tokens, outputTokens: row.output_tokens },
  }));
}

type MemberAction = 'pause' | 'resume' | 'remove' | 'make_admin' | 'make_member';

/**
 * An admin's change to one member, or a member leaving (`remove` on themselves). An organization
 * always keeps an active admin: the last one can't be paused, demoted or removed, nor leave.
 */
export async function updateMember(
  db: D1Database,
  args: { orgId: string; actorId: string; userId: string; action: MemberAction },
): Promise<void> {
  const leaving = args.action === 'remove' && args.actorId === args.userId;
  if (!leaving) {
    await requireAdmin(db, args.orgId, args.actorId);
  }
  const target = await findMembership(db, args.orgId, args.userId);
  if (!target) {
    throw new OrganizationError('That person is not in this space.', 404);
  }
  // A space made for one person builds in their own Cloudflare account, whose owner their workspace answers as:
  // they stay its admin for as long as it lasts, and end it by deleting it.
  const madeForThem = await db
    .prepare('SELECT 1 AS theirs FROM organizations WHERE id = ? AND personal_user_id = ?')
    .bind(args.orgId, args.userId)
    .first<{ theirs: number }>();
  if (
    madeForThem &&
    (args.action === 'make_member' || args.action === 'pause' || (args.action === 'remove' && !leaving))
  ) {
    throw new OrganizationError(
      `${target.orgName} builds in their own Cloudflare account, so they stay its admin.`,
      409,
    );
  }
  if (leaving) {
    const others = await db
      .prepare('SELECT COUNT(*) AS count FROM organization_members WHERE org_id = ? AND user_id <> ?')
      .bind(args.orgId, args.userId)
      .first<{ count: number }>();
    if ((others?.count ?? 0) === 0) {
      throw new OrganizationError(
        `You're the only one in ${target.orgName}, so leaving deletes it.`,
        409,
        'sole_member',
      );
    }
    if (madeForThem) {
      throw new OrganizationError(
        'This account builds in your own Cloudflare account, so you stay in it. To end it, delete it.',
        409,
      );
    }
  }
  const losesAdmin =
    target.role === 'admin' &&
    target.pausedAt === null &&
    (args.action === 'pause' || args.action === 'remove' || args.action === 'make_member');
  const now = Date.now();
  // Taking away the last active admin is refused inside the write itself, so two admins stepping each
  // other down at the same moment can't both succeed.
  const keepsAnAdmin = losesAdmin
    ? ` AND EXISTS (
         SELECT 1 FROM organization_members AS other
         WHERE other.org_id = organization_members.org_id AND other.user_id <> organization_members.user_id
           AND other.role = 'admin' AND other.paused_at IS NULL
       )`
    : '';
  const [write, values]: [string, (string | number)[]] =
    args.action === 'remove'
      ? ['DELETE FROM organization_members WHERE org_id = ? AND user_id = ?', [args.orgId, args.userId]]
      : args.action === 'pause'
        ? [
            'UPDATE organization_members SET paused_at = ? WHERE org_id = ? AND user_id = ? AND paused_at IS NULL',
            [now, args.orgId, args.userId],
          ]
        : args.action === 'resume'
          ? [
              'UPDATE organization_members SET paused_at = NULL WHERE org_id = ? AND user_id = ?',
              [args.orgId, args.userId],
            ]
          : [
              'UPDATE organization_members SET role = ? WHERE org_id = ? AND user_id = ?',
              [args.action === 'make_admin' ? 'admin' : 'member', args.orgId, args.userId],
            ];
  const membershipWrite = db.prepare(write + keepsAnAdmin).bind(...values);
  // Their workspace locator in the space's account and their access to its projects go with them.
  // All in the one write that removes them, and only once they're gone, so a refused removal keeps
  // everything and an interrupted one leaves no grant behind to come back if they're invited again.
  const gone = 'AND NOT EXISTS (SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?)';
  const [result] = await db.batch(
    args.action === 'remove'
      ? [
          membershipWrite,
          db
            .prepare(
              `DELETE FROM user_computer_runtimes
               WHERE user_id = ? AND connection_id IN (SELECT id FROM cloudflare_connections WHERE org_id = ?) ${gone}`,
            )
            .bind(args.userId, args.orgId, args.orgId, args.userId),
          db
            .prepare(
              `DELETE FROM org_project_access
               WHERE user_id = ? AND project_id IN (SELECT id FROM org_projects WHERE org_id = ?) ${gone}`,
            )
            .bind(args.userId, args.orgId, args.orgId, args.userId),
        ]
      : [membershipWrite],
  );
  if (losesAdmin && (result?.meta.changes ?? 0) === 0) {
    throw new OrganizationError('Make someone else an admin first: an account always needs one.', 409);
  }
}
