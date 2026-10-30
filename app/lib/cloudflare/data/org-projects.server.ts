import {
  findCloudflareConnectionForOrganization,
  findCloudflareConnectionForUser,
} from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { OrganizationError, requireAdmin } from './organizations.server';

/** One GitHub account a connection's GitHub App is installed on, whose repositories it may import. */
type GitHubInstallationSummary = {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
};

/** What a person may do with a project: read its history and code, or also change it. */
export type ProjectRole = 'view' | 'edit';

/**
 * Whose projects: a team's, run by its admins, or a person's own, run by them. A project lives in the
 * scope's Cloudflare account, its code in that account's Artifacts.
 */
export type ProjectScope = { connectionId: string; orgId: string | null };

/**
 * A project: an Artifacts repository in the account of the connection it belongs to, and where it was
 * imported from on GitHub, if it was.
 */
export type ProjectCreatedFrom = 'github' | 'zip' | 'draft' | 'copy' | 'push';

export type Project = {
  id: string;
  connectionId: string;
  /** The team whose project it is; null for a person's own. */
  orgId: string | null;
  name: string;
  /** The Artifacts repository in the `cloudchef` namespace; null until it has been imported. */
  repo: string | null;
  defaultBranch: string;
  /** What it was made from: a GitHub import, a ZIP upload, or a team member's draft an admin approved. */
  createdFrom: ProjectCreatedFrom;
  /** The GitHub repository it was (or is still to be) imported from; null unless made from GitHub. */
  importSource: { repoId: number | null; fullName: string; branch: string } | null;
  workersBuildsScriptTag: string | null;
  /** The live site's address, once its Worker has been found. */
  siteUrl: string | null;
  /** Whether the live site lets CloudChef show it in a frame; null until checked. */
  siteFrameable: boolean | null;
  /** Who builds and deploys it: Workers Builds watching its repository, or CloudChef itself (an upload). */
  deploysWith: 'workers_builds' | 'cloudchef';
  /** The Worker CloudChef deploys it as, once known. */
  deployWorkerName: string | null;
  /** `<author's username>/<slug>`, its address (cloudchef.build/<fullName>.git); null until its author has a username. */
  fullName: string | null;
  /** Public: anyone signed in finds it in Explore, opens its site, reads and copies its code. */
  visibility: ProjectVisibility;
  /** The project it is a copy of, while that one is still here. */
  copiedFrom: string | null;
  /** Who made it, its author: the owner in its address. */
  createdBy: string | null;
  createdAt: number;
};

export type ProjectVisibility = 'private' | 'public';

/** A team project as its admins manage it: who else may view or edit it. */
type ManagedProject = Project & { access: { userId: string; role: ProjectRole }[] };

/**
 * The scope `userId` manages: the team `orgId` when they are one of its active admins, else their own
 * account. Either needs its Cloudflare connection, where the projects live. Throws otherwise.
 */
export async function requireProjectScope(
  db: D1Database,
  userId: string,
  orgId: string | undefined,
): Promise<ProjectScope> {
  if (orgId) {
    await requireAdmin(db, orgId, userId);
  }
  const connection = orgId
    ? await findCloudflareConnectionForOrganization(db, orgId)
    : await findCloudflareConnectionForUser(db, userId);
  if (connection?.status !== 'active') {
    throw new OrganizationError(
      orgId ? "Connect the team's Cloudflare account first." : 'Connect your Cloudflare account first.',
      409,
    );
  }
  return { connectionId: connection.id, orgId: orgId ?? null };
}

/** The GitHub accounts a connection's GitHub App is installed on, by account name. */
export async function listGitHubInstallations(
  db: D1Database,
  connectionId: string,
): Promise<GitHubInstallationSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT installation_id, account_login, account_type FROM github_installations WHERE connection_id = ?
       ORDER BY account_login COLLATE NOCASE`,
    )
    .bind(connectionId)
    .all<{ installation_id: number; account_login: string; account_type: 'User' | 'Organization' }>();
  return results.map((row) => ({
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type,
  }));
}

/**
 * The App's installations on a GitHub user's own account that `userId` connected to another of their accounts
 * (Personal, or a team) and not yet to `connectionId`: a GitHub account they proved theirs there, which they may
 * connect here too once GitHub confirms it's them again.
 */
export async function listReusableGitHubInstallations(
  db: D1Database,
  args: { userId: string; connectionId: string },
): Promise<GitHubInstallationSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT installation_id, MIN(account_login) AS account_login FROM github_installations
       WHERE connected_by = ?1 AND account_type = 'User' AND connection_id != ?2
         AND installation_id NOT IN (SELECT installation_id FROM github_installations WHERE connection_id = ?2)
       GROUP BY installation_id ORDER BY account_login COLLATE NOCASE`,
    )
    .bind(args.userId, args.connectionId)
    .all<{ installation_id: number; account_login: string }>();
  return results.map((row) => ({
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: 'User',
  }));
}

/** Records an installation for the scope, alongside any on other GitHub accounts. */
export async function saveGitHubInstallation(
  db: D1Database,
  args: { scope: ProjectScope; userId: string; installation: GitHubInstallationSummary },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO github_installations (connection_id, installation_id, account_login, account_type, connected_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(connection_id, installation_id) DO UPDATE SET account_login = ?3, account_type = ?4,
         connected_by = ?5, updated_at = ?6`,
    )
    .bind(
      args.scope.connectionId,
      args.installation.installationId,
      args.installation.accountLogin,
      args.installation.accountType,
      args.userId,
      now,
    )
    .run();
}

/**
 * Disconnects one GitHub account. Projects already imported are unaffected; ones still to be imported from it
 * wait for it.
 */
export async function removeGitHubInstallation(
  db: D1Database,
  scope: ProjectScope,
  installationId: number,
): Promise<void> {
  await db
    .prepare('DELETE FROM github_installations WHERE connection_id = ? AND installation_id = ?')
    .bind(scope.connectionId, installationId)
    .run();
}

type ProjectRow = {
  id: string;
  connection_id: string;
  org_id: string | null;
  name: string;
  import_repo_id: number | null;
  import_repo_full_name: string | null;
  import_branch: string | null;
  artifact_repo: string | null;
  workers_builds_script_tag: string | null;
  site_url: string | null;
  site_frameable: number | null;
  deploys_with: 'workers_builds' | 'cloudchef';
  deploy_worker_name: string | null;
  default_branch: string;
  created_from: ProjectCreatedFrom;
  slug: string | null;
  owner_username: string | null;
  visibility: ProjectVisibility;
  copied_from: string | null;
  created_by: string | null;
  created_at: number;
};

const PROJECT_COLUMNS = `projects.id, projects.connection_id, projects.org_id, projects.name, projects.import_repo_id,
  projects.import_repo_full_name, projects.import_branch, projects.artifact_repo, projects.workers_builds_script_tag,
  projects.site_url, projects.site_frameable, projects.default_branch, projects.created_from,
  projects.deploys_with, projects.deploy_worker_name, projects.slug, projects.visibility, projects.copied_from,
  projects.created_by, projects.created_at,
  (SELECT username FROM "user" WHERE "user".id = projects.created_by) AS owner_username`;

/**
 * The project of an account whose repository `repo` is, if any: an app's own repository is one once an admin
 * approved the app as a draft, which adopts the repository as it is.
 */
export async function findProjectOfRepository(
  db: D1Database,
  connectionId: string,
  repo: string,
): Promise<Project | null> {
  const row = await db
    .prepare(
      `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects
       WHERE projects.connection_id = ? AND projects.artifact_repo = ?`,
    )
    .bind(connectionId, repo)
    .first<ProjectRow>();
  return row ? toProject(row) : null;
}

/** Every project of a scope, with who else may view or edit it: an admin's or owner's view. */
export async function listScopeProjects(db: D1Database, scope: ProjectScope): Promise<ManagedProject[]> {
  const [{ results: projects }, { results: access }] = await Promise.all([
    db
      .prepare(
        `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects WHERE projects.connection_id = ? ORDER BY projects.name`,
      )
      .bind(scope.connectionId)
      .all<ProjectRow>(),
    db
      .prepare(
        `SELECT access.project_id, access.user_id, access.role FROM org_project_access AS access
         JOIN org_projects AS projects ON projects.id = access.project_id
         WHERE projects.connection_id = ?`,
      )
      .bind(scope.connectionId)
      .all<{ project_id: string; user_id: string; role: ProjectRole }>(),
  ]);
  return projects.map((row) => ({
    ...toProject(row),
    access: access
      .filter((grant) => grant.project_id === row.id)
      .map((grant) => ({ userId: grant.user_id, role: grant.role })),
  }));
}

/**
 * A role for `userId` on the project in `projects`, as `findAccessibleProject` decides it: edit for a
 * person's own project and for an active admin of the team's, the granted role for an active member, and
 * none (NULL) while paused or outside the team. `?2` is the user.
 */
const ROLE = `CASE
  WHEN projects.org_id IS NULL THEN
    CASE WHEN EXISTS (
      SELECT 1 FROM cloudflare_connections AS owner WHERE owner.id = projects.connection_id AND owner.user_id = ?2
    ) THEN 'edit' END
  ELSE (
    SELECT CASE WHEN members.role = 'admin' THEN 'edit' ELSE (
      SELECT access.role FROM org_project_access AS access
      WHERE access.project_id = projects.id AND access.user_id = ?2
    ) END
    FROM organization_members AS members
    WHERE members.org_id = projects.org_id AND members.user_id = ?2 AND members.paused_at IS NULL
  )
END`;

/** The projects of the connection `connectionId` that `userId` may view or edit now, with their role. */
export async function listAccessibleProjects(
  db: D1Database,
  connectionId: string,
  userId: string,
): Promise<(Project & { role: ProjectRole })[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT ${PROJECT_COLUMNS}, ${ROLE} AS role FROM org_projects AS projects WHERE projects.connection_id = ?1
       ) WHERE role IS NOT NULL ORDER BY name`,
    )
    .bind(connectionId, userId)
    .all<ProjectRow & { role: ProjectRole }>();
  return results.map((row) => ({ ...toProject(row), role: row.role }));
}

/** One project with `userId`'s role on it, if they may view or edit it now. Every runtime project call asks this. */
export async function findAccessibleProject(
  db: D1Database,
  projectId: string,
  userId: string,
): Promise<(Project & { role: ProjectRole }) | null> {
  const row = await db
    .prepare(
      `SELECT * FROM (
         SELECT ${PROJECT_COLUMNS}, ${ROLE} AS role FROM org_projects AS projects WHERE projects.id = ?1
       ) WHERE role IS NOT NULL`,
    )
    .bind(projectId, userId)
    .first<ProjectRow & { role: ProjectRole }>();
  return row ? { ...toProject(row), role: row.role } : null;
}

/** A project's name in addresses (`<username>/<slug>`): lowercase letters, digits and single dashes. */
function projectSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'project'
  );
}

/**
 * The address name for a new project or app of `authorId` called `name`: its slug, or with -2, -3… when one of
 * their projects or apps has it.
 */
export async function freeSlug(db: D1Database, authorId: string, name: string): Promise<string> {
  const slug = projectSlug(name);
  const { results } = await db
    .prepare(
      `SELECT slug FROM org_projects WHERE created_by = ?1 AND (slug = ?2 OR slug LIKE ?2 || '-%')
       UNION SELECT slug FROM apps WHERE user_id = ?1 AND (slug = ?2 OR slug LIKE ?2 || '-%')`,
    )
    .bind(authorId, slug)
    .all<{ slug: string }>();
  const taken = new Set(results.map((row) => row.slug));
  let candidate = slug;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${slug}-${suffix}`;
  }
  return candidate;
}

/**
 * A project `userId` may read: one they may view or edit, with that role, or else a public one, which anyone signed
 * in may read (`public`: no role of theirs, so nothing they may change).
 */
export async function findReadableProject(
  db: D1Database,
  ref: { id: string } | { owner: string; slug: string },
  userId: string,
): Promise<(Project & { role: ProjectRole | 'public' }) | null> {
  const accessible =
    'id' in ref
      ? await findAccessibleProject(db, ref.id, userId)
      : await findAccessibleProjectByFullName(db, ref, userId);
  if (accessible) {
    return accessible;
  }
  const row = await db
    .prepare(
      'id' in ref
        ? `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects WHERE projects.id = ?1 AND projects.visibility = 'public'`
        : `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects WHERE projects.slug = ?2 AND projects.visibility = 'public'
             AND projects.created_by = (SELECT id FROM "user" WHERE username = ?1)`,
    )
    .bind(...('id' in ref ? [ref.id] : [ref.owner, ref.slug]))
    .first<ProjectRow>();
  return row ? { ...toProject(row), role: 'public' } : null;
}

/** Public projects, newest first, with their author's name: what Explore shows. */
export async function listPublicProjects(
  db: D1Database,
  limit = 60,
): Promise<(Project & { authorName: string | null; copiedFromFullName: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PROJECT_COLUMNS},
         (SELECT name FROM "user" WHERE "user".id = projects.created_by) AS author_name,
         (SELECT (SELECT username FROM "user" WHERE "user".id = source.created_by) || '/' || source.slug
            FROM org_projects AS source WHERE source.id = projects.copied_from) AS copied_from_full_name
       FROM org_projects AS projects
       WHERE projects.visibility = 'public' AND projects.artifact_repo IS NOT NULL
       ORDER BY projects.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<ProjectRow & { author_name: string | null; copied_from_full_name: string | null }>();
  return results.map((row) => ({
    ...toProject(row),
    authorName: row.author_name,
    copiedFromFullName: row.copied_from_full_name,
  }));
}

/** Makes one of the projects `userId` manages public or private; false when they don't manage it. */
export async function setProjectVisibility(
  db: D1Database,
  args: { userId: string; projectId: string; visibility: ProjectVisibility },
): Promise<boolean> {
  let project: Project;
  try {
    project = await requireManagedProject(db, args.userId, args.projectId);
  } catch (error) {
    if (error instanceof OrganizationError) {
      return false;
    }
    throw error;
  }
  await db.prepare('UPDATE org_projects SET visibility = ? WHERE id = ?').bind(args.visibility, project.id).run();
  return true;
}

/** The project `<username>/<slug>` with `userId`'s role on it, if they may view or edit it now. */
async function findAccessibleProjectByFullName(
  db: D1Database,
  fullName: { owner: string; slug: string },
  userId: string,
): Promise<(Project & { role: ProjectRole }) | null> {
  const row = await db
    .prepare(
      `SELECT * FROM (
         SELECT ${PROJECT_COLUMNS}, ${ROLE.replaceAll('?2', '?3')} AS role FROM org_projects AS projects
         WHERE projects.slug = ?2 AND projects.created_by = (SELECT id FROM "user" WHERE username = ?1)
       ) WHERE role IS NOT NULL`,
    )
    .bind(fullName.owner, fullName.slug, userId)
    .first<ProjectRow & { role: ProjectRole }>();
  return row ? { ...toProject(row), role: row.role } : null;
}

/**
 * A project imported from GitHub, to be imported into Artifacts by the first member who opens it.
 * Returns its id; refused when the repository is a project of the scope already.
 */
export async function importProject(
  db: D1Database,
  args: {
    scope: ProjectScope;
    actorId: string;
    name: string;
    source: { repoId: number | null; fullName: string; branch: string };
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT INTO org_projects (id, connection_id, org_id, name, slug, import_repo_id, import_repo_full_name,
         import_branch, created_from, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'github', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      id,
      args.scope.connectionId,
      args.scope.orgId,
      args.name,
      await freeSlug(db, args.actorId, args.name),
      args.source.repoId,
      args.source.fullName,
      args.source.branch,
      args.actorId,
      Date.now(),
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new OrganizationError(`${args.source.fullName} is already a project here.`, 409);
  }
  return id;
}

/**
 * A project whose code was uploaded as a ZIP: the runtime has written it to its Artifacts repository already,
 * so it is recorded with that repository and no source. Refused when the id is taken.
 */
export async function addUploadedProject(
  db: D1Database,
  args: {
    scope: ProjectScope;
    actorId: string;
    projectId: string;
    name: string;
    repo: string;
    /** For a copy, the project it copies; null otherwise. */
    copiedFrom: string | null;
    createdFrom: Extract<ProjectCreatedFrom, 'zip' | 'copy' | 'push'>;
  },
): Promise<void> {
  const inserted = await db
    .prepare(
      `INSERT INTO org_projects (id, connection_id, org_id, name, slug, artifact_repo, created_from, copied_from,
         deploys_with, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cloudchef', ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      args.projectId,
      args.scope.connectionId,
      args.scope.orgId,
      args.name,
      await freeSlug(db, args.actorId, args.name),
      args.repo,
      args.createdFrom,
      args.copiedFrom,
      args.actorId,
      Date.now(),
    )
    .run();
  if (inserted.meta.changes !== 1) {
    throw new OrganizationError('That project is here already.', 409);
  }
}

/** Deletes a project's record, once its repository and resources are gone; access grants and deployments go with it. */
export async function deleteProjectRecord(db: D1Database, projectId: string): Promise<void> {
  await db.prepare('DELETE FROM org_projects WHERE id = ?').bind(projectId).run();
}

/** Removes a project from CloudChef. Its Artifacts repository and its Worker stay in the account. */
export async function removeProject(db: D1Database, args: { scope: ProjectScope; projectId: string }) {
  await db
    .prepare('DELETE FROM org_projects WHERE id = ? AND connection_id = ?')
    .bind(args.projectId, args.scope.connectionId)
    .run();
}

/**
 * The project `projectId`, for the person who runs it: its owner for a person's own, an active admin of its
 * team for a team's. Throws otherwise.
 */
export async function requireManagedProject(db: D1Database, userId: string, projectId: string): Promise<Project> {
  const row = await db
    .prepare(
      `SELECT ${PROJECT_COLUMNS} FROM org_projects AS projects
       WHERE projects.id = ?1 AND (
         (projects.org_id IS NULL AND EXISTS (
           SELECT 1 FROM cloudflare_connections AS owner WHERE owner.id = projects.connection_id AND owner.user_id = ?2))
         OR EXISTS (
           SELECT 1 FROM organization_members AS members
           WHERE members.org_id = projects.org_id AND members.user_id = ?2 AND members.role = 'admin'
             AND members.paused_at IS NULL))`,
    )
    .bind(projectId, userId)
    .first<ProjectRow>();
  if (!row) {
    throw new OrganizationError("That project isn't yours to change.", 404);
  }
  return toProject(row);
}

/** A replacement of a project's main by the person who runs it: who, from which branch, and main's commit before and after. */
type MainRewrite = {
  projectId: string;
  userId: string;
  branch: string;
  oldCommit: string;
  newCommit: string;
  rewrittenAt: number;
};

/** Keeps a record that `userId` replaced the project's main (`cloudchef repo rewrite-main`). */
export async function recordMainRewrite(db: D1Database, rewrite: MainRewrite): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_main_rewrites (id, project_id, rewritten_by, branch, old_commit, new_commit, rewritten_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      rewrite.projectId,
      rewrite.userId,
      rewrite.branch,
      rewrite.oldCommit,
      rewrite.newCommit,
      rewrite.rewrittenAt,
    )
    .run();
}

/** A push to a team project's main, as a member's runtime passed it on: who, when, and main's commit before (null for its first) and after. */
type MainPush = {
  projectId: string;
  userId: string;
  oldCommit: string | null;
  newCommit: string;
  pushedAt: number;
};

/** Keeps a record that `userId` pushed the project's main from `oldCommit` to `newCommit`. */
export async function recordMainPush(db: D1Database, push: MainPush): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_main_pushes (id, project_id, pushed_by, old_commit, new_commit, pushed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), push.projectId, push.userId, push.oldCommit, push.newCommit, push.pushedAt)
    .run();
}

/**
 * Who last changed each project's main and when, by project id: its newest recorded push, or rewrite
 * (`cloudchef repo rewrite-main`). The name is null for someone no longer on CloudChef; a project with neither
 * recorded isn't in it.
 */
export async function latestMainChanges(
  db: D1Database,
  projectIds: readonly string[],
): Promise<Map<string, { by: string | null; at: number }>> {
  const latest = new Map<string, { by: string | null; at: number }>();
  if (projectIds.length === 0) {
    return latest;
  }
  const { results } = await db
    .prepare(
      `WITH changes AS (
         SELECT project_id, pushed_by AS changed_by, pushed_at AS changed_at FROM project_main_pushes
         WHERE project_id IN (SELECT value FROM json_each(?1))
         UNION ALL
         SELECT project_id, rewritten_by, rewritten_at FROM project_main_rewrites
         WHERE project_id IN (SELECT value FROM json_each(?1))
       ),
       newest AS (
         SELECT project_id, changed_by, changed_at,
           ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY changed_at DESC) AS position
         FROM changes
       )
       SELECT newest.project_id, newest.changed_at, people.name
       FROM newest LEFT JOIN "user" AS people ON people.id = newest.changed_by
       WHERE newest.position = 1`,
    )
    .bind(JSON.stringify(projectIds))
    .all<{ project_id: string; changed_at: number; name: string | null }>();
  for (const row of results) {
    latest.set(row.project_id, { by: row.name, at: row.changed_at });
  }
  return latest;
}

/**
 * One change of a project's main: a push (`project_main_pushes`, from a workspace, a person's own computer, or a
 * `rewrite-main` of a branch that only added to main) or a rewrite (`project_main_rewrites`). `by` is null for
 * someone no longer on CloudChef; `oldCommit` is null for main's first push; `branch` is the rewrite's, null for a push.
 */
export type MainChange = {
  kind: 'push' | 'rewrite';
  by: { id: string; name: string } | null;
  oldCommit: string | null;
  newCommit: string;
  branch: string | null;
  at: number;
};

/**
 * The project's changes of main, newest first: who pushed or rewrote it, from and to which commit, and when, whoever
 * publishes it (Workers Builds reads main by itself, so for its projects this is the only record of who published).
 * At most `limit`; with `before`, only changes made before that time, for the next page.
 */
export async function listMainChanges(
  db: D1Database,
  projectId: string,
  options: { limit: number; before?: number },
): Promise<MainChange[]> {
  const { results } = await db
    .prepare(
      `SELECT changes.*, people.name FROM (
         SELECT 'push' AS kind, pushed_by AS changed_by, old_commit, new_commit, NULL AS branch, pushed_at AS changed_at
         FROM project_main_pushes WHERE project_id = ?1 AND pushed_at < ?2
         UNION ALL
         SELECT 'rewrite', rewritten_by, old_commit, new_commit, branch, rewritten_at
         FROM project_main_rewrites WHERE project_id = ?1 AND rewritten_at < ?2
       ) AS changes
       LEFT JOIN "user" AS people ON people.id = changes.changed_by
       ORDER BY changes.changed_at DESC LIMIT ?3`,
    )
    .bind(projectId, options.before ?? Number.MAX_SAFE_INTEGER, Math.max(0, Math.min(options.limit, 500)))
    .all<{
      kind: 'push' | 'rewrite';
      changed_by: string | null;
      old_commit: string | null;
      new_commit: string;
      branch: string | null;
      changed_at: number;
      name: string | null;
    }>();
  return results.map((row) => ({
    kind: row.kind,
    by: row.changed_by && row.name !== null ? { id: row.changed_by, name: row.name } : null,
    oldCommit: row.old_commit,
    newCommit: row.new_commit,
    branch: row.branch,
    at: row.changed_at,
  }));
}

/** Gives a team member a role on one project, changes it, or (null) withdraws it. */
export async function setProjectAccess(
  db: D1Database,
  args: { orgId: string; actorId: string; projectId: string; userId: string; role: ProjectRole | null },
): Promise<void> {
  await requireAdmin(db, args.orgId, args.actorId);
  const project = await db
    .prepare('SELECT id FROM org_projects WHERE id = ? AND org_id = ?')
    .bind(args.projectId, args.orgId)
    .first<{ id: string }>();
  if (!project) {
    throw new OrganizationError('That project is not in this team.', 404);
  }
  if (args.role === null) {
    await db
      .prepare('DELETE FROM org_project_access WHERE project_id = ? AND user_id = ?')
      .bind(args.projectId, args.userId)
      .run();
    return;
  }
  // Granted only while they are a member, in the one statement, so a removal racing it leaves no grant
  // behind. A grant they had keeps when it was first given.
  const granted = await db
    .prepare(
      `INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM organization_members WHERE org_id = ?6 AND user_id = ?2)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`,
    )
    .bind(args.projectId, args.userId, args.role, args.actorId, Date.now(), args.orgId)
    .run();
  if (granted.meta.changes === 0) {
    throw new OrganizationError('That person is not in this team.', 404);
  }
}

/**
 * Records the Artifacts repository an imported project now lives in. The same repository again is a
 * no-op; a different one than already recorded is refused (false).
 */
export async function recordImportedRepo(db: D1Database, projectId: string, repo: string): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE org_projects SET artifact_repo = COALESCE(artifact_repo, ?2)
       WHERE id = ?1
       RETURNING artifact_repo`,
    )
    .bind(projectId, repo)
    .first<{ artifact_repo: string }>();
  return row?.artifact_repo === repo;
}

/** How long after registering an import its importer may still take it back. */
const ABANDON_IMPORT_WINDOW_MS = 60 * 60_000;

/**
 * Takes back an import its importer just registered, in the connection they register from, whose code can
 * never be copied, so importing the address again starts afresh. Only theirs, only an import made within the
 * hour, and only while it has no repository.
 */
export async function abandonImport(
  db: D1Database,
  args: { projectId: string; userId: string; connectionId: string },
): Promise<boolean> {
  const removed = await db
    .prepare(
      `DELETE FROM org_projects
       WHERE id = ? AND created_by = ? AND connection_id = ? AND created_from = 'github' AND artifact_repo IS NULL
         AND created_at > ?`,
    )
    .bind(args.projectId, args.userId, args.connectionId, Date.now() - ABANDON_IMPORT_WINDOW_MS)
    .run();
  if (removed.meta.changes === 1) {
    return true;
  }
  // Asked again after an answer that never arrived: a project already gone is taken back.
  const remaining = await db.prepare('SELECT 1 FROM org_projects WHERE id = ?').bind(args.projectId).first();
  return remaining === null;
}

/** Remembers which Worker Workers Builds builds a project into, once found. */
export async function recordProjectSiteUrl(
  db: D1Database,
  projectId: string,
  site: { url: string; frameable: boolean | null },
): Promise<void> {
  await db
    .prepare('UPDATE org_projects SET site_url = ?, site_frameable = ? WHERE id = ?')
    .bind(site.url, site.frameable === null ? null : site.frameable ? 1 : 0, projectId)
    .run();
}

export async function recordWorkersBuildsScriptTag(db: D1Database, projectId: string, tag: string): Promise<void> {
  await db.prepare('UPDATE org_projects SET workers_builds_script_tag = ? WHERE id = ?').bind(tag, projectId).run();
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    connectionId: row.connection_id,
    orgId: row.org_id,
    name: row.name,
    repo: row.artifact_repo,
    defaultBranch: row.default_branch,
    createdFrom: row.created_from,
    importSource:
      row.import_repo_full_name !== null && row.import_branch !== null
        ? { repoId: row.import_repo_id, fullName: row.import_repo_full_name, branch: row.import_branch }
        : null,
    workersBuildsScriptTag: row.workers_builds_script_tag,
    siteUrl: row.site_url,
    siteFrameable: row.site_frameable === null ? null : row.site_frameable === 1,
    deploysWith: row.deploys_with,
    deployWorkerName: row.deploy_worker_name,
    fullName: row.owner_username && row.slug ? `${row.owner_username}/${row.slug}` : null,
    visibility: row.visibility,
    copiedFrom: row.copied_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * A request whose requester is still in its organization: one from someone who left or was removed
 * is never offered for approval (leaving declines it).
 */
const REQUESTER_IS_MEMBER = `EXISTS (
  SELECT 1 FROM organization_members AS requester
  WHERE requester.org_id = production_requests.org_id AND requester.user_id = production_requests.requested_by
)`;

/** A draft a member asked to make a real project, as an admin reviews it. */
type ProductionRequest = {
  id: string;
  title: string;
  note: string | null;
  previewUrl: string | null;
  /** The draft's own Artifacts repository, and the commit of it the member sent. */
  repo: string | null;
  commit: string | null;
  requesterName: string;
  requesterEmail: string;
  createdAt: number;
  /** When the member last sent a newer commit of the draft, or null. */
  updatedAt: number | null;
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
      `SELECT requests.id, requests.title, requests.note, requests.preview_url, requests.repo, requests.commit_sha,
              requests.created_at, requests.updated_at, users.name, users.email
       FROM production_requests AS requests
       JOIN "user" AS users ON users.id = requests.requested_by
       JOIN organization_members AS requester
         ON requester.org_id = requests.org_id AND requester.user_id = requests.requested_by
       WHERE requests.org_id = ? AND requests.status = 'pending'
       ORDER BY requests.created_at`,
    )
    .bind(orgId)
    .all<{
      id: string;
      title: string;
      note: string | null;
      preview_url: string | null;
      repo: string | null;
      commit_sha: string | null;
      created_at: number;
      updated_at: number | null;
      name: string;
      email: string;
    }>();
  return results.map((row) => ({
    id: row.id,
    title: row.title,
    note: row.note,
    previewUrl: row.preview_url,
    repo: row.repo,
    commit: row.commit_sha,
    requesterName: row.name,
    requesterEmail: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
      `SELECT id, title, status, decision_note FROM production_requests
       WHERE org_id = ? AND requested_by = ? ORDER BY created_at DESC LIMIT 10`,
    )
    .bind(orgId, userId)
    .all<{ id: string; title: string; status: 'pending' | 'approved' | 'declined'; decision_note: string | null }>();
  return results.map((row) => ({ id: row.id, title: row.title, status: row.status, decisionNote: row.decision_note }));
}

export async function declineProductionRequest(
  db: D1Database,
  args: { orgId: string; actorId: string; requestId: string; note: string },
): Promise<void> {
  await requireAdmin(db, args.orgId, args.actorId);
  const declined = await db
    .prepare(
      // The decision keeps only the request's title: its note and preview link go. The draft stays the
      // member's own, in its repository.
      `UPDATE production_requests SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ?,
         note = NULL, preview_url = NULL
       WHERE id = ? AND org_id = ? AND status = 'pending'`,
    )
    .bind(args.actorId, Date.now(), args.note || null, args.requestId, args.orgId)
    .run();
  if (declined.meta.changes !== 1) {
    throw new OrganizationError('That request was already decided.', 409);
  }
}

/**
 * Approves a request: the draft's own Artifacts repository becomes a team project, adopted as it is, that
 * its requester may edit. Returns the project and its repository; null when the request was decided
 * already, its requester is no longer in the team, or its repository is a project already.
 */
export async function approveProductionRequest(
  db: D1Database,
  args: { orgId: string; actorId: string; requestId: string },
): Promise<{ projectId: string; repo: string } | null> {
  await requireAdmin(db, args.orgId, args.actorId);
  const now = Date.now();
  const newProjectId = crypto.randomUUID();
  // The decision is written first, and the project and its access only behind it, all in one batch: the
  // request approved by this decision, with no project yet, is what the later statements look for.
  const approvedNow = `EXISTS (
    SELECT 1 FROM production_requests
    WHERE id = ?1 AND status = 'approved' AND decided_at = ?2 AND project_id IS NULL
  )`;
  const request = `(SELECT repo FROM production_requests WHERE id = ?1)`;
  const connection = `(SELECT id FROM cloudflare_connections WHERE org_id = ?3)`;
  // A draft's repository that is a project already is never sent for review (`runtime-projects/request-production`
  // refuses it, and a draft has one open request), so one found here is refused with the rest rather than approved
  // into that project.
  const title = await db
    .prepare('SELECT title FROM production_requests WHERE id = ?')
    .bind(args.requestId)
    .first<{ title: string }>();
  const slug = await freeSlug(db, args.actorId, title?.title ?? '');
  const [approved] = await db.batch([
    db
      .prepare(
        `UPDATE production_requests SET status = 'approved', decided_by = ?2, decided_at = ?3, note = NULL,
           preview_url = NULL
         WHERE id = ?1 AND org_id = ?4 AND status = 'pending' AND repo IS NOT NULL AND ${REQUESTER_IS_MEMBER}
           AND EXISTS (SELECT 1 FROM cloudflare_connections WHERE org_id = ?4)
           AND NOT EXISTS (
             SELECT 1 FROM org_projects
             WHERE connection_id = (SELECT id FROM cloudflare_connections WHERE org_id = ?4)
               AND artifact_repo = production_requests.repo
           )`,
      )
      .bind(args.requestId, args.actorId, now, args.orgId),
    db
      .prepare(
        `INSERT INTO org_projects
           (id, connection_id, org_id, name, slug, artifact_repo, created_from, created_by, created_at)
         SELECT ?4, ${connection}, ?3, title, ?6, repo, 'draft', ?5, ?2 FROM production_requests
         WHERE id = ?1 AND ${approvedNow}`,
      )
      .bind(args.requestId, now, args.orgId, newProjectId, args.actorId, slug),
    db
      .prepare(
        `INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at)
         SELECT ?4, requested_by, 'edit', ?5, ?2 FROM production_requests
         WHERE id = ?1 AND ${approvedNow}`,
      )
      .bind(args.requestId, now, args.orgId, newProjectId, args.actorId),
    // The draft's repository is the project's now, so the drafter's app of it goes: it can't be made public, copied
    // or reached from the command line as theirs. Their runtime keeps the app's chat to read (`runtime-projects/adoption`).
    db
      .prepare(`DELETE FROM apps WHERE connection_id = ${connection} AND repo = ${request} AND ${approvedNow}`)
      .bind(args.requestId, now, args.orgId),
    db
      .prepare(`UPDATE production_requests SET project_id = ?4 WHERE id = ?1 AND ${approvedNow}`)
      .bind(args.requestId, now, args.orgId, newProjectId),
  ]);
  if (approved?.meta.changes !== 1) {
    return null;
  }
  const project = await db
    .prepare('SELECT project_id, repo FROM production_requests WHERE id = ?')
    .bind(args.requestId)
    .first<{ project_id: string | null; repo: string }>();
  return project?.project_id ? { projectId: project.project_id, repo: project.repo } : null;
}
