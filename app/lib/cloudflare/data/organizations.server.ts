import { z } from 'zod';
import { sha256Hex, bytesToBase64Url } from '~/lib/hex-digest';
import { findMembership, type Membership, type OrganizationRole } from './organization-access.server';

/** An invite works once, for a week: long enough to pass on, short enough not to linger. */
const ORGANIZATION_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export class OrganizationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410,
    /** Set when the client can do something specific about it: `email_unproven` asks for a Google or emailed-link sign-in. */
    readonly code?: 'email_unproven',
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

/** A new organization with its creator as admin; its Cloudflare account is connected next. */
export async function createOrganization(db: D1Database, userId: string, name: string, now = Date.now()) {
  const orgId = crypto.randomUUID();
  await db.batch([
    db
      .prepare('INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(orgId, name, userId, now, now),
    db
      .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)`)
      .bind(orgId, userId, now),
  ]);
  return orgId;
}

export async function requireAdmin(db: D1Database, orgId: string, userId: string): Promise<Membership> {
  const membership = await findMembership(db, orgId, userId);
  if (membership?.role !== 'admin' || membership.pausedAt !== null) {
    throw new OrganizationError("Only an organization's admin can do that.", 403);
  }
  return membership;
}

/** Pending invites one organization may have at once, and invites it may send in a day. */
const MAX_PENDING_INVITES = 50;
const MAX_INVITES_PER_DAY = 100;

/**
 * A one-time invite for `email`; the link carries the token, and only its hash is stored. `projectIds`
 * are the organization's GitHub projects the person gets on joining (others are ignored); a member may
 * build new apps of their own unless `draftsAllowed` is false.
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
    now?: number;
  },
): Promise<{ token: string; expiresAt: number }> {
  const now = args.now ?? Date.now();
  // Invites are email CloudChef sends: only an organization with its Cloudflare account connected (a
  // real Cloudflare login with access to it) sends them, and only so many.
  const limits = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM cloudflare_connections WHERE org_id = ?1 AND status = 'active') AS connected,
         (SELECT COUNT(*) FROM organization_invites WHERE org_id = ?1 AND accepted_at IS NULL AND expires_at > ?2) AS pending,
         (SELECT COUNT(*) FROM organization_invites WHERE org_id = ?1 AND created_at > ?3) AS today`,
    )
    .bind(args.orgId, now, now - 24 * 60 * 60_000)
    .first<{ connected: number; pending: number; today: number }>();
  if (!limits?.connected) {
    throw new OrganizationError("Connect the organization's Cloudflare account before inviting people.", 409);
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
  const projectIds = await orgProjectIds(db, args.orgId, args.projectIds ?? []);
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = now + ORGANIZATION_INVITE_TTL_MS;
  await db
    .prepare(
      `INSERT INTO organization_invites
         (id, org_id, email, role, token_hash, invited_by, expires_at, created_at, project_ids, drafts_allowed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.orgId,
      args.email,
      args.role,
      await sha256Hex(token),
      args.invitedBy,
      expiresAt,
      now,
      projectIds.length > 0 ? JSON.stringify(projectIds) : null,
      args.draftsAllowed === false ? 0 : 1,
    )
    .run();
  return { token, expiresAt };
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
 * Joins the organization an invite is for. The invite must be unused and unexpired, and addressed to
 * an email CloudChef proved this person holds (an emailed link or Google): a forwarded link is useless
 * to anyone else, and so is an email merely reported by another sign-in.
 */
/**
 * What an invite link says before anyone signs in: the organization, who sent it, and the address it's
 * for. Only the link's holder can ask, and the address is the one the link was emailed to. Null when the
 * invite is used, expired, or its sender is no longer an active admin.
 */
export async function describeInvite(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<{ orgName: string; email: string; inviterName: string } | null> {
  const row = await db
    .prepare(
      `SELECT organizations.name AS org_name, invites.email, users.name AS inviter_name
       FROM organization_invites AS invites
       JOIN organizations ON organizations.id = invites.org_id
       JOIN organization_members AS inviter
         ON inviter.org_id = invites.org_id AND inviter.user_id = invites.invited_by
            AND inviter.role = 'admin' AND inviter.paused_at IS NULL
       JOIN "user" AS users ON users.id = invites.invited_by
       WHERE invites.token_hash = ? AND invites.accepted_at IS NULL AND invites.expires_at > ?`,
    )
    .bind(await sha256Hex(token), now)
    .first<{ org_name: string; email: string; inviter_name: string }>();
  return row ? { orgName: row.org_name, email: row.email, inviterName: row.inviter_name } : null;
}

export async function acceptInvite(
  db: D1Database,
  args: { token: string; userId: string; now?: number },
): Promise<{ orgId: string }> {
  const now = args.now ?? Date.now();
  const invite = await db
    .prepare(
      // An invite speaks for the admin who sent it: once they're removed, paused or no longer an admin,
      // it lapses, so a removed admin can't come back through an invite they sent themselves.
      `SELECT invites.id, invites.org_id, invites.email, invites.role, invites.expires_at, invites.accepted_at,
              invites.invited_by, invites.project_ids, invites.drafts_allowed
       FROM organization_invites AS invites
       JOIN organization_members AS inviter
         ON inviter.org_id = invites.org_id AND inviter.user_id = invites.invited_by
            AND inviter.role = 'admin' AND inviter.paused_at IS NULL
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
    }>();
  if (!invite || invite.accepted_at !== null || invite.expires_at <= now) {
    throw new OrganizationError('This invite has been used or has expired. Ask for a new one.', 410);
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
        // GitHub projects they're given until an admin does. (Admins may always.)
        `INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, user_id) DO NOTHING`,
      )
      .bind(invite.org_id, args.userId, invite.role, now, invite.role === 'admin' ? 1 : invite.drafts_allowed),
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
export async function listOrganizations(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<OrganizationSummary[]> {
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
  return Promise.all(
    results.map(async (row) => {
      const admin = row.role === 'admin' && row.paused_at === null;
      return {
        orgId: row.org_id,
        orgName: row.org_name,
        role: row.role,
        pausedAt: row.paused_at,
        draftsAllowed: row.role === 'admin' || row.drafts_allowed === 1,
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
    draftsAllowed: row.role === 'admin' || row.drafts_allowed === 1,
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
    draftsAllowed: row.role === 'admin' || row.drafts_allowed === 1,
  }));
}

const storedProjectIdsSchema = z.array(z.string());

/** An invite's stored project ids; anything unreadable gives none. */
function storedProjectIds(stored: string | null): string[] {
  if (stored === null) {
    return [];
  }
  try {
    return storedProjectIdsSchema.catch([]).parse(JSON.parse(stored));
  } catch {
    return [];
  }
}

type MemberAction = 'pause' | 'resume' | 'remove' | 'make_admin' | 'make_member' | 'allow_drafts' | 'disallow_drafts';

/**
 * An admin's change to one member, or a member leaving (`remove` on themselves). An organization
 * always keeps an active admin: the last one can't be paused, demoted or removed, nor leave.
 */
export async function updateMember(
  db: D1Database,
  args: { orgId: string; actorId: string; userId: string; action: MemberAction; now?: number },
): Promise<void> {
  const leaving = args.action === 'remove' && args.actorId === args.userId;
  if (!leaving) {
    await requireAdmin(db, args.orgId, args.actorId);
  }
  const target = await findMembership(db, args.orgId, args.userId);
  if (!target) {
    throw new OrganizationError('That person is not in this organization.', 404);
  }
  const losesAdmin =
    target.role === 'admin' &&
    target.pausedAt === null &&
    (args.action === 'pause' || args.action === 'remove' || args.action === 'make_member');
  const now = args.now ?? Date.now();
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
  const result = await db
    .prepare(write + keepsAnAdmin)
    .bind(...values)
    .run();
  if (losesAdmin && result.meta.changes === 0) {
    throw new OrganizationError('Make someone else an admin first: an organization always needs one.', 409);
  }
  if (args.action === 'remove') {
    // Their workspace locator in the organization's account and their access to its projects go with them.
    await db.batch([
      db
        .prepare(
          `DELETE FROM user_computer_runtimes
           WHERE user_id = ? AND connection_id IN (SELECT id FROM cloudflare_connections WHERE org_id = ?)`,
        )
        .bind(args.userId, args.orgId),
      db
        .prepare(
          `DELETE FROM org_project_access
           WHERE user_id = ? AND project_id IN (SELECT id FROM org_projects WHERE org_id = ?)`,
        )
        .bind(args.userId, args.orgId),
    ]);
  }
}

export async function revokeInvite(db: D1Database, args: { orgId: string; actorId: string; inviteId: string }) {
  await requireAdmin(db, args.orgId, args.actorId);
  await db
    .prepare('DELETE FROM organization_invites WHERE id = ? AND org_id = ? AND accepted_at IS NULL')
    .bind(args.inviteId, args.orgId)
    .run();
}
