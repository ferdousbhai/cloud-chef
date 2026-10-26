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
  /** The Worker the commit's config names, when that name was taken and the deploy went to `workerName`. */
  wantedWorkerName: string | null;
  attempt: number;
  createdAt: number;
  updatedAt: number;
};

/** How long a claim or a step holds without a heartbeat before another runtime may take the work over. */
export const DEPLOYMENT_LEASE_MS = 3 * 60_000;
/**
 * How long a deployment may wait queued, renewed by nothing, before another runtime takes it over: longer than the
 * jobs ahead of it in its runtime's queue can take, so a runtime that is still working is never overtaken.
 */
const QUEUED_TAKEOVER_MS = 2 * 60 * 60_000;
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
  wanted_worker_name: string | null;
  attempt: number;
  created_at: number;
  updated_at: number;
};

const COLUMNS = `id, project_id, kind, branch, commit_sha, state, failure_stage, reason, url, worker_name,
  wanted_worker_name, attempt, created_at, updated_at`;

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
    wantedWorkerName: row.wanted_worker_name,
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
 * and the existing one after, which another runtime may already be working on; one whose runtime stopped (its lease
 * ran out unfinished) is taken over, as a new attempt. A new commit of a branch supersedes that branch's unfinished
 * older ones; one already deploying keeps its lease until it stops, so no two deploys overlap. `notBefore` is for a
 * claim of a head read earlier: refused when the branch has a newer row since, which is a newer commit.
 */
export async function claimDeployment(
  db: D1Database,
  args: {
    projectId: string;
    branch: string;
    commit: string;
    defaultBranch: string;
    userId: string;
    notBefore?: number;
    now?: number;
  },
): Promise<{ deployment: ProjectDeployment; claimed: boolean }> {
  const now = args.now ?? Date.now();
  const kind: DeploymentKind = args.branch === args.defaultBranch ? 'production' : 'preview';
  const existing = () =>
    db
      .prepare(`SELECT ${COLUMNS} FROM project_deployments WHERE project_id = ? AND branch = ? AND commit_sha = ?`)
      .bind(args.projectId, args.branch, args.commit)
      .first<DeploymentRow>()
      .then((row) => (row ? toDeployment(row) : null));
  if (args.notBefore !== undefined) {
    const newer = await db
      .prepare(
        `SELECT ${COLUMNS} FROM project_deployments
         WHERE project_id = ? AND branch = ? AND commit_sha != ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(args.projectId, args.branch, args.commit, args.notBefore)
      .first<DeploymentRow>();
    if (newer) {
      return { deployment: (await existing()) ?? toDeployment(newer), claimed: false };
    }
  }
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
  if (inserted.meta.changes === 1) {
    await db
      .prepare(
        `UPDATE project_deployments
         SET state = 'superseded', updated_at = ?,
             lease_expires_at = CASE WHEN state = 'deploying' THEN lease_expires_at ELSE NULL END
         WHERE project_id = ? AND branch = ? AND id != ? AND state IN ('queued', 'building', 'deploying')`,
      )
      .bind(now, args.projectId, args.branch, id)
      .run();
    await pruneDeployments(db, args.projectId);
    const deployment = await readDeployment(db, id);
    if (!deployment) {
      throw new Error('The deployment could not be recorded.');
    }
    return { deployment, claimed: true };
  }
  const takenOver = await db
    .prepare(
      `UPDATE project_deployments
       SET state = 'queued', failure_stage = NULL, reason = NULL, attempt = attempt + 1, claimed_by = ?,
           lease_expires_at = ?, updated_at = ?
       WHERE project_id = ? AND branch = ? AND commit_sha = ?
         AND (
           (state IN ('building', 'deploying') AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           OR (state = 'queued' AND updated_at <= ?)
         )`,
    )
    .bind(
      args.userId,
      now + DEPLOYMENT_LEASE_MS,
      now,
      args.projectId,
      args.branch,
      args.commit,
      now,
      now - QUEUED_TAKEOVER_MS,
    )
    .run();
  const deployment = await existing();
  if (!deployment) {
    throw new Error('The deployment could not be recorded.');
  }
  return { deployment, claimed: takenOver.meta.changes === 1 };
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

/**
 * Deploys a production deployment that went to a derived Worker name again, to the Worker its config names: the
 * project deploys as that Worker from then on. Only the newest production deployment, once it succeeded; refused
 * (null) when another project of the connection already deploys as that Worker.
 */
export async function deployToWantedWorker(
  db: D1Database,
  args: { id: string; projectId: string; userId: string; now?: number },
): Promise<ProjectDeployment | null> {
  const now = args.now ?? Date.now();
  const current = await readDeployment(db, args.id);
  if (
    current?.projectId !== args.projectId ||
    current.kind !== 'production' ||
    current.state !== 'succeeded' ||
    !current.wantedWorkerName ||
    current.wantedWorkerName === current.workerName
  ) {
    return null;
  }
  // One transaction: the deployment starts again only if the project takes the Worker, and the project takes it only
  // while it is still free; the unique Worker index refuses it when another project of the connection deploys as it.
  try {
    const [requeued, renamed] = await db.batch([
      db
        .prepare(
          `UPDATE project_deployments
           SET state = 'queued', failure_stage = NULL, reason = NULL, url = NULL, worker_name = NULL,
               wanted_worker_name = NULL, attempt = attempt + 1, claimed_by = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND state = 'succeeded'
             AND NOT EXISTS (
               SELECT 1 FROM project_deployments newer
               WHERE newer.project_id = project_deployments.project_id AND newer.branch = project_deployments.branch
                 AND newer.created_at > project_deployments.created_at
             )
             AND EXISTS (SELECT 1 FROM org_projects WHERE id = ? AND deploy_worker_name IS ?)`,
        )
        .bind(args.userId, now + DEPLOYMENT_LEASE_MS, now, args.id, args.projectId, current.workerName),
      db
        .prepare(
          `UPDATE org_projects SET deploy_worker_name = ?
           WHERE id = ? AND deploy_worker_name IS ?
             AND EXISTS (SELECT 1 FROM project_deployments WHERE id = ? AND state = 'queued' AND updated_at = ?)`,
        )
        .bind(current.wantedWorkerName, args.projectId, current.workerName, args.id, now),
    ]);
    if (requeued?.meta.changes !== 1 || renamed?.meta.changes !== 1) {
      return null;
    }
  } catch {
    return null;
  }
  return readDeployment(db, args.id);
}

/**
 * What a report did: written; the work was superseded (stop it); refused (not this runtime's to report); or, for a
 * move to `deploying`, busy: another deploy of the project is still running, so try again shortly.
 */
type DeploymentReportOutcome = 'recorded' | 'superseded' | 'refused' | 'busy';

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
    wantedWorkerName?: string;
    now?: number;
  },
): Promise<DeploymentReportOutcome> {
  const now = args.now ?? Date.now();
  const current = await readDeployment(db, args.id);
  if (!current) {
    return 'refused';
  }
  if (current.state === 'superseded') {
    // A superseded deploy that stopped lets the newer one go ahead at once.
    if (!UNFINISHED.includes(args.state)) {
      await db
        .prepare(`UPDATE project_deployments SET lease_expires_at = NULL WHERE id = ? AND claimed_by = ?`)
        .bind(args.id, args.userId)
        .run();
    }
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
           wanted_worker_name = COALESCE(?, wanted_worker_name), lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND claimed_by = ? AND state IN ('queued', 'building', 'deploying')
         AND (? != 'deploying' OR NOT EXISTS (
           SELECT 1 FROM project_deployments other
           WHERE other.project_id = project_deployments.project_id AND other.id != project_deployments.id
             AND other.state IN ('deploying', 'superseded') AND other.lease_expires_at > ?
         ))`,
    )
    .bind(
      args.state,
      args.state === 'failed' ? (args.failureStage ?? 'interrupted') : null,
      args.reason?.slice(0, MAX_REASON_CHARACTERS) ?? null,
      args.url ?? null,
      args.workerName ?? null,
      args.wantedWorkerName ?? null,
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
  const after = await db
    .prepare('SELECT state, claimed_by FROM project_deployments WHERE id = ?')
    .bind(args.id)
    .first<{ state: DeploymentState; claimed_by: string | null }>();
  if (after?.state === 'superseded') {
    return 'superseded';
  }
  return args.state === 'deploying' && after?.claimed_by === args.userId && UNFINISHED.includes(after.state)
    ? 'busy'
    : 'refused';
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
