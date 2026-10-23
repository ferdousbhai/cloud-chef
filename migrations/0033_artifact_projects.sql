-- Projects keep their code and history in Cloudflare Artifacts, in the account they belong to. GitHub is only
-- where a project may be imported from, once. A project belongs to a Cloudflare connection: a team's (with
-- its organization) or a person's own (whose owner is its only member). Team members hold a role on each
-- project they're given: view or edit. Admins own every team project.
--
-- Rollout: the Worker serving while this applies still names repo_id and repo_full_name, so its GitHub
-- project calls fail until the new Worker is live. Apply this immediately before deploying. The production
-- request snapshot and claim columns, github_approval_states, and the organization columns of the GitHub
-- tables are no longer named by the new Worker; the release after drops them.
--
-- Rebuilding org_projects drops it, and SQLite's implicit DELETE on DROP TABLE would cascade to the access
-- grants and clear production requests' project ids. So both step aside first, unreferenced, and come back
-- into their new tables at the end.
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
  -- Artifacts' only production branch.
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- 'imported': from GitHub; 'promoted': a member's approved draft, adopting the draft's own repository.
  origin TEXT NOT NULL CHECK (origin IN ('imported', 'promoted')),
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  CHECK (artifact_repo IS NOT NULL OR (import_repo_full_name IS NOT NULL AND import_branch IS NOT NULL))
);

-- The team projects linked from GitHub become imports whose first open imports them, from the branch each
-- was on. Their Workers keep serving; Workers Builds' tags are recorded so their builds are found at once.
INSERT INTO org_projects_next (
  id, connection_id, org_id, name, import_repo_id, import_repo_full_name, import_branch, artifact_repo,
  workers_builds_script_tag, default_branch, origin, created_by, created_at
)
SELECT
  projects.id, connections.id, projects.org_id, projects.name, projects.repo_id, projects.repo_full_name,
  projects.default_branch, NULL,
  CASE projects.repo_id
    WHEN 1115484475 THEN '6a5d7ad1d4cf487c8c39b8db7a81f6c8'
    WHEN 1404196644 THEN 'd367538bf2e84573a30d43ffceaaaa0e'
  END,
  'main', 'imported', projects.created_by, projects.created_at
FROM org_projects AS projects
JOIN cloudflare_connections AS connections ON connections.org_id = projects.org_id;

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
SELECT previous.project_id, previous.user_id, 'edit', previous.granted_by, previous.granted_at
FROM org_project_access_previous AS previous
WHERE EXISTS (SELECT 1 FROM org_projects WHERE org_projects.id = previous.project_id);

DROP TABLE org_project_access_previous;

CREATE INDEX idx_org_project_access_user
ON org_project_access(user_id);

-- A production request names the draft's own repository and the commit an admin reviews; approving adopts
-- that repository. The snapshot and claim columns get defaults so the new Worker never names them.
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
  project_id, decided_by, decided_at, decision_note, created_at, draft_id, draft_revision, updated_at
)
SELECT
  id, org_id, requested_by, title, note, preview_url, snapshot_gzip_base64, snapshot_files, status, claimed_at,
  CASE WHEN EXISTS (SELECT 1 FROM org_projects WHERE org_projects.id = previous.project_id) THEN project_id END,
  decided_by, decided_at, decision_note, created_at, draft_id, draft_revision, updated_at
FROM production_requests_previous AS previous;

DROP TABLE production_requests_previous;

CREATE INDEX idx_production_requests_org
ON production_requests(org_id, status, created_at DESC);
CREATE INDEX idx_production_requests_requester
ON production_requests(requested_by, created_at DESC);
CREATE UNIQUE INDEX idx_production_requests_open_draft
ON production_requests(org_id, requested_by, draft_id)
WHERE draft_id IS NOT NULL AND status IN ('pending', 'approving');

-- CloudChef's GitHub App installation, for importing private repositories, belongs to a connection: a
-- team's, or a person's own. org_id stays (unnamed) for the release that drops it.
CREATE TABLE github_installations_next (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  org_id TEXT UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  connected_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO github_installations_next (
  connection_id, org_id, installation_id, account_login, account_type, connected_by, created_at, updated_at
)
SELECT
  connections.id, installations.org_id, installations.installation_id, installations.account_login,
  installations.account_type, installations.connected_by, installations.created_at, installations.updated_at
FROM github_installations AS installations
JOIN cloudflare_connections AS connections ON connections.org_id = installations.org_id;

DROP TABLE github_installations;
ALTER TABLE github_installations_next RENAME TO github_installations;

CREATE TABLE github_install_states_next (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO github_install_states_next (id, connection_id, org_id, user_id, return_to, expires_at, used_at, created_at)
SELECT states.id, connections.id, states.org_id, states.user_id, states.return_to, states.expires_at, states.used_at,
  states.created_at
FROM github_install_states AS states
JOIN cloudflare_connections AS connections ON connections.org_id = states.org_id;

DROP INDEX idx_github_install_states_expires;
DROP TABLE github_install_states;
ALTER TABLE github_install_states_next RENAME TO github_install_states;

CREATE INDEX idx_github_install_states_expires
ON github_install_states(expires_at);
