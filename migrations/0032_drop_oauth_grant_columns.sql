-- A connection's grant is its provider-confirmed scope IDs in granted_oauth_scopes_json, and one missing a core
-- scope reauthorizes. The capability list, requested scopes, scope-profile version, grant status and grant time
-- lost their last reader and writer a release ago, so the Worker serving while this applies never names them.
ALTER TABLE cloudflare_connections DROP COLUMN granted_capabilities_json;
ALTER TABLE cloudflare_connections DROP COLUMN requested_oauth_scopes_json;
ALTER TABLE cloudflare_connections DROP COLUMN oauth_scope_profile_version;
ALTER TABLE cloudflare_connections DROP COLUMN oauth_scope_grant_status;
ALTER TABLE cloudflare_connections DROP COLUMN oauth_grant_updated_at;
