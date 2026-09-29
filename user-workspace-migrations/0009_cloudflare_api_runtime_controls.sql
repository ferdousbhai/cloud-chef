-- The official Cloudflare MCP integration is replaced by cloudflare_request: the model discovers an
-- operation with the cf CLI in the credential-free workspace and the runtime Worker sends the exact
-- request. Reads run immediately; every write still needs the owner's per-request approval, so
-- both switches ship enabled and remain operator kill switches.
DELETE FROM runtime_controls WHERE key IN (
  'cloudflare_mcp',
  'cloudflare_mcp_execute',
  'cloudflare_mcp_billable',
  'cloudflare_mcp_credentials',
  'cloudflare_mcp_registrar'
);

INSERT INTO runtime_controls (key, enabled, reason, updated_at) VALUES
  ('cloudflare_api', 1, NULL, unixepoch() * 1000),
  ('cloudflare_api_write', 1, NULL, unixepoch() * 1000);
