-- A connection can have CloudChef's GitHub App installed on several GitHub accounts (a person's own and the
-- organizations they own), and imports read from all of them. One row per installation; org_id, unnamed since
-- the release before, goes.
CREATE TABLE github_installations_next (
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  installation_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  connected_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, installation_id)
);

INSERT INTO github_installations_next (
  connection_id, installation_id, account_login, account_type, connected_by, created_at, updated_at
)
SELECT connection_id, installation_id, account_login, account_type, connected_by, created_at, updated_at
FROM github_installations;

DROP TABLE github_installations;
ALTER TABLE github_installations_next RENAME TO github_installations;
