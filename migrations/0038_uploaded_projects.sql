-- A project can be made from a ZIP someone uploads, with no GitHub source and its Artifacts repository from the
-- start. Where each project was made from is recorded in a new column, `created_from`: 'github', 'zip' or
-- 'draft'. It replaces `origin` ('imported' / 'promoted'), which loses its NOT NULL and CHECK here so the
-- new Worker needn't write it, and is dropped in the release after. SQLite can't change either in place, so
-- org_projects is rebuilt, with every row copied and `created_from` filled in from `origin`.
--
-- Rollout: safe to apply before the deploy. The Worker serving meanwhile writes only `origin`; a temporary
-- trigger fills in `created_from` for what it adds. The release after drops the trigger with `origin`.
--
-- Rebuilding org_projects drops it, and SQLite's implicit DELETE on DROP TABLE would cascade to the access
-- grants and clear production requests' project ids. So both step aside first, unreferenced, and come back
-- into their tables at the end, as in 0033.
CREATE TABLE org_project_access_previous AS SELECT * FROM org_project_access;
DROP INDEX idx_org_project_access_user;
DROP TABLE org_project_access;

CREATE TABLE production_requests_previous AS SELECT * FROM production_requests;
DROP INDEX idx_production_requests_org;
DROP INDEX idx_production_requests_requester;
DROP INDEX idx_production_requests_open_draft;
DROP TABLE production_requests;

CREATE TABLE org_projects_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  -- The team whose project it is; NULL for a person's own.
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Where it was imported from on GitHub: the repository's id when imported through CloudChef's GitHub App
  -- (private repositories), NULL for a public one imported by its address; and the branch imported to main.
  import_repo_id INTEGER,
  import_repo_full_name TEXT,
  import_branch TEXT,
  -- The Artifacts repository in the account's `cloudchef` namespace; NULL until the first member to open an
  -- imported project has imported it.
  artifact_repo TEXT,
  -- The tag of the Worker that Workers Builds builds the repository into, once found.
  workers_builds_script_tag TEXT,
  -- That Worker's production address (a custom domain first), once found: the projects home shows it.
  site_url TEXT,
  -- Artifacts' only production branch.
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- What the project was made from: 'github' (an import), 'zip' (an upload), or 'draft' (a team member's
  -- draft an admin approved, adopting the draft's own repository).
  created_from TEXT CHECK (created_from IN ('github', 'zip', 'draft')),
  -- Replaced by created_from; written only by the Worker serving while this applies. Dropped in the release after.
  origin TEXT,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (artifact_repo IS NOT NULL OR (import_repo_full_name IS NOT NULL AND import_branch IS NOT NULL))
);

INSERT INTO org_projects_next (
  id, connection_id, org_id, name, import_repo_id, import_repo_full_name, import_branch, artifact_repo,
  workers_builds_script_tag, site_url, default_branch, created_from, origin, created_by, created_at
)
SELECT
  id, connection_id, org_id, name, import_repo_id, import_repo_full_name, import_branch, artifact_repo,
  workers_builds_script_tag, site_url, default_branch, CASE origin WHEN 'promoted' THEN 'draft' ELSE 'github' END,
  origin, created_by, created_at
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

-- Team members given a project, and what they may do with it. Admins may edit every project of their team.
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

CREATE INDEX idx_org_project_access_user
ON org_project_access(user_id);

CREATE TABLE production_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT,
  preview_url TEXT,
  snapshot_gzip_base64 TEXT NOT NULL DEFAULT '',
  snapshot_files INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'declined')),
  claimed_at INTEGER,
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
  id, org_id, requested_by, title, note, preview_url, snapshot_gzip_base64, snapshot_files, status, claimed_at,
  project_id, decided_by, decided_at, decision_note, created_at, draft_id, draft_revision, updated_at, repo,
  commit_sha
)
SELECT
  id, org_id, requested_by, title, note, preview_url, snapshot_gzip_base64, snapshot_files, status, claimed_at,
  project_id, decided_by, decided_at, decision_note, created_at, draft_id, draft_revision, updated_at, repo,
  commit_sha
FROM production_requests_previous;

DROP TABLE production_requests_previous;

CREATE INDEX idx_production_requests_org
ON production_requests(org_id, status, created_at DESC);
CREATE INDEX idx_production_requests_requester
ON production_requests(requested_by, created_at DESC);
CREATE UNIQUE INDEX idx_production_requests_open_draft
ON production_requests(org_id, requested_by, draft_id)
WHERE draft_id IS NOT NULL AND status IN ('pending', 'approving');

-- Temporary, until the release after: a project the Worker serving during rollout adds names only `origin`.
CREATE TRIGGER org_projects_created_from_during_rollout
AFTER INSERT ON org_projects
WHEN NEW.created_from IS NULL
BEGIN
  UPDATE org_projects SET created_from = CASE NEW.origin WHEN 'promoted' THEN 'draft' ELSE 'github' END
  WHERE id = NEW.id;
END;
