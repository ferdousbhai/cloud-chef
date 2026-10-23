import { sha256Hex, bytesToBase64Url } from '~/lib/hex-digest';
import {
  draftsAllowed,
  findMembership,
  isActiveAdmin,
  storedProjectIds,
  type Membership,
  type OrganizationRole,
} from './organization-access.server';

/** An invite works once, for a week: long enough to pass on, short enough not to linger. */
const ORGANIZATION_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export class OrganizationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410,
    /**
     * Set when the client can do something specific about it: `email_unproven` asks for a Google or
     * emailed-link sign-in, `inviter_not_admin` says an invite lapsed with its sender's admin rights, and
     * `sole_member` that leaving would leave the team empty, so it is deleted instead.
     */
    readonly code?: 'email_unproven' | 'inviter_not_admin' | 'sole_member',
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
  draftsAllowed: boolean;
  /** This calendar month's Workers AI use in the organization's account (UTC). */
  usage: { turns: number; inputTokens: number; outputTokens: number };
};

type PendingInvite = {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: number;
  projectIds: string[];
  draftsAllowed: boolean;
};

type OrganizationSummary = Membership & {
  /** The organization's Cloudflare account, once an admin has connected it. */
  connection: { accountName: string | null; active: boolean } | null;
  /** Only an admin sees who else is in the organization and who is invited. */
  members: OrganizationMember[] | null;
  invites: PendingInvite[] | null;
};

/** Teams one person may have created: each can send invite emails, so their number is bounded. */
const MAX_ORGANIZATIONS_PER_CREATOR = 10;
/**
 * And teams one person may create in this window: creations are counted from
 * `organization_quota_events`, so deleting a team doesn't give its creation back. The log keeps each
 * entry this long, the longest window any limit counts over.
 */
export const ORGANIZATION_QUOTA_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** A new organization with its creator as admin; its Cloudflare account is connected next. */
export async function createOrganization(db: D1Database, userId: string, name: string) {
  const orgId = crypto.randomUUID();
  const now = Date.now();
  // The limits are checked inside the write itself, so two requests at the same moment can't both pass
  // them; the membership and the log entry are written only with the team.
  const [created] = await db.batch([
    db
      .prepare(
        `INSERT INTO organizations (id, name, created_by, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?4
         WHERE (SELECT COUNT(*) FROM organizations WHERE created_by = ?3) < ?5
           AND (SELECT COUNT(*) FROM organization_quota_events
                WHERE user_id = ?3 AND kind = 'team' AND created_at > ?6) < ?5`,
      )
      .bind(orgId, name, userId, now, MAX_ORGANIZATIONS_PER_CREATOR, now - ORGANIZATION_QUOTA_WINDOW_MS),
    db
      .prepare(
        `INSERT INTO organization_members (org_id, user_id, role, joined_at)
         SELECT ?1, ?2, 'admin', ?3 WHERE EXISTS (SELECT 1 FROM organizations WHERE id = ?1)`,
      )
      .bind(orgId, userId, now),
    db
      .prepare(
        `INSERT INTO organization_quota_events (kind, user_id, org_id, created_at)
         SELECT 'team', ?2, ?1, ?3 WHERE EXISTS (SELECT 1 FROM organizations WHERE id = ?1)`,
      )
      .bind(orgId, userId, now),
  ]);
  if (created?.meta.changes !== 1) {
    throw new OrganizationError(
      `You can have up to ${MAX_ORGANIZATIONS_PER_CREATOR} teams, and create up to ${MAX_ORGANIZATIONS_PER_CREATOR} in 30 days.`,
      409,
    );
  }
  return orgId;
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
    throw new OrganizationError('That team no longer exists, or you are not in it.', 404);
  }
  const { results } = await db
    .prepare('SELECT user_id FROM organization_members WHERE org_id = ? ORDER BY joined_at')
    .bind(args.orgId)
    .all<{ user_id: string }>();
  const memberIds = results.map((row) => row.user_id);
  const soleMember = memberIds.length === 1 && memberIds[0] === args.actorId;
  if (!soleMember && !isActiveAdmin(membership)) {
    throw new OrganizationError("Only a team's admin can delete it.", 403);
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

export async function requireAdmin(db: D1Database, orgId: string, userId: string): Promise<Membership> {
  const membership = await findMembership(db, orgId, userId);
  if (!membership || !isActiveAdmin(membership)) {
    throw new OrganizationError("Only a team's admin can do that.", 403);
  }
  return membership;
}

/**
 * Pending invites one organization may have at once, and invites it may send in a day. Invites sent
 * are counted from `organization_quota_events`, so revoking one, or deleting the team, doesn't give it
 * back. Erasing the inviter's account does: those records are theirs, and go with them (by the
 * table's cascade), so a team's daily count drops by what they sent. Erasure is rare and needs a
 * fresh sign-in, so that is the trade made for erasing everything about them.
 */
const MAX_PENDING_INVITES = 50;
const MAX_INVITES_PER_DAY = 100;
/** Invites one person may send in a day, across all their teams. */
const MAX_INVITES_PER_INVITER_PER_DAY = 100;

/**
 * A one-time invite for `email`; the link carries the token, and only its hash is stored. `projectIds`
 * are the organization's projects the person gets on joining, to edit (others are ignored); a member may
 * build new apps of their own unless `draftsAllowed` is false. It replaces any invite still waiting for
 * the same email, whose link stops working: one person has one way in, the one sent last.
 */
export async function createInvite(
  db: D1Database,
  args: {
    orgId: string;
    email: string;
    role: OrganizationRole;
    invitedBy: string;
    projectIds?: string[];
    draftsAllowed?: boolean;
  },
): Promise<{ token: string; expiresAt: number }> {
  const now = Date.now();
  const limitValues = [args.orgId, now, now - 24 * 60 * 60_000, args.email, args.invitedBy] as const;
  const projectIds = await orgProjectIds(db, args.orgId, args.projectIds ?? []);
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + ORGANIZATION_INVITE_TTL_MS;
  const inviteId = crypto.randomUUID();
  // The limits are checked as the invite is written, in the same statement, so two invites sent at once
  // can't both pass the last free place; what it sent is counted only if it was written.
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO organization_invites
           (id, org_id, email, role, token_hash, invited_by, expires_at, created_at, project_ids, drafts_allowed)
         SELECT ?6, ?1, ?4, ?7, ?8, ?5, ?9, ?2, ?10, ?11
         FROM (${INVITE_LIMITS_SQL})
         WHERE connected > 0 AND already_member = 0 AND by_inviter < ${MAX_INVITES_PER_INVITER_PER_DAY}
           AND today < ${MAX_INVITES_PER_DAY} AND pending < ${MAX_PENDING_INVITES}`,
      )
      .bind(
        ...limitValues,
        inviteId,
        args.role,
        await sha256Hex(token),
        expiresAt,
        projectIds.length > 0 ? JSON.stringify(projectIds) : null,
        args.draftsAllowed === false ? 0 : 1,
      ),
    db
      .prepare(
        `DELETE FROM organization_invites
         WHERE org_id = ? AND email = ? COLLATE NOCASE AND accepted_at IS NULL AND id <> ?
           AND EXISTS (SELECT 1 FROM organization_invites WHERE id = ?)`,
      )
      .bind(args.orgId, args.email, inviteId, inviteId),
    db
      .prepare(
        `INSERT INTO organization_quota_events (kind, user_id, org_id, created_at)
         SELECT 'invite', ?, ?, ? WHERE EXISTS (SELECT 1 FROM organization_invites WHERE id = ?)`,
      )
      .bind(args.invitedBy, args.orgId, now, inviteId),
  ]);
  if (!inserted?.meta.changes) {
    // Refused: say which limit it reached.
    refuseInviteOverLimits(
      args.email,
      await db
        .prepare(`SELECT * FROM (${INVITE_LIMITS_SQL})`)
        .bind(...limitValues)
        .first<InviteLimits>(),
    );
    throw new OrganizationError('The invite could not be sent just now. Try again.', 409);
  }
  return { token, expiresAt };
}

/**
 * What an invite is limited by, bound as ?1 org id, ?2 now, ?3 a day ago, ?4 the invited email, ?5
 * the inviter. Invites are email CloudChef sends: only an organization with its Cloudflare account
 * connected (a real Cloudflare login with access to it) sends them, and only so many. An invite waiting
 * for the same email isn't counted as pending, since the new one replaces it.
 */
const INVITE_LIMITS_SQL = `SELECT
  (SELECT COUNT(*) FROM cloudflare_connections WHERE org_id = ?1 AND status = 'active') AS connected,
  (SELECT COUNT(*) FROM organization_invites
   WHERE org_id = ?1 AND accepted_at IS NULL AND expires_at > ?2 AND email <> ?4 COLLATE NOCASE) AS pending,
  (SELECT COUNT(*) FROM organization_quota_events
   WHERE org_id = ?1 AND kind = 'invite' AND created_at > ?3) AS today,
  (SELECT COUNT(*) FROM organization_members AS members JOIN "user" AS users ON users.id = members.user_id
   WHERE members.org_id = ?1 AND users.email = ?4 COLLATE NOCASE) AS already_member,
  (SELECT COUNT(*) FROM organization_quota_events
   WHERE user_id = ?5 AND kind = 'invite' AND created_at > ?3) AS by_inviter`;

type InviteLimits = { connected: number; pending: number; today: number; already_member: number; by_inviter: number };

/** Throws the reason an invite to `email` is refused under `limits`, if it is. */
function refuseInviteOverLimits(email: string, limits: InviteLimits | null): void {
  if (!limits?.connected) {
    throw new OrganizationError("Connect the team's Cloudflare account before inviting people.", 409);
  }
  // Accepting never changes a member's role, so an invite to someone already in would do nothing.
  if (limits.already_member > 0) {
    throw new OrganizationError(
      `${email} is already in the team. To change what they can do, use Make admin or the other buttons by their name.`,
      409,
    );
  }
  if (limits.by_inviter >= MAX_INVITES_PER_INVITER_PER_DAY) {
    throw new OrganizationError(
      `${MAX_INVITES_PER_INVITER_PER_DAY} invites a day, across your teams, is the limit. Try again tomorrow.`,
      409,
    );
  }
  if (limits.today >= MAX_INVITES_PER_DAY) {
    throw new OrganizationError(`${MAX_INVITES_PER_DAY} invites a day is the limit. Try again tomorrow.`, 409);
  }
  if (limits.pending >= MAX_PENDING_INVITES) {
    throw new OrganizationError(
      `${MAX_PENDING_INVITES} invites are waiting to be accepted. Revoke some before sending more.`,
      409,
    );
  }
}

/** Which of `projectIds` are the organization's projects. */
async function orgProjectIds(db: D1Database, orgId: string, projectIds: string[]): Promise<string[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare('SELECT id FROM org_projects WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))')
    .bind(orgId, JSON.stringify(projectIds))
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/**
 * What an invite link says before anyone signs in: the organization, who sent it, and the address it's
 * for. Only the link's holder can ask, and the address is the one the link was emailed to. Null when the
 * invite is used or expired; refused with `inviter_not_admin` when its sender is no longer an active
 * admin, which is why it lapsed.
 */
export async function describeInvite(
  db: D1Database,
  token: string,
): Promise<{ orgName: string; email: string; inviterName: string } | null> {
  const row = await db
    .prepare(
      `SELECT organizations.name AS org_name, invites.email, users.name AS inviter_name,
              EXISTS (
                SELECT 1 FROM organization_members AS inviter
                WHERE inviter.org_id = invites.org_id AND inviter.user_id = invites.invited_by
                  AND inviter.role = 'admin' AND inviter.paused_at IS NULL
              ) AS inviter_is_admin
       FROM organization_invites AS invites
       JOIN organizations ON organizations.id = invites.org_id
       LEFT JOIN "user" AS users ON users.id = invites.invited_by
       WHERE invites.token_hash = ? AND invites.accepted_at IS NULL AND invites.expires_at > ?`,
    )
    .bind(await sha256Hex(token), Date.now())
    .first<{ org_name: string; email: string; inviter_name: string | null; inviter_is_admin: number }>();
  if (!row) {
    return null;
  }
  if (!row.inviter_is_admin || row.inviter_name === null) {
    throw inviterNotAdmin(row.org_name);
  }
  return { orgName: row.org_name, email: row.email, inviterName: row.inviter_name };
}

function inviterNotAdmin(orgName: string): OrganizationError {
  return new OrganizationError(
    `Whoever sent this invite is no longer an admin of ${orgName}, so it no longer works. Ask one of its admins for a new one.`,
    410,
    'inviter_not_admin',
  );
}

/**
 * Joins the organization an invite is for. The invite must be unused and unexpired, and addressed to
 * an email CloudChef proved this person holds (an emailed link or Google): a forwarded link is useless
 * to anyone else, and so is an email merely reported by another sign-in.
 */
export async function acceptInvite(
  db: D1Database,
  args: { token: string; userId: string },
): Promise<{ orgId: string }> {
  const now = Date.now();
  const invite = await db
    .prepare(
      // An invite speaks for the admin who sent it: once they're removed, paused or no longer an admin,
      // it lapses, so a removed admin can't come back through an invite they sent themselves.
      `SELECT invites.id, invites.org_id, invites.email, invites.role, invites.expires_at, invites.accepted_at,
              invites.invited_by, invites.project_ids, invites.drafts_allowed, organizations.name AS org_name,
              EXISTS (
                SELECT 1 FROM organization_members AS inviter
                WHERE inviter.org_id = invites.org_id AND inviter.user_id = invites.invited_by
                  AND inviter.role = 'admin' AND inviter.paused_at IS NULL
              ) AS inviter_is_admin
       FROM organization_invites AS invites
       JOIN organizations ON organizations.id = invites.org_id
       WHERE invites.token_hash = ?`,
    )
    .bind(await sha256Hex(args.token))
    .first<{
      id: string;
      org_id: string;
      email: string;
      role: OrganizationRole;
      expires_at: number;
      accepted_at: number | null;
      invited_by: string;
      project_ids: string | null;
      drafts_allowed: number;
      org_name: string;
      inviter_is_admin: number;
    }>();
  if (!invite || invite.accepted_at !== null || invite.expires_at <= now) {
    throw new OrganizationError('This invite has been used or has expired. Ask for a new one.', 410);
  }
  if (!invite.inviter_is_admin) {
    throw inviterNotAdmin(invite.org_name);
  }
  const person = await db
    .prepare('SELECT email, email_proven_at FROM "user" WHERE id = ?')
    .bind(args.userId)
    .first<{ email: string; email_proven_at: number | null }>();
  if (!person || person.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new OrganizationError(
      `This invite is for ${invite.email}. Sign in with Google or an emailed link to that address to accept it.`,
      403,
    );
  }
  if (person.email_proven_at === null) {
    throw new OrganizationError(
      `Confirm that ${invite.email} is yours with Google or an emailed link, then join.`,
      403,
      'email_unproven',
    );
  }
  const claimed = await db
    .prepare('UPDATE organization_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL')
    .bind(now, invite.id)
    .run();
  if (claimed.meta.changes !== 1) {
    throw new OrganizationError('This invite has been used or has expired. Ask for a new one.', 410);
  }
  // Someone already in the organization keeps their role; an invite never demotes or unpauses.
  const joining = [
    db
      .prepare(
        // A member builds new apps of their own if the inviting admin allowed it; otherwise they work on the
        // team projects they're given until an admin does. (Admins may always.)
        `INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, user_id) DO NOTHING`,
      )
      .bind(invite.org_id, args.userId, invite.role, now, invite.role === 'admin' ? 1 : invite.drafts_allowed),
    // Any other invite waiting for them goes: once they're in, one left over would bring them back after
    // they're removed, perhaps as an admin.
    db
      .prepare(
        `DELETE FROM organization_invites
         WHERE org_id = ? AND email = ? COLLATE NOCASE AND accepted_at IS NULL AND id <> ?`,
      )
      .bind(invite.org_id, invite.email, invite.id),
  ];
  if (invite.project_ids !== null) {
    // The projects the inviting admin chose, those still in the organization, granted in their name.
    joining.push(
      db
        .prepare(
          `INSERT INTO org_project_access (project_id, user_id, granted_by, granted_at)
           SELECT id, ?, ?, ? FROM org_projects
           WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))
           ON CONFLICT(project_id, user_id) DO NOTHING`,
        )
        .bind(args.userId, invite.invited_by, now, invite.org_id, invite.project_ids),
    );
  }
  // Membership and project access land together; if they can't, the invite is released to try again.
  try {
    await db.batch(joining);
  } catch (failure) {
    await db.prepare('UPDATE organization_invites SET accepted_at = NULL WHERE id = ?').bind(invite.id).run();
    throw failure;
  }
  return { orgId: invite.org_id };
}

/** The organizations this person belongs to, with their members and invites where they are an admin. */
export async function listOrganizations(db: D1Database, userId: string): Promise<OrganizationSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT members.org_id, organizations.name AS org_name, members.role, members.paused_at,
              members.drafts_allowed, connections.account_name, connections.status AS connection_status
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       LEFT JOIN cloudflare_connections AS connections ON connections.org_id = members.org_id
       WHERE members.user_id = ?
       ORDER BY organizations.name, organizations.id`,
    )
    .bind(userId)
    .all<{
      org_id: string;
      org_name: string;
      role: OrganizationRole;
      paused_at: number | null;
      drafts_allowed: number;
      account_name: string | null;
      connection_status: string | null;
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
        draftsAllowed: draftsAllowed(row.role, row.drafts_allowed),
        connection:
          row.connection_status === null
            ? null
            : { accountName: row.account_name, active: row.connection_status === 'active' },
        members: admin ? await listMembers(db, row.org_id, now) : null,
        invites: admin ? await listPendingInvites(db, row.org_id, now) : null,
      };
    }),
  );
}

async function listMembers(db: D1Database, orgId: string, now: number): Promise<OrganizationMember[]> {
  const monthStart = `${new Date(now).toISOString().slice(0, 7)}-01`;
  const { results } = await db
    .prepare(
      `SELECT members.user_id, users.name, users.email, members.role, members.joined_at, members.paused_at,
              members.drafts_allowed,
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
      drafts_allowed: number;
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
    draftsAllowed: draftsAllowed(row.role, row.drafts_allowed),
    usage: { turns: row.turns, inputTokens: row.input_tokens, outputTokens: row.output_tokens },
  }));
}

async function listPendingInvites(db: D1Database, orgId: string, now: number): Promise<PendingInvite[]> {
  const { results } = await db
    .prepare(
      `SELECT id, email, role, expires_at, project_ids, drafts_allowed FROM organization_invites
       WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .bind(orgId, now)
    .all<{
      id: string;
      email: string;
      role: OrganizationRole;
      expires_at: number;
      project_ids: string | null;
      drafts_allowed: number;
    }>();
  return results.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    projectIds: storedProjectIds(row.project_ids),
    draftsAllowed: draftsAllowed(row.role, row.drafts_allowed),
  }));
}

type MemberAction = 'pause' | 'resume' | 'remove' | 'make_admin' | 'make_member' | 'allow_drafts' | 'disallow_drafts';

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
    throw new OrganizationError('That person is not in this team.', 404);
  }
  if (leaving) {
    const others = await db
      .prepare('SELECT COUNT(*) AS count FROM organization_members WHERE org_id = ? AND user_id <> ?')
      .bind(args.orgId, args.userId)
      .first<{ count: number }>();
    if ((others?.count ?? 0) === 0) {
      throw new OrganizationError(
        `You're the only one in ${target.orgName}, so leaving deletes the team.`,
        409,
        'sole_member',
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
          : args.action === 'allow_drafts' || args.action === 'disallow_drafts'
            ? [
                'UPDATE organization_members SET drafts_allowed = ? WHERE org_id = ? AND user_id = ?',
                [args.action === 'allow_drafts' ? 1 : 0, args.orgId, args.userId],
              ]
            : [
                'UPDATE organization_members SET role = ? WHERE org_id = ? AND user_id = ?',
                [args.action === 'make_admin' ? 'admin' : 'member', args.orgId, args.userId],
              ];
  const membershipWrite = db.prepare(write + keepsAnAdmin).bind(...values);
  // Their workspace locator in the organization's account, their access to its projects and any invite
  // still waiting for their email go with them, and their open production requests are declined: nobody
  // may approve work for someone gone, and no invite left over brings them back.
  // All in the one write that removes them, and only once they're gone, so a refused removal keeps
  // everything and an interrupted one leaves no grant behind to come back if they're invited again.
  const gone = 'AND NOT EXISTS (SELECT 1 FROM organization_members WHERE org_id = ? AND user_id = ?)';
  const [result] = await db.batch(
    args.action === 'remove'
      ? [
          membershipWrite,
          db
            .prepare(
              `UPDATE production_requests
               SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ?, note = NULL, preview_url = NULL
               WHERE org_id = ? AND requested_by = ? AND status = 'pending' ${gone}`,
            )
            .bind(
              args.actorId,
              now,
              leaving ? 'They left the team.' : 'They were removed from the team.',
              args.orgId,
              args.userId,
              args.orgId,
              args.userId,
            ),
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
          db
            .prepare(
              `DELETE FROM organization_invites
               WHERE org_id = ? AND accepted_at IS NULL
                 AND email = (SELECT email FROM "user" WHERE id = ?) COLLATE NOCASE ${gone}`,
            )
            .bind(args.orgId, args.userId, args.orgId, args.userId),
        ]
      : [membershipWrite],
  );
  if (losesAdmin && (result?.meta.changes ?? 0) === 0) {
    throw new OrganizationError('Make someone else an admin first: a team always needs one.', 409);
  }
}

export async function revokeInvite(db: D1Database, args: { orgId: string; actorId: string; inviteId: string }) {
  await requireAdmin(db, args.orgId, args.actorId);
  await db
    .prepare('DELETE FROM organization_invites WHERE id = ? AND org_id = ? AND accepted_at IS NULL')
    .bind(args.inviteId, args.orgId)
    .run();
}
