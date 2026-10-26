-- A project CloudChef builds and deploys itself, rather than through Workers Builds: one uploaded as a ZIP, whose
-- repository no Workers Builds trigger watches. `deploys_with` says which; `deploy_worker_name` is the Worker
-- CloudChef deploys it as, once known (the name its Wrangler config gives, or a free one derived from it when that
-- name is taken in the account), unique per connection so two projects never deploy over each other.
ALTER TABLE org_projects ADD COLUMN deploys_with TEXT NOT NULL DEFAULT 'workers_builds'
  CHECK (deploys_with IN ('workers_builds', 'cloudchef'));
ALTER TABLE org_projects ADD COLUMN deploy_worker_name TEXT;
UPDATE org_projects SET deploys_with = 'cloudchef' WHERE created_from = 'zip';
CREATE UNIQUE INDEX idx_org_projects_deploy_worker
ON org_projects(connection_id, deploy_worker_name) WHERE deploy_worker_name IS NOT NULL;

-- Each build and deploy of one commit of a branch: main's go live, another branch's make a preview. A commit is
-- built once (the unique key); a newer one of main supersedes the older still waiting or running. Only state and
-- CloudChef's own short reason are kept here; the build's log stays in the account's runtime.
CREATE TABLE project_deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('production', 'preview')),
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'building', 'deploying', 'succeeded', 'failed', 'superseded', 'not_deployable')
  ),
  failure_stage TEXT CHECK (failure_stage IN ('config', 'install', 'build', 'migrations', 'deploy', 'interrupted')),
  reason TEXT,
  url TEXT,
  worker_name TEXT,
  -- The Worker the commit's config names, kept when that name was taken and the deploy went to `worker_name`.
  wanted_worker_name TEXT,
  claimed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  lease_expires_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, branch, commit_sha)
);
CREATE INDEX idx_project_deployments_project ON project_deployments(project_id, kind, created_at DESC);

-- Temporary, until the release after: a ZIP project the Worker serving during rollout adds keeps the default.
CREATE TRIGGER org_projects_deploys_with_during_rollout
AFTER INSERT ON org_projects
WHEN NEW.created_from = 'zip' AND NEW.deploys_with = 'workers_builds'
BEGIN
  UPDATE org_projects SET deploys_with = 'cloudchef' WHERE id = NEW.id;
END;
