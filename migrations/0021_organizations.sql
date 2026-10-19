-- Organizations: an admin connects the organization's Cloudflare account once, and its members build
-- and deploy in it without Cloudflare logins of their own. A connection now belongs to a user (their
-- personal account) or to an organization, and each person gets their own workspace runtime per
-- connection they build in.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE organization_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  -- A paused member keeps their membership and work but can't open their workspace or use the
  -- organization's Cloudflare authorization until resumed.
  paused_at INTEGER,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX idx_organization_members_user
ON organization_members(user_id);

-- One-time invites, addressed to an email. Only the token's SHA-256 is kept; accepting needs a session
-- whose verified email is the invited one.
CREATE TABLE organization_invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_organization_invites_org
ON organization_invites(org_id, created_at DESC);
CREATE INDEX idx_organization_invites_expires
ON organization_invites(expires_at);

-- Each member's Workers AI use in their organization's account, a day at a time, so its admins see who
-- spends what. Counts only: no prompt, response or project content ever reaches the control plane.
CREATE TABLE organization_usage_daily (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id, day)
);

-- The workspace a session builds in: a connection the user may use (their own, or their organization's).
ALTER TABLE cloudflare_auth_sessions ADD COLUMN context_connection_id TEXT;

-- An admin connecting their organization's Cloudflare account: the callback makes the connection the
-- organization's rather than the admin's own.
ALTER TABLE cloudflare_oauth_states ADD COLUMN connecting_org_id TEXT;

-- Rollout: a still-serving previous deployment upserts runtime locators with ON CONFLICT(user_id),
-- which no longer matches a constraint once runtimes are keyed by (user, connection), so its
-- provisioning completions fail until the new code is live. Apply this migration immediately before
-- deploying; anyone caught in between is asked to wait while their workspace is prepared again.
--
-- Rebuilding cloudflare_connections drops it, and SQLite's implicit DELETE on DROP TABLE would cascade
-- to user_computer_runtimes. So the runtime locators step aside first, unreferenced, and come back
-- into a table keyed by (user, connection) at the end.
CREATE TABLE user_computer_runtimes_previous AS SELECT * FROM user_computer_runtimes;
DROP INDEX idx_user_computer_runtimes_connection;
DROP TABLE user_computer_runtimes;

CREATE TABLE cloudflare_connections_next (
  id TEXT PRIMARY KEY,
  -- Exactly one owner: a user's personal connection, or an organization's.
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  account_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('linking', 'active', 'revoked', 'error')),
  credential_handle TEXT REFERENCES cloudflare_credentials(handle),
  ai_billing_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_billing_enabled IN (0, 1)),
  connected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  connection_generation INTEGER NOT NULL DEFAULT 1 CHECK (connection_generation > 0),
  granted_capabilities_json TEXT NOT NULL DEFAULT '[]',
  requested_oauth_scopes_json TEXT NOT NULL DEFAULT '[]',
  granted_oauth_scopes_json TEXT NOT NULL DEFAULT '[]',
  oauth_scope_profile_version TEXT,
  oauth_scope_grant_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (oauth_scope_grant_status IN ('unknown', 'core', 'partial', 'full')),
  oauth_grant_updated_at INTEGER,
  CHECK ((user_id IS NULL) <> (org_id IS NULL))
);

INSERT INTO cloudflare_connections_next (
  id, user_id, org_id, account_id, account_name, status, credential_handle, ai_billing_enabled,
  connected_at, created_at, updated_at, connection_generation, granted_capabilities_json,
  requested_oauth_scopes_json, granted_oauth_scopes_json, oauth_scope_profile_version,
  oauth_scope_grant_status, oauth_grant_updated_at
)
SELECT
  id, user_id, NULL, account_id, account_name, status, credential_handle, ai_billing_enabled,
  connected_at, created_at, updated_at, connection_generation, granted_capabilities_json,
  requested_oauth_scopes_json, granted_oauth_scopes_json, oauth_scope_profile_version,
  oauth_scope_grant_status, oauth_grant_updated_at
FROM cloudflare_connections;

DROP INDEX idx_cloudflare_connections_user_status;
DROP INDEX idx_cloudflare_connections_credential_handle;
DROP TABLE cloudflare_connections;
ALTER TABLE cloudflare_connections_next RENAME TO cloudflare_connections;

-- Plain (not partial) unique indexes: SQLite lets any number of rows have NULL here, and an
-- `ON CONFLICT(user_id)` upsert, like the one a still-serving previous deployment runs, still matches.
CREATE UNIQUE INDEX idx_cloudflare_connections_user ON cloudflare_connections(user_id);
CREATE UNIQUE INDEX idx_cloudflare_connections_org ON cloudflare_connections(org_id);
CREATE INDEX idx_cloudflare_connections_user_status
ON cloudflare_connections(user_id, status);
CREATE INDEX idx_cloudflare_connections_credential_handle
ON cloudflare_connections(credential_handle) WHERE credential_handle IS NOT NULL;

CREATE TABLE user_computer_runtimes (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  worker_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'error')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  image_digest TEXT,
  PRIMARY KEY (user_id, connection_id)
);

INSERT INTO user_computer_runtimes (
  user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
  last_error, created_at, updated_at, image_digest
)
SELECT
  user_id, connection_id, connection_generation, worker_name, endpoint, runtime_version, status,
  last_error, created_at, updated_at, image_digest
FROM user_computer_runtimes_previous;

DROP TABLE user_computer_runtimes_previous;

CREATE INDEX idx_user_computer_runtimes_connection
ON user_computer_runtimes(connection_id, connection_generation, status);
