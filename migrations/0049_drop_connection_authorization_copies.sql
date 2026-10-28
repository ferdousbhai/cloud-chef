-- One authorization per account lives in `cloudflare_authorizations` (0035). The connection's own copies of it
-- (left NULL since 0037) and the two rollout triggers that mirrored them there go: nothing reads or writes them.
DROP TRIGGER cloudflare_connections_authorization_insert;
DROP TRIGGER cloudflare_connections_authorization_update;
DROP INDEX idx_cloudflare_connections_credential_handle;
ALTER TABLE cloudflare_connections DROP COLUMN granted_oauth_scopes_json;
ALTER TABLE cloudflare_connections DROP COLUMN credential_handle;
