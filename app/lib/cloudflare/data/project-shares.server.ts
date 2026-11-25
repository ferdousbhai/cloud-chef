import { shownName } from '~/lib/shown-name';
import { normalizeEmail } from '~/lib/.server/auth';
import { bytesToBase64Url, sha256Hex } from '~/lib/hex-digest';
import type { Project, ProjectRole } from './org-projects.server';

/**
 * Sharing a project with people, as a document is shared: by username, which finds that person, or by email
 * address, which always makes an invitation, so the person sharing never learns whether an address has a
 * CloudChef account. Whoever runs the project (its owner, or another admin of its space) shares it.
 *
 * There is one way to be on someone else's project: added to it, with a role on it (`org_project_access`), in the
 * Cloudflare account the project lives in. Being added makes the person one of that account's space
 * (`organization_members`, never an admin, and with no apps of their own there), which is what lets their workspace
 * run in it; losing their last project there takes them out of it again.
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
  /** `owner`: runs it (its owner, or another admin of its space); otherwise what they may do. */
  role: 'owner' | ProjectRole;
};

export type SharingInvitation = { id: string; email: string; role: ProjectRole; sentAt: number; expiresAt: number };

/**
 * Whether `?{n}`, the user, runs the project in `projects`: an active admin of its space, which its owner is.
 */
function runsProjectSql(user: string): string {
  return `EXISTS (
      SELECT 1 FROM organization_members AS admins
      WHERE admins.org_id = projects.org_id AND admins.user_id = ${user} AND admins.role = 'admin'
        AND admins.paused_at IS NULL)`;
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
        `SELECT person.id, person.name, person.username, person.image, chosen.role FROM (
           SELECT user_id, 'owner' AS role, 0 AS sort, joined_at AS since FROM organization_members
             WHERE org_id = ?2 AND role = 'admin' AND paused_at IS NULL
           UNION ALL
           SELECT access.user_id, access.role, 1, access.granted_at FROM org_project_access AS access
             JOIN organization_members AS members ON members.org_id = ?2 AND members.user_id = access.user_id
             WHERE access.project_id = ?1 AND members.role = 'member' AND members.paused_at IS NULL
         ) AS chosen JOIN "user" AS person ON person.id = chosen.user_id
         ORDER BY chosen.sort, chosen.since`,
      )
      .bind(project.id, project.orgId)
      .all<{
        id: string;
        name: string | null;
        username: string | null;
        image: string | null;
        role: SharingPerson['role'];
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
 * proven that address is also told in CloudChef, and takes it the next time it looks. Someone already working in the
 * project's account is given the role at once, whichever way they are named.
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
  await grant(db, { projectId: args.project.id, userId: person.id, role: args.role, by: args.actorId, now });
  await notifyShared(db, { userId: person.id, actorId: args.actorId, project: args.project, now });
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
  // Whoever runs a project already sees the addresses of the people working in its account: one of them is given
  // the role at once.
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
      await grant(db, {
        projectId: args.project.id,
        userId: member.user_id,
        role: args.role,
        by: args.actorId,
        now: args.now,
      });
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
 * Gives `userId` the role on the project, in the name of `by`, who runs it. It makes them one of the project's space
 * if they weren't: someone who works there only on the projects they are given, which is what lets their workspace
 * run in its account. Someone paused there is working again, since whoever runs the project just chose them (never
 * an admin who was paused, whom sharing one project must not put back in charge of the account). A role they already
 * had keeps when it was first given.
 */
async function grant(
  db: D1Database,
  args: { projectId: string; userId: string; role: ProjectRole; by: string; now: number },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO organization_members (org_id, user_id, role, joined_at, drafts_allowed)
         SELECT org_id, ?2, 'member', ?3, 0 FROM org_projects WHERE id = ?1 AND org_id IS NOT NULL
         ON CONFLICT (org_id, user_id) DO UPDATE SET paused_at = NULL WHERE organization_members.role = 'member'`,
      )
      .bind(args.projectId, args.userId, args.now),
    db
      .prepare(
        `INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`,
      )
      .bind(args.projectId, args.userId, args.role, args.by, args.now),
  ]);
}

/** Whether `userId` runs the project: its owner, or another active admin of its space. */
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
 * Changes what someone added to the project may do, or (null) takes them off it, which stops their workspace at its
 * next call to CloudChef. Taken off the last project they had in its account, they leave that account's space too,
 * unless they build apps of their own there: nothing is left for them to open in it. Their workspace there, with its
 * chats, is kept in the account, and is theirs again if they are added back.
 */
export async function setPersonRole(
  db: D1Database,
  args: { project: Project; actorId: string; userId: string; role: ProjectRole | null },
): Promise<void> {
  const member = await db
    .prepare('SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?')
    .bind(args.project.orgId, args.userId)
    .first<{ role: string }>();
  if (member?.role === 'admin') {
    throw new ProjectShareError('Whoever runs the account runs every project in it.', 409);
  }
  if (args.role !== null) {
    const changed = await db
      .prepare('UPDATE org_project_access SET role = ?, granted_by = ? WHERE project_id = ? AND user_id = ?')
      .bind(args.role, args.actorId, args.project.id, args.userId)
      .run();
    if (changed.meta.changes === 0) {
      throw new ProjectShareError('This project isn’t shared with them.', 404);
    }
    return;
  }
  // Each later write happens only once they have no project left there and build nothing of their own, so someone
  // still on another project keeps their place, and a role given back meanwhile keeps it too.
  const left = `NOT EXISTS (
      SELECT 1 FROM org_project_access AS access JOIN org_projects AS projects ON projects.id = access.project_id
      WHERE projects.org_id = ?1 AND access.user_id = ?2)`;
  const gone = 'NOT EXISTS (SELECT 1 FROM organization_members WHERE org_id = ?1 AND user_id = ?2)';
  await db.batch([
    db
      .prepare('DELETE FROM org_project_access WHERE project_id = ? AND user_id = ?')
      .bind(args.project.id, args.userId),
    db
      .prepare(
        `DELETE FROM organization_members
         WHERE org_id = ?1 AND user_id = ?2 AND role = 'member' AND drafts_allowed = 0 AND ${left}`,
      )
      .bind(args.project.orgId, args.userId),
    db
      .prepare(
        `DELETE FROM user_computer_runtimes
         WHERE user_id = ?2 AND connection_id IN (SELECT id FROM cloudflare_connections WHERE org_id = ?1) AND ${gone}`,
      )
      .bind(args.project.orgId, args.userId),
  ]);
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
  connection_id: string;
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
         projects.connection_id, projects.name AS project_name, inviter.name AS inviter_name
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
 * project it shares and the account it is in. An address only reported by a Cloudflare login was never proven, so it
 * takes nothing.
 */
export async function acceptInvitation(
  db: D1Database,
  args: { token: string; userId: string; now?: number },
): Promise<{ projectId: string; connectionId: string }> {
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
  return { projectId: invitation.project_id, connectionId: invitation.connection_id };
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

/** An invitation becomes its taker's role, and is gone first, so a second taker finds nothing. */
async function take(db: D1Database, invitation: InvitationRow, userId: string, now: number): Promise<void> {
  if (await runs(db, invitation.project_id, userId)) {
    await db.prepare('DELETE FROM project_invitations WHERE id = ?').bind(invitation.id).run();
    return;
  }
  const deleted = await db
    .prepare('DELETE FROM project_invitations WHERE id = ? RETURNING id')
    .bind(invitation.id)
    .first();
  if (!deleted) {
    return;
  }
  await grant(db, {
    projectId: invitation.project_id,
    userId,
    role: invitation.role,
    by: invitation.invited_by,
    now,
  });
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
