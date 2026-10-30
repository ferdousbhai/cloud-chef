import { shownName } from '~/lib/shown-name';
import { normalizeEmail } from '~/lib/.server/auth';
import { bytesToBase64Url, sha256Hex } from '~/lib/hex-digest';
import { setProjectAccess, type Project, type ProjectRole } from './org-projects.server';

/**
 * Sharing a project with people, as a document is shared: by username, which finds that person, or by email
 * address, which always makes an invitation, so the person sharing never learns whether an address has a
 * CloudChef account. A team's own members get their role in `org_project_access`; everyone else in
 * `project_shares`, and works on the project from an account of their own (`findAccessibleProject`'s
 * `shared`). Whoever runs the project (its owner, or one of its team's active admins) shares it.
 */
export const PROJECT_INVITATION_TTL_MS = 14 * 24 * 60 * 60_000;

/** Refused, in words for the person sharing or the person invited. */
export class ProjectShareError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410,
    /** `email_mismatch` and `email_unproven` ask for signing in with the invited address. */
    readonly code?: 'email_mismatch' | 'email_unproven',
  ) {
    super(message);
    this.name = 'ProjectShareError';
  }
}

/** Someone who may use the project, as the Share dialog lists them: never with their email address. */
export type SharingPerson = {
  userId: string;
  name: string;
  username: string | null;
  image: string | null;
  /** `owner`: runs it (its owner, or a team admin); otherwise what they may do. */
  role: 'owner' | ProjectRole;
  /** `team`: a member of the project's team; `shared`: someone it was shared with. */
  kind: 'owner' | 'team' | 'shared';
};

export type SharingInvitation = { id: string; email: string; role: ProjectRole; sentAt: number; expiresAt: number };

/**
 * Whether `?{n}`, the user, runs the project in `projects`: its owner for a person's own, an active admin of its team
 * for a team's.
 */
function runsProjectSql(user: string): string {
  return `((projects.org_id IS NULL AND EXISTS (
      SELECT 1 FROM cloudflare_connections AS owner WHERE owner.id = projects.connection_id AND owner.user_id = ${user}))
    OR EXISTS (
      SELECT 1 FROM organization_members AS admins
      WHERE admins.org_id = projects.org_id AND admins.user_id = ${user} AND admins.role = 'admin'
        AND admins.paused_at IS NULL))`;
}

/** Who may use `project` and who is invited to: what its Share dialog shows. */
export async function projectSharing(
  db: D1Database,
  project: Pick<Project, 'id' | 'orgId' | 'connectionId'>,
  now = Date.now(),
): Promise<{ people: SharingPerson[]; invitations: SharingInvitation[] }> {
  const [{ results: people }, { results: invitations }] = await Promise.all([
    db
      .prepare(
        `SELECT person.id, person.name, person.username, person.image, chosen.role, chosen.kind FROM (
           SELECT user_id, 'owner' AS role, 'owner' AS kind, 0 AS sort, 0 AS since
             FROM cloudflare_connections WHERE id = ?2 AND ?3 IS NULL AND user_id IS NOT NULL
           UNION ALL
           SELECT user_id, 'owner', 'owner', 0, joined_at FROM organization_members
             WHERE org_id = ?3 AND role = 'admin' AND paused_at IS NULL
           UNION ALL
           SELECT access.user_id, access.role, 'team', 1, access.granted_at FROM org_project_access AS access
             JOIN organization_members AS members ON members.org_id = ?3 AND members.user_id = access.user_id
             WHERE access.project_id = ?1 AND members.role = 'member' AND members.paused_at IS NULL
           UNION ALL
           SELECT user_id, role, 'shared', 1, shared_at FROM project_shares WHERE project_id = ?1
         ) AS chosen JOIN "user" AS person ON person.id = chosen.user_id
         ORDER BY chosen.sort, chosen.since`,
      )
      .bind(project.id, project.connectionId, project.orgId)
      .all<{
        id: string;
        name: string | null;
        username: string | null;
        image: string | null;
        role: SharingPerson['role'];
        kind: SharingPerson['kind'];
      }>(),
    db
      .prepare(
        `SELECT id, email, role, sent_at, expires_at FROM project_invitations
         WHERE project_id = ? AND expires_at > ? ORDER BY created_at`,
      )
      .bind(project.id, now)
      .all<{ id: string; email: string; role: ProjectRole; sent_at: number; expires_at: number }>(),
  ]);
  return {
    people: people.map((row) => ({
      userId: row.id,
      name: shownName(row.name ?? row.username ?? ''),
      username: row.username,
      image: row.image,
      role: row.role,
      kind: row.kind,
    })),
    invitations: invitations.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      sentAt: row.sent_at,
      expiresAt: row.expires_at,
    })),
  };
}

/** What sharing did: shared with a person at once (to tell them), or invited an address (to email the link to). */
export type ShareOutcome =
  | { kind: 'shared'; userId: string; email: string | null; name: string }
  | { kind: 'invited'; invitationId: string; email: string; token: string; accountId: string | null };

/**
 * Shares `project` with `to`, a username (`sara` or `@sara`) or an email address, to view or edit it. A username
 * shares with that person at once. An address makes an invitation, or renews the one it has; an account that has
 * proven that address is also told in CloudChef, and takes it the next time it looks. A team's own member is given
 * the role as a member, whichever way they are named.
 */
export async function shareProject(
  db: D1Database,
  args: { project: Project; actorId: string; to: string; role: ProjectRole; now?: number },
): Promise<ShareOutcome> {
  const now = args.now ?? Date.now();
  const to = args.to.trim();
  if (to.includes('@') && !to.startsWith('@')) {
    return inviteByEmail(db, { ...args, email: normalizeEmail(to), now });
  }
  const username = to.replace(/^@/, '').toLowerCase();
  const person = await db
    .prepare('SELECT id, name, email FROM "user" WHERE username = ?')
    .bind(username)
    .first<{ id: string; name: string | null; email: string | null }>();
  if (!person) {
    throw new ProjectShareError(
      `There’s nobody on CloudChef called ${username}. Check the name, or use their email.`,
      404,
    );
  }
  if (await runs(db, args.project.id, person.id)) {
    throw new ProjectShareError(person.id === args.actorId ? 'That’s you.' : 'They run this project already.', 409);
  }
  const shared = await grant(db, { ...args, userId: person.id, now });
  if (shared === 'shared') {
    await notifyShared(db, { userId: person.id, actorId: args.actorId, project: args.project, now });
  }
  return { kind: 'shared', userId: person.id, email: person.email, name: shownName(person.name ?? username) };
}

async function inviteByEmail(
  db: D1Database,
  args: { project: Project; actorId: string; email: string; role: ProjectRole; now: number },
): Promise<ShareOutcome> {
  const actor = await db.prepare('SELECT email FROM "user" WHERE id = ?').bind(args.actorId).first<{ email: string }>();
  if (actor && normalizeEmail(actor.email) === args.email) {
    throw new ProjectShareError('That’s you.', 409);
  }
  // A team's admins already see their members' addresses: one of them is given the role as a member.
  if (args.project.orgId) {
    const member = await db
      .prepare(
        `SELECT members.user_id FROM organization_members AS members JOIN "user" ON "user".id = members.user_id
         WHERE members.org_id = ? AND "user".email = ? COLLATE NOCASE`,
      )
      .bind(args.project.orgId, args.email)
      .first<{ user_id: string }>();
    if (member) {
      if (await runs(db, args.project.id, member.user_id)) {
        throw new ProjectShareError('They run this project already.', 409);
      }
      await grant(db, { ...args, userId: member.user_id });
      const name = await db
        .prepare('SELECT name FROM "user" WHERE id = ?')
        .bind(member.user_id)
        .first<{ name: string | null }>();
      return { kind: 'shared', userId: member.user_id, email: args.email, name: shownName(name?.name ?? '') };
    }
  }
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const id = crypto.randomUUID();
  const invitation = await db
    .prepare(
      `INSERT INTO project_invitations (id, project_id, email, role, token_hash, invited_by, created_at, sent_at,
         expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
       ON CONFLICT (project_id, email) DO UPDATE SET role = excluded.role, token_hash = excluded.token_hash,
         invited_by = excluded.invited_by, sent_at = excluded.sent_at, expires_at = excluded.expires_at
       RETURNING id`,
    )
    .bind(
      id,
      args.project.id,
      args.email,
      args.role,
      await sha256Hex(token),
      args.actorId,
      args.now,
      args.now + PROJECT_INVITATION_TTL_MS,
    )
    .first<{ id: string }>();
  const account = await provenAccountOf(db, args.email);
  if (account) {
    await notifyShared(db, { userId: account, actorId: args.actorId, project: args.project, now: args.now });
  }
  return { kind: 'invited', invitationId: invitation!.id, email: args.email, token, accountId: account };
}

/**
 * Gives `userId` the role: as a member when they are in the project's team (`org_project_access`), else as someone
 * it is shared with (`project_shares`). Which of the two it was.
 */
async function grant(
  db: D1Database,
  args: { project: Project; actorId: string; userId: string; role: ProjectRole; now: number },
): Promise<'team' | 'shared'> {
  if (args.project.orgId) {
    const member = await db
      .prepare('SELECT 1 AS yes FROM organization_members WHERE org_id = ? AND user_id = ?')
      .bind(args.project.orgId, args.userId)
      .first();
    if (member) {
      await setProjectAccess(db, {
        orgId: args.project.orgId,
        actorId: args.actorId,
        projectId: args.project.id,
        userId: args.userId,
        role: args.role,
      });
      return 'team';
    }
  }
  await db
    .prepare(
      `INSERT INTO project_shares (project_id, user_id, role, shared_by, shared_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(args.project.id, args.userId, args.role, args.actorId, args.now)
    .run();
  return 'shared';
}

/** Whether `userId` runs the project: its owner, or an active admin of its team. */
export async function runsProject(db: D1Database, projectId: string, userId: string): Promise<boolean> {
  return runs(db, projectId, userId);
}

async function runs(db: D1Database, projectId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS yes FROM org_projects AS projects WHERE projects.id = ?1 AND ${runsProjectSql('?2')}`)
    .bind(projectId, userId)
    .first();
  return row !== null;
}

/**
 * Changes what someone the project is shared with may do, or (null) takes it away: a team member's grant, or a
 * share. Taking it away stops their workspace at its next call to CloudChef.
 */
export async function setPersonRole(
  db: D1Database,
  args: { project: Project; actorId: string; userId: string; role: ProjectRole | null },
): Promise<void> {
  if (args.project.orgId) {
    const member = await db
      .prepare('SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?')
      .bind(args.project.orgId, args.userId)
      .first<{ role: string }>();
    if (member) {
      if (member.role === 'admin') {
        throw new ProjectShareError('The team’s admins run every team project.', 409);
      }
      await setProjectAccess(db, { orgId: args.project.orgId, ...args, projectId: args.project.id });
      return;
    }
  }
  const changed =
    args.role === null
      ? await db
          .prepare('DELETE FROM project_shares WHERE project_id = ? AND user_id = ?')
          .bind(args.project.id, args.userId)
          .run()
      : await db
          .prepare('UPDATE project_shares SET role = ? WHERE project_id = ? AND user_id = ?')
          .bind(args.role, args.project.id, args.userId)
          .run();
  if (changed.meta.changes === 0 && args.role !== null) {
    throw new ProjectShareError('This project isn’t shared with them.', 404);
  }
}

/** Changes an invitation's role, or cancels it (null). */
export async function setInvitationRole(
  db: D1Database,
  args: { projectId: string; invitationId: string; role: ProjectRole | null },
): Promise<void> {
  const changed =
    args.role === null
      ? await db
          .prepare('DELETE FROM project_invitations WHERE id = ? AND project_id = ?')
          .bind(args.invitationId, args.projectId)
          .run()
      : await db
          .prepare('UPDATE project_invitations SET role = ? WHERE id = ? AND project_id = ?')
          .bind(args.role, args.invitationId, args.projectId)
          .run();
  if (changed.meta.changes === 0 && args.role !== null) {
    throw new ProjectShareError('That invitation was taken or cancelled.', 404);
  }
}

/** A new link for an invitation, which the old one stops working for, and its fourteen days start again. */
export async function renewInvitation(
  db: D1Database,
  args: { projectId: string; invitationId: string; actorId: string; now?: number },
): Promise<{ email: string; token: string; role: ProjectRole }> {
  const now = args.now ?? Date.now();
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const row = await db
    .prepare(
      `UPDATE project_invitations SET token_hash = ?, invited_by = ?, sent_at = ?, expires_at = ?
       WHERE id = ? AND project_id = ? RETURNING email, role`,
    )
    .bind(await sha256Hex(token), args.actorId, now, now + PROJECT_INVITATION_TTL_MS, args.invitationId, args.projectId)
    .first<{ email: string; role: ProjectRole }>();
  if (!row) {
    throw new ProjectShareError('That invitation was taken or cancelled.', 404);
  }
  return { email: row.email, token, role: row.role };
}

/** An invitation's link opened: what it is for, while it can still be taken. */
export type InvitationDescription = { projectName: string; inviterName: string; email: string; role: ProjectRole };

/** What the invitation with `token` is for, or null when it was taken, cancelled, expired or lapsed with its inviter. */
export async function describeInvitation(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<InvitationDescription | null> {
  const row = await validInvitation(db, { tokenHash: await sha256Hex(token) }, now);
  return row
    ? {
        projectName: row.project_name,
        inviterName: shownName(row.inviter_name ?? ''),
        email: row.email,
        role: row.role,
      }
    : null;
}

type InvitationRow = {
  id: string;
  project_id: string;
  email: string;
  role: ProjectRole;
  invited_by: string;
  project_name: string;
  inviter_name: string | null;
};

/** Invitations that can still be taken: unexpired, and their inviter still runs the project. */
async function validInvitations(
  db: D1Database,
  by: { tokenHash: string } | { email: string },
  now: number,
): Promise<InvitationRow[]> {
  const { results } = await db
    .prepare(
      `SELECT invitations.id, invitations.project_id, invitations.email, invitations.role, invitations.invited_by,
         projects.name AS project_name, inviter.name AS inviter_name
       FROM project_invitations AS invitations
       JOIN org_projects AS projects ON projects.id = invitations.project_id
       JOIN "user" AS inviter ON inviter.id = invitations.invited_by
       WHERE ${'tokenHash' in by ? 'invitations.token_hash = ?1' : 'invitations.email = ?1 COLLATE NOCASE'}
         AND invitations.expires_at > ?2 AND ${runsProjectSql('invitations.invited_by')}`,
    )
    .bind('tokenHash' in by ? by.tokenHash : by.email, now)
    .all<InvitationRow>();
  return results;
}

async function validInvitation(db: D1Database, by: { tokenHash: string }, now: number): Promise<InvitationRow | null> {
  return (await validInvitations(db, by, now))[0] ?? null;
}

/**
 * Takes the invitation with `token` for `userId`, who must have proven the address it was sent to. Answers the
 * project it shares. An address only reported by a Cloudflare login was never proven, so it takes nothing.
 */
export async function acceptInvitation(
  db: D1Database,
  args: { token: string; userId: string; now?: number },
): Promise<{ projectId: string }> {
  const now = args.now ?? Date.now();
  const invitation = await validInvitation(db, { tokenHash: await sha256Hex(args.token) }, now);
  if (!invitation) {
    throw new ProjectShareError('This invitation has been used, cancelled or has expired. Ask for a new one.', 410);
  }
  const user = await db
    .prepare('SELECT email, cloudflare_subject, email_proven_at FROM "user" WHERE id = ?')
    .bind(args.userId)
    .first<{ email: string; cloudflare_subject: string | null; email_proven_at: number | null }>();
  if (!user || normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
    throw new ProjectShareError(
      `This invitation is for ${invitation.email}. Sign in with that address to open it.`,
      403,
      'email_mismatch',
    );
  }
  if (user.cloudflare_subject !== null && user.email_proven_at === null) {
    throw new ProjectShareError('Confirm your email address to open this invitation.', 403, 'email_unproven');
  }
  await take(db, invitation, args.userId, now);
  return { projectId: invitation.project_id };
}

/**
 * Takes every invitation to `email` for `userId`, who has just proven it (signing in with Google or an emailed link,
 * or looking at their projects). How many it took.
 */
async function acceptInvitationsForEmail(
  db: D1Database,
  args: { userId: string; email: string; now?: number },
): Promise<number> {
  const now = args.now ?? Date.now();
  const invitations = await validInvitations(db, { email: normalizeEmail(args.email) }, now);
  for (const invitation of invitations) {
    await take(db, invitation, args.userId, now);
  }
  return invitations.length;
}

/**
 * The invitations taken for the person signed in: those to their address, once CloudChef has proven it is theirs. What
 * the projects home calls each time it lists their projects, so a project shared with their address shows at once.
 */
export async function acceptInvitationsForUser(db: D1Database, userId: string, now = Date.now()): Promise<number> {
  const user = await db
    .prepare(
      `SELECT email FROM "user" WHERE id = ? AND (cloudflare_subject IS NULL OR email_proven_at IS NOT NULL)
         AND EXISTS (SELECT 1 FROM project_invitations WHERE email = "user".email COLLATE NOCASE)`,
    )
    .bind(userId)
    .first<{ email: string }>();
  return user ? acceptInvitationsForEmail(db, { userId, email: user.email, now }) : 0;
}

/** An invitation becomes its taker's role, and is gone: in one batch, so a second taker finds nothing. */
async function take(db: D1Database, invitation: InvitationRow, userId: string, now: number): Promise<void> {
  if (await runs(db, invitation.project_id, userId)) {
    await db.prepare('DELETE FROM project_invitations WHERE id = ?').bind(invitation.id).run();
    return;
  }
  const project = await db
    .prepare('SELECT org_id FROM org_projects WHERE id = ?')
    .bind(invitation.project_id)
    .first<{ org_id: string | null }>();
  const member =
    project?.org_id &&
    (await db
      .prepare('SELECT 1 AS yes FROM organization_members WHERE org_id = ? AND user_id = ?')
      .bind(project.org_id, userId)
      .first());
  const deleted = await db
    .prepare('DELETE FROM project_invitations WHERE id = ? RETURNING id')
    .bind(invitation.id)
    .first();
  if (!deleted) {
    return;
  }
  // A team's member is given the role as one; anyone else as someone it is shared with. A share they had keeps when
  // it was first given, and takes the invitation's role.
  await db
    .prepare(
      member
        ? `INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
        : `INSERT INTO project_shares (project_id, user_id, role, shared_by, shared_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(invitation.project_id, userId, invitation.role, invitation.invited_by, now)
    .run();
}

/** The account that has proven `email`, if one has: one known only from a Cloudflare login hasn't. */
async function provenAccountOf(db: D1Database, email: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT id FROM "user" WHERE email = ? COLLATE NOCASE
         AND (cloudflare_subject IS NULL OR email_proven_at IS NOT NULL)`,
    )
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Tells `userId` in CloudChef that `actorId` shared the project with them. */
async function notifyShared(
  db: D1Database,
  args: { userId: string; actorId: string; project: Pick<Project, 'id' | 'name'>; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, user_id, kind, actor_id, post_id, project_id, detail, created_at)
       VALUES (?, ?, 'project_shared', ?, NULL, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), args.userId, args.actorId, args.project.id, args.project.name, args.now)
    .run();
}
