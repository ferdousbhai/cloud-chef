-- Organization projects backed by GitHub repositories. An admin installs CloudChef's GitHub App on the
-- organization's GitHub account (choosing which repositories it may reach), links repositories as
-- projects, and chooses which members may work on each. GitHub stays the source of truth: members'
-- changes are committed there and the repository's own pipeline deploys them. No GitHub token is
-- stored: each operation mints a short-lived installation token scoped to one repository.

CREATE TABLE github_installations (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  connected_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- An installation in progress: who started it, for which organization, and where to return.
CREATE TABLE github_install_states (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_github_install_states_expires
ON github_install_states(expires_at);

CREATE TABLE org_projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repo_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  -- 'linked': an existing repository; 'promoted': created from a member's approved draft.
  origin TEXT NOT NULL CHECK (origin IN ('linked', 'promoted')),
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, repo_id)
);

-- Members who may work on a project. Admins may work on every project of their organization.
CREATE TABLE org_project_access (
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  granted_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX idx_org_project_access_user
ON org_project_access(user_id);
