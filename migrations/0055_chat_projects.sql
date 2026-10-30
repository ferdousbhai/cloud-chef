-- An app made in a chat is a project like any other: an org_projects row (a person's own, or a team's), its code
-- in an Artifacts repository, published by CloudChef (`deploys_with = 'cloudchef'`) when main is pushed. What it was
-- made from is recorded as 'chat'.
--
-- A push to main also records when it went live (`project_main_pushes.published_at`), set once by
-- `recordProductionPublish` when the push's commit is first seen deployed to production.
--
-- SQLite can't change `created_from`'s CHECK in place, so org_projects is rebuilt as 0045 did. Dropping org_projects
-- would cascade to the tables naming it, so they step aside first and come back after, unchanged.
CREATE TABLE org_project_access_previous AS SELECT * FROM org_project_access;
DROP INDEX idx_org_project_access_user;
DROP TABLE org_project_access;

CREATE TABLE production_requests_previous AS SELECT * FROM production_requests;
DROP INDEX idx_production_requests_org;
DROP INDEX idx_production_requests_requester;
DROP INDEX idx_production_requests_open_draft;
DROP TABLE production_requests;

CREATE TABLE project_deployments_previous AS SELECT * FROM project_deployments;
DROP INDEX idx_project_deployments_project;
DROP TABLE project_deployments;

CREATE TABLE project_main_rewrites_previous AS SELECT * FROM project_main_rewrites;
DROP INDEX idx_project_main_rewrites_project;
DROP TABLE project_main_rewrites;

CREATE TABLE project_main_pushes_previous AS SELECT * FROM project_main_pushes;
DROP INDEX idx_project_main_pushes_project;
DROP TABLE project_main_pushes;

CREATE TABLE project_visits_previous AS SELECT * FROM project_visits;
DROP INDEX idx_project_visits_last_seen;
DROP TABLE project_visits;

CREATE TABLE org_projects_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  -- The team whose project it is; NULL for a person's own.
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Its name in addresses, unique among its author's projects (0044).
  slug TEXT,
  import_repo_id INTEGER,
  import_repo_full_name TEXT,
  import_branch TEXT,
  artifact_repo TEXT,
  workers_builds_script_tag TEXT,
  site_url TEXT,
  site_frameable INTEGER,
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- What the project was made from: 'github' (an import), 'zip' (an upload), 'draft' (a team member's draft an
  -- admin approved), 'copy' (a copy of another project, named in `copied_from`), 'push' (made empty from the
  -- command line, its history pushed from the person's own computer), or 'chat' (made in a chat with the agent,
  -- from CloudChef's starter).
  created_from TEXT CHECK (created_from IN ('github', 'zip', 'draft', 'copy', 'push', 'chat')),
  copied_from TEXT REFERENCES org_projects(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  deploys_with TEXT NOT NULL DEFAULT 'workers_builds' CHECK (deploys_with IN ('workers_builds', 'cloudchef')),
  deploy_worker_name TEXT,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (artifact_repo IS NOT NULL OR (import_repo_full_name IS NOT NULL AND import_branch IS NOT NULL))
);

INSERT INTO org_projects_next (
  id, connection_id, org_id, name, slug, import_repo_id, import_repo_full_name, import_branch, artifact_repo,
  workers_builds_script_tag, site_url, site_frameable, default_branch, created_from, copied_from, visibility,
  deploys_with, deploy_worker_name, created_by, created_at
)
SELECT
  id, connection_id, org_id, name, slug, import_repo_id, import_repo_full_name, import_branch, artifact_repo,
  workers_builds_script_tag, site_url, site_frameable, default_branch, created_from, copied_from, visibility,
  deploys_with, deploy_worker_name, created_by, created_at
FROM org_projects;

DROP TABLE org_projects;
ALTER TABLE org_projects_next RENAME TO org_projects;

CREATE INDEX idx_org_projects_connection ON org_projects(connection_id, name);
CREATE INDEX idx_org_projects_org ON org_projects(org_id, name);
CREATE UNIQUE INDEX idx_org_projects_artifact_repo
ON org_projects(connection_id, artifact_repo) WHERE artifact_repo IS NOT NULL;
CREATE UNIQUE INDEX idx_org_projects_import_repo
ON org_projects(connection_id, import_repo_id) WHERE import_repo_id IS NOT NULL;
CREATE UNIQUE INDEX idx_org_projects_import_name
ON org_projects(connection_id, import_repo_full_name COLLATE NOCASE) WHERE import_repo_full_name IS NOT NULL;
CREATE UNIQUE INDEX idx_org_projects_deploy_worker
ON org_projects(connection_id, deploy_worker_name) WHERE deploy_worker_name IS NOT NULL;
CREATE UNIQUE INDEX org_projects_author_slug ON org_projects(created_by, slug);
CREATE INDEX idx_org_projects_public ON org_projects(visibility, created_at DESC) WHERE visibility = 'public';

CREATE TABLE org_project_access (
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'edit' CHECK (role IN ('view', 'edit')),
  granted_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
INSERT INTO org_project_access (project_id, user_id, role, granted_by, granted_at)
SELECT project_id, user_id, role, granted_by, granted_at FROM org_project_access_previous;
DROP TABLE org_project_access_previous;
CREATE INDEX idx_org_project_access_user ON org_project_access(user_id);

CREATE TABLE production_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT,
  preview_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'declined')),
  project_id TEXT REFERENCES org_projects(id) ON DELETE SET NULL,
  decided_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  decided_at INTEGER,
  decision_note TEXT,
  created_at INTEGER NOT NULL,
  draft_id TEXT,
  draft_revision TEXT,
  updated_at INTEGER,
  repo TEXT,
  commit_sha TEXT
);
INSERT INTO production_requests (
  id, org_id, requested_by, title, note, preview_url, status, project_id, decided_by, decided_at, decision_note,
  created_at, draft_id, draft_revision, updated_at, repo, commit_sha
)
SELECT
  id, org_id, requested_by, title, note, preview_url, status, project_id, decided_by, decided_at, decision_note,
  created_at, draft_id, draft_revision, updated_at, repo, commit_sha
FROM production_requests_previous;
DROP TABLE production_requests_previous;
CREATE INDEX idx_production_requests_org ON production_requests(org_id, status, created_at DESC);
CREATE INDEX idx_production_requests_requester ON production_requests(requested_by, created_at DESC);
CREATE UNIQUE INDEX idx_production_requests_open_draft
ON production_requests(org_id, requested_by, draft_id)
WHERE draft_id IS NOT NULL AND status IN ('pending', 'approving');

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
  wanted_worker_name TEXT,
  claimed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  lease_expires_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  step TEXT CHECK (step IN ('preparing', 'installing', 'building', 'migrating', 'publishing')),
  step_started_at INTEGER,
  UNIQUE (project_id, branch, commit_sha)
);
INSERT INTO project_deployments (
  id, project_id, kind, branch, commit_sha, state, failure_stage, reason, url, worker_name, wanted_worker_name,
  claimed_by, lease_expires_at, attempt, created_at, updated_at, step, step_started_at
)
SELECT
  id, project_id, kind, branch, commit_sha, state, failure_stage, reason, url, worker_name, wanted_worker_name,
  claimed_by, lease_expires_at, attempt, created_at, updated_at, step, step_started_at
FROM project_deployments_previous;
DROP TABLE project_deployments_previous;
CREATE INDEX idx_project_deployments_project ON project_deployments(project_id, kind, created_at DESC);

CREATE TABLE project_main_rewrites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  rewritten_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  branch TEXT NOT NULL,
  old_commit TEXT NOT NULL,
  new_commit TEXT NOT NULL,
  rewritten_at INTEGER NOT NULL
);
INSERT INTO project_main_rewrites (id, project_id, rewritten_by, branch, old_commit, new_commit, rewritten_at)
SELECT id, project_id, rewritten_by, branch, old_commit, new_commit, rewritten_at FROM project_main_rewrites_previous;
DROP TABLE project_main_rewrites_previous;
CREATE INDEX idx_project_main_rewrites_project ON project_main_rewrites(project_id, rewritten_at DESC);

CREATE TABLE project_main_pushes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  pushed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  old_commit TEXT,
  new_commit TEXT NOT NULL,
  pushed_at INTEGER NOT NULL,
  -- When this commit was first seen live in production; NULL until then (or when it never was).
  published_at INTEGER
);
INSERT INTO project_main_pushes (id, project_id, pushed_by, old_commit, new_commit, pushed_at)
SELECT id, project_id, pushed_by, old_commit, new_commit, pushed_at FROM project_main_pushes_previous;
DROP TABLE project_main_pushes_previous;
CREATE INDEX idx_project_main_pushes_project ON project_main_pushes(project_id, pushed_at DESC);

CREATE TABLE project_visits (
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL,
  here_until INTEGER NOT NULL,
  working INTEGER NOT NULL DEFAULT 0 CHECK (working IN (0, 1)),
  PRIMARY KEY (project_id, user_id)
) WITHOUT ROWID;
INSERT INTO project_visits SELECT * FROM project_visits_previous;
DROP TABLE project_visits_previous;
CREATE INDEX idx_project_visits_last_seen ON project_visits(last_seen_at);
