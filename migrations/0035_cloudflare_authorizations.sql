-- One Cloudflare authorization per Cloudflare account. A person's own space and every team that builds in the
-- same account share it, so one reconnect updates all of them. Each space keeps its own row in
-- cloudflare_connections: its id, status and generation, which sessions, workspaces, projects, GitHub
-- installations and model settings are keyed by, and the account it builds in.
CREATE TABLE cloudflare_authorizations (
  account_id TEXT PRIMARY KEY NOT NULL,
  credential_handle TEXT NOT NULL REFERENCES cloudflare_credentials(handle),
  -- Exact provider-confirmed scope IDs; one missing a core scope asks for reauthorization.
  granted_oauth_scopes_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_cloudflare_authorizations_credential_handle
ON cloudflare_authorizations(credential_handle);

-- Each account takes the authorization of one of its spaces: an active one first, then a person's own (their own
-- Cloudflare login), then the most recently connected. No space's id or generation changes, so no workspace
-- has to be prepared again; the others' credentials stop being used and are removed in the release after.
INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json, created_at, updated_at)
SELECT connection.account_id, connection.credential_handle, connection.granted_oauth_scopes_json,
       COALESCE(connection.connected_at, connection.created_at), connection.updated_at
FROM cloudflare_connections AS connection
WHERE connection.credential_handle IS NOT NULL
  AND connection.id = (
    SELECT chosen.id
    FROM cloudflare_connections AS chosen
    WHERE chosen.account_id = connection.account_id AND chosen.credential_handle IS NOT NULL
    ORDER BY chosen.status = 'active' DESC, chosen.user_id IS NULL, chosen.connected_at DESC, chosen.id
    LIMIT 1
  );

-- The Worker serving while this applies still writes a space's credential and scopes into its own row when
-- someone connects or reconnects. These keep the account's authorization in step with that until the new Worker
-- is live; it never writes those columns, and the release after drops them with these triggers.
CREATE TRIGGER cloudflare_connections_authorization_insert
AFTER INSERT ON cloudflare_connections
WHEN NEW.credential_handle IS NOT NULL AND NEW.status = 'active'
BEGIN
  INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json, created_at, updated_at)
  VALUES (NEW.account_id, NEW.credential_handle, NEW.granted_oauth_scopes_json, NEW.updated_at, NEW.updated_at)
  ON CONFLICT(account_id) DO UPDATE SET
    credential_handle = excluded.credential_handle,
    granted_oauth_scopes_json = excluded.granted_oauth_scopes_json,
    updated_at = excluded.updated_at
  WHERE excluded.credential_handle IS NOT NULL;
END;

CREATE TRIGGER cloudflare_connections_authorization_update
AFTER UPDATE OF credential_handle, granted_oauth_scopes_json ON cloudflare_connections
WHEN NEW.credential_handle IS NOT NULL AND NEW.status = 'active'
BEGIN
  INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json, created_at, updated_at)
  VALUES (NEW.account_id, NEW.credential_handle, NEW.granted_oauth_scopes_json, NEW.updated_at, NEW.updated_at)
  ON CONFLICT(account_id) DO UPDATE SET
    credential_handle = excluded.credential_handle,
    granted_oauth_scopes_json = excluded.granted_oauth_scopes_json,
    updated_at = excluded.updated_at
  WHERE excluded.credential_handle IS NOT NULL;
END;
