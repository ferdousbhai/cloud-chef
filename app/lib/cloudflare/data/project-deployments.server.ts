/**
 * The builds and deploys CloudChef runs itself for a project it deploys (`org_projects.deploys_with = 'cloudchef'`),
 * one row per branch and commit. A runtime claims a commit, reports each step, and holds a lease while it works: a
 * commit is built once, a newer one of the default branch supersedes the older still waiting or running, and only one
 * deploy of a project runs at a time.
 */

type DeploymentKind = 'production' | 'preview';
type DeploymentState = 'queued' | 'building' | 'deploying' | 'succeeded' | 'failed' | 'superseded' | 'not_deployable';
type DeploymentFailureStage = 'config' | 'install' | 'build' | 'migrations' | 'deploy' | 'interrupted';

type ProjectDeployment = {
  id: string;
  projectId: string;
  kind: DeploymentKind;
  branch: string;
  commit: string;
  state: DeploymentState;
  failureStage: DeploymentFailureStage | null;
  reason: string | null;
  url: string | null;
  workerName: string | null;
  attempt: number;
  createdAt: number;
  updatedAt: number;
};

/** How long a claim or a step holds without a heartbeat before another runtime may take the work over. */
export const DEPLOYMENT_LEASE_MS = 3 * 60_000;
/** Rows kept per project; older finished ones are pruned as new ones arrive. */
const KEPT_DEPLOYMENTS = 20;
const MAX_REASON_CHARACTERS = 300;

const UNFINISHED: readonly DeploymentState[] = ['queued', 'building', 'deploying'];

type DeploymentRow = {
  id: string;
  project_id: string;
  kind: DeploymentKind;
  branch: string;
  commit_sha: string;
  state: DeploymentState;
  failure_stage: DeploymentFailureStage | null;
  reason: string | null;
  url: string | null;
  worker_name: string | null;
  attempt: number;
  created_at: number;
  updated_at: number;
};

const COLUMNS = `id, project_id, kind, branch, commit_sha, state, failure_stage, reason, url, worker_name, attempt,
  created_at, updated_at`;

function toDeployment(row: DeploymentRow): ProjectDeployment {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    branch: row.branch,
    commit: row.commit_sha,
    state: row.state,
    failureStage: row.failure_stage,
    reason: row.reason,
    url: row.url,
    workerName: row.worker_name,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readDeployment(db: D1Database, id: string): Promise<ProjectDeployment | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM project_deployments WHERE id = ?`)
    .bind(id)
    .first<DeploymentRow>();
  return row ? toDeployment(row) : null;
}

/**
 * Claims building and deploying `commit` of `branch` for `userId`'s runtime: a new row the first time (`claimed`),
 * and the existing one after, which another runtime may already be working on. A new commit of the default branch
 * supersedes that branch's unfinished older ones.
 */
export async function claimDeployment(
  db: D1Database,
  args: { projectId: string; branch: string; commit: string; defaultBranch: string; userId: string; now?: number },
): Promise<{ deployment: ProjectDeployment; claimed: boolean }> {
  const now = args.now ?? Date.now();
  const kind: DeploymentKind = args.branch === args.defaultBranch ? 'production' : 'preview';
  const id = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT INTO project_deployments
         (id, project_id, kind, branch, commit_sha, state, claimed_by, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
       ON CONFLICT (project_id, branch, commit_sha) DO NOTHING`,
    )
    .bind(id, args.projectId, kind, args.branch, args.commit, args.userId, now + DEPLOYMENT_LEASE_MS, now, now)
    .run();
  const claimed = inserted.meta.changes === 1;
  if (claimed) {
    await db
      .prepare(
        `UPDATE project_deployments SET state = 'superseded', lease_expires_at = NULL, updated_at = ?
         WHERE project_id = ? AND branch = ? AND id != ? AND state IN ('queued', 'building', 'deploying')`,
      )
      .bind(now, args.projectId, args.branch, id)
      .run();
    await pruneDeployments(db, args.projectId);
  }
  const deployment = claimed
    ? await readDeployment(db, id)
    : await db
        .prepare(`SELECT ${COLUMNS} FROM project_deployments WHERE project_id = ? AND branch = ? AND commit_sha = ?`)
        .bind(args.projectId, args.branch, args.commit)
        .first<DeploymentRow>()
        .then((row) => (row ? toDeployment(row) : null));
  if (!deployment) {
    throw new Error('The deployment could not be recorded.');
  }
  return { deployment, claimed };
}

/**
 * Starts a failed deployment of the same commit again, for `userId`'s runtime: its attempt counts up. Only a failed
 * one, and only while it is still the newest of its branch.
 */
export async function retryDeployment(
  db: D1Database,
  args: { id: string; userId: string; now?: number },
): Promise<ProjectDeployment | null> {
  const now = args.now ?? Date.now();
  const updated = await db
    .prepare(
      `UPDATE project_deployments
       SET state = 'queued', failure_stage = NULL, reason = NULL, attempt = attempt + 1, claimed_by = ?,
           lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM project_deployments newer
           WHERE newer.project_id = project_deployments.project_id AND newer.branch = project_deployments.branch
             AND newer.created_at > project_deployments.created_at
         )`,
    )
    .bind(args.userId, now + DEPLOYMENT_LEASE_MS, now, args.id)
    .run();
  return updated.meta.changes === 1 ? readDeployment(db, args.id) : null;
}

/** What a report did: written, the work was superseded (stop it), or refused (not this runtime's to report). */
type DeploymentReportOutcome = 'recorded' | 'superseded' | 'refused';

/**
 * Records a step of `userId`'s claimed deployment, renewing its lease: building, deploying, or how it ended. Moving
 * to `deploying` is refused while another deployment of the project is deploying under a live lease, so only one
 * deploy of a project runs at a time; the work stops, superseded, once a newer commit of its branch exists.
 */
export async function reportDeployment(
  db: D1Database,
  args: {
    id: string;
    userId: string;
    state: Exclude<DeploymentState, 'queued' | 'superseded'>;
    failureStage?: DeploymentFailureStage;
    reason?: string;
    url?: string;
    workerName?: string;
    now?: number;
  },
): Promise<DeploymentReportOutcome> {
  const now = args.now ?? Date.now();
  const current = await readDeployment(db, args.id);
  if (!current) {
    return 'refused';
  }
  if (current.state === 'superseded') {
    return 'superseded';
  }
  if (!UNFINISHED.includes(current.state)) {
    return 'refused';
  }
  const finished = !UNFINISHED.includes(args.state);
  const updated = await db
    .prepare(
      `UPDATE project_deployments
       SET state = ?, failure_stage = ?, reason = ?, url = COALESCE(?, url), worker_name = COALESCE(?, worker_name),
           lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND claimed_by = ? AND state IN ('queued', 'building', 'deploying')
         AND (? != 'deploying' OR NOT EXISTS (
           SELECT 1 FROM project_deployments other
           WHERE other.project_id = project_deployments.project_id AND other.id != project_deployments.id
             AND other.state = 'deploying' AND other.lease_expires_at > ?
         ))`,
    )
    .bind(
      args.state,
      args.state === 'failed' ? (args.failureStage ?? 'interrupted') : null,
      args.reason?.slice(0, MAX_REASON_CHARACTERS) ?? null,
      args.url ?? null,
      args.workerName ?? null,
      finished ? null : now + DEPLOYMENT_LEASE_MS,
      now,
      args.id,
      args.userId,
      args.state,
      now,
    )
    .run();
  if (updated.meta.changes === 1) {
    return 'recorded';
  }
  return (await readDeployment(db, args.id))?.state === 'superseded' ? 'superseded' : 'refused';
}

/** The project's newest deployments, newest first. */
export async function latestDeployments(db: D1Database, projectId: string, limit = 10): Promise<ProjectDeployment[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM project_deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(projectId, limit)
    .all<DeploymentRow>();
  return results.map(toDeployment);
}

/** The deployment of exactly this commit of the project, if one was claimed. */
export async function deploymentOfCommit(
  db: D1Database,
  args: { projectId: string; commit: string },
): Promise<ProjectDeployment | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM project_deployments WHERE project_id = ? AND commit_sha = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(args.projectId, args.commit)
    .first<DeploymentRow>();
  return row ? toDeployment(row) : null;
}

async function pruneDeployments(db: D1Database, projectId: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM project_deployments
       WHERE project_id = ? AND state NOT IN ('queued', 'building', 'deploying') AND id NOT IN (
         SELECT id FROM project_deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
       )`,
    )
    .bind(projectId, projectId, KEPT_DEPLOYMENTS)
    .run();
}
