import { findMembership } from './organization-access.server';
import { OrganizationError, requireAdmin } from './organizations.server';

/** Where an organization's GitHub App is installed: the account whose repositories it may reach. */
type GitHubInstallationSummary = {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
};

/** A GitHub repository an organization works on, and (for admins) who may work on it. */
type OrgProject = {
  id: string;
  orgId: string;
  name: string;
  repoId: number;
  repoFullName: string;
  defaultBranch: string;
  /** 'promoted': created from a member's approved draft, and still to be connected to a pipeline. */
  origin: 'linked' | 'promoted';
  /** Members granted access. Admins work on every project, so they aren't listed. */
  memberIds: string[];
};

export async function findGitHubInstallation(db: D1Database, orgId: string): Promise<GitHubInstallationSummary | null> {
  const row = await db
    .prepare('SELECT installation_id, account_login, account_type FROM github_installations WHERE org_id = ?')
    .bind(orgId)
    .first<{ installation_id: number; account_login: string; account_type: 'User' | 'Organization' }>();
  return row
    ? { installationId: row.installation_id, accountLogin: row.account_login, accountType: row.account_type }
    : null;
}

export async function saveGitHubInstallation(
  db: D1Database,
  args: { orgId: string; userId: string; installation: GitHubInstallationSummary; now?: number },
): Promise<void> {
  const now = args.now ?? Date.now();
  await db
    .prepare(
      `INSERT INTO github_installations (org_id, installation_id, account_login, account_type, connected_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(org_id) DO UPDATE SET installation_id = ?2, account_login = ?3, account_type = ?4,
         connected_by = ?5, updated_at = ?6`,
    )
    .bind(
      args.orgId,
      args.installation.installationId,
      args.installation.accountLogin,
      args.installation.accountType,
      args.userId,
      now,
    )
    .run();
}

/** Disconnects GitHub. Linked projects stay listed but can't be opened until it's connected again. */
export async function removeGitHubInstallation(db: D1Database, orgId: string, actorId: string): Promise<void> {
  await requireAdmin(db, orgId, actorId);
  await db.prepare('DELETE FROM github_installations WHERE org_id = ?').bind(orgId).run();
}

type ProjectRow = {
  id: string;
  org_id: string;
  name: string;
  repo_id: number;
  repo_full_name: string;
  default_branch: string;
  origin: 'linked' | 'promoted';
};

const PROJECT_COLUMNS =
  'projects.id, projects.org_id, projects.name, projects.repo_id, projects.repo_full_name, projects.default_branch, projects.origin';

/** Every project of an organization with who may work on it: an admin's view. */
export async function listOrgProjects(db: D1Database, orgId: string): Promise<OrgProject[]> {
  const [{ results: projects }, { results: access }] = await Promise.all([
    db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects WHERE projects.org_id = ? ORDER BY projects.name`,
      )
      .bind(orgId)
      .all<ProjectRow>(),
    db
      .prepare(
        `SELECT access.project_id, access.user_id FROM org_project_access AS access
         JOIN org_projects AS projects ON projects.id = access.project_id
         WHERE projects.org_id = ?`,
      )
      .bind(orgId)
      .all<{ project_id: string; user_id: string }>(),
  ]);
  return projects.map((row) => ({
    ...toProject(row),
    memberIds: access.filter((grant) => grant.project_id === row.id).map((grant) => grant.user_id),
  }));
}

/**
 * The projects `userId` may work on in `orgId` right now: all of them for an active admin, the granted
 * ones for an active member, none while paused or outside the organization.
 */
export async function listAccessibleProjects(db: D1Database, orgId: string, userId: string): Promise<OrgProject[]> {
  const membership = await findMembership(db, orgId, userId);
  if (!membership || membership.pausedAt !== null) {
    return [];
  }
  const { results } = await (
    membership.role === 'admin'
      ? db
          .prepare(
            `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects WHERE projects.org_id = ? ORDER BY projects.name`,
          )
          .bind(orgId)
      : db
          .prepare(
            `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects
           JOIN org_project_access AS access ON access.project_id = projects.id AND access.user_id = ?
           WHERE projects.org_id = ? ORDER BY projects.name`,
          )
          .bind(userId, orgId)
  ).all<ProjectRow>();
  return results.map((row) => ({ ...toProject(row), memberIds: [] }));
}

/** One project, if `userId` may work on it now. Every runtime request for project files goes through this. */
export async function findAccessibleProject(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<OrgProject | null> {
  const row = await db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects WHERE projects.id = ?`)
    .bind(projectId)
    .first<ProjectRow>();
  if (!row) {
    return null;
  }
  const accessible = await listAccessibleProjects(db, row.org_id, userId);
  return accessible.find((project) => project.id === projectId) ?? null;
}

export async function linkProject(
  db: D1Database,
  args: {
    orgId: string;
    actorId: string;
    name: string;
    repository: { id: number; fullName: string; defaultBranch: string };
    now?: number;
  },
): Promise<string> {
  await requireAdmin(db, args.orgId, args.actorId);
  const id = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'linked', ?, ?)
       ON CONFLICT(org_id, repo_id) DO NOTHING`,
    )
    .bind(
      id,
      args.orgId,
      args.name,
      args.repository.id,
      args.repository.fullName,
      args.repository.defaultBranch,
      args.actorId,
      args.now ?? Date.now(),
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new OrganizationError(`${args.repository.fullName} is already a project here.`, 409);
  }
  return id;
}

export async function unlinkProject(db: D1Database, args: { orgId: string; actorId: string; projectId: string }) {
  await requireAdmin(db, args.orgId, args.actorId);
  await db.prepare('DELETE FROM org_projects WHERE id = ? AND org_id = ?').bind(args.projectId, args.orgId).run();
}

/** Grants or withdraws a member's access to one project. */
export async function setProjectAccess(
  db: D1Database,
  args: { orgId: string; actorId: string; projectId: string; userId: string; allowed: boolean; now?: number },
): Promise<void> {
  await requireAdmin(db, args.orgId, args.actorId);
  const project = await db
    .prepare('SELECT id FROM org_projects WHERE id = ? AND org_id = ?')
    .bind(args.projectId, args.orgId)
    .first<{ id: string }>();
  if (!project) {
    throw new OrganizationError('That project is not in this organization.', 404);
  }
  if (!args.allowed) {
    await db
      .prepare('DELETE FROM org_project_access WHERE project_id = ? AND user_id = ?')
      .bind(args.projectId, args.userId)
      .run();
    return;
  }
  if (!(await findMembership(db, args.orgId, args.userId))) {
    throw new OrganizationError('That person is not in this organization.', 404);
  }
  await db
    .prepare(
      `INSERT INTO org_project_access (project_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO NOTHING`,
    )
    .bind(args.projectId, args.userId, args.actorId, args.now ?? Date.now())
    .run();
}

function toProject(row: ProjectRow): Omit<OrgProject, 'memberIds'> {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    repoId: row.repo_id,
    repoFullName: row.repo_full_name,
    defaultBranch: row.default_branch,
    origin: row.origin,
  };
}

/** How long an approval may hold a request before another admin can take it over. */
const APPROVAL_CLAIM_MS = 10 * 60_000;

/** A request still open for a decision: waiting, or claimed by an approval that never finished. */
const OPEN_REQUEST = `(status = 'pending' OR (status = 'approving' AND claimed_at < ?))`;

/** A draft a member asked to make a real project, as an admin reviews it. */
type ProductionRequest = {
  id: string;
  title: string;
  note: string | null;
  previewUrl: string | null;
  files: number;
  requesterName: string;
  requesterEmail: string;
  createdAt: number;
};

/** One of a member's own production requests, with what was decided. */
type OwnProductionRequest = {
  id: string;
  title: string;
  status: 'pending' | 'approved' | 'declined';
  decisionNote: string | null;
};

/** The organization's requests waiting for an admin. */
export async function listPendingProductionRequests(db: D1Database, orgId: string): Promise<ProductionRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT requests.id, requests.title, requests.note, requests.preview_url, requests.snapshot_files,
              requests.created_at, users.name, users.email
       FROM production_requests AS requests
       JOIN "user" AS users ON users.id = requests.requested_by
       WHERE requests.org_id = ?
         AND (requests.status = 'pending' OR (requests.status = 'approving' AND requests.claimed_at < ?))
       ORDER BY requests.created_at`,
    )
    .bind(orgId, Date.now() - APPROVAL_CLAIM_MS)
    .all<{
      id: string;
      title: string;
      note: string | null;
      preview_url: string | null;
      snapshot_files: number;
      created_at: number;
      name: string;
      email: string;
    }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    note: row.note,
    previewUrl: row.preview_url,
    files: row.snapshot_files,
    requesterName: row.name,
    requesterEmail: row.email,
    createdAt: row.created_at,
  }));
}

/** A member's ten latest requests in an organization. */
export async function listOwnProductionRequests(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<OwnProductionRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, CASE status WHEN 'approving' THEN 'pending' ELSE status END AS status, decision_note
       FROM production_requests
       WHERE org_id = ? AND requested_by = ? ORDER BY created_at DESC LIMIT 10`,
    )
    .bind(orgId, userId)
    .all<{ id: string; title: string; status: 'pending' | 'approved' | 'declined'; decision_note: string | null }>();
  return results.map((row) => ({ id: row.id, title: row.title, status: row.status, decisionNote: row.decision_note }));
}

/** A request still waiting for a decision, with the draft's files, or null. */
export async function findPendingProductionRequest(db: D1Database, orgId: string, requestId: string) {
  const row = await db
    .prepare(
      `SELECT id, requested_by, title, snapshot_gzip_base64 FROM production_requests
       WHERE id = ? AND org_id = ? AND ${OPEN_REQUEST}`,
    )
    .bind(requestId, orgId, Date.now() - APPROVAL_CLAIM_MS)
    .first<{ id: string; requested_by: string; title: string; snapshot_gzip_base64: string }>();
  return row
    ? { id: row.id, requestedBy: row.requested_by, title: row.title, snapshot: row.snapshot_gzip_base64 }
    : null;
}

export async function declineProductionRequest(
  db: D1Database,
  args: { orgId: string; actorId: string; requestId: string; note: string; now?: number },
): Promise<void> {
  await requireAdmin(db, args.orgId, args.actorId);
  const declined = await db
    .prepare(
      `UPDATE production_requests SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ?,
         snapshot_gzip_base64 = ''
       WHERE id = ? AND org_id = ? AND ${OPEN_REQUEST}`,
    )
    .bind(
      args.actorId,
      args.now ?? Date.now(),
      args.note || null,
      args.requestId,
      args.orgId,
      (args.now ?? Date.now()) - APPROVAL_CLAIM_MS,
    )
    .run();
  if (declined.meta.changes !== 1) {
    throw new OrganizationError('That request was already decided.', 409);
  }
}

/** Marks a pending request as being approved; false when someone else already is (or it was decided). */
export async function claimProductionRequest(db: D1Database, requestId: string): Promise<boolean> {
  const claimed = await db
    .prepare(`UPDATE production_requests SET status = 'approving', claimed_at = ? WHERE id = ? AND ${OPEN_REQUEST}`)
    .bind(Date.now(), requestId, Date.now() - APPROVAL_CLAIM_MS)
    .run();
  return claimed.meta.changes === 1;
}

/** Hands a request back to pending after an approval that didn't finish. */
export async function releaseProductionRequest(db: D1Database, requestId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE production_requests SET status = 'pending', claimed_at = NULL WHERE id = ? AND status = 'approving'`,
    )
    .bind(requestId)
    .run();
}

/**
 * Records an approved request: its new repository becomes an organization project its requester may work
 * on, and the request keeps only the decision (the draft's files now live in GitHub).
 */
export async function recordApprovedRequest(
  db: D1Database,
  args: {
    orgId: string;
    actorId: string;
    requestId: string;
    requestedBy: string;
    name: string;
    repository: { id: number; fullName: string; defaultBranch: string };
    now?: number;
  },
): Promise<string> {
  const now = args.now ?? Date.now();
  const projectId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'promoted', ?, ?)`,
      )
      .bind(
        projectId,
        args.orgId,
        args.name,
        args.repository.id,
        args.repository.fullName,
        args.repository.defaultBranch,
        args.actorId,
        now,
      ),
    db
      .prepare(
        `INSERT INTO org_project_access (project_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, user_id) DO NOTHING`,
      )
      .bind(projectId, args.requestedBy, args.actorId, now),
    db
      .prepare(
        `UPDATE production_requests SET status = 'approved', project_id = ?, decided_by = ?, decided_at = ?,
           snapshot_gzip_base64 = ''
         WHERE id = ? AND org_id = ? AND status = 'approving'`,
      )
      .bind(projectId, args.actorId, now, args.requestId, args.orgId),
  ]);
  return projectId;
}
