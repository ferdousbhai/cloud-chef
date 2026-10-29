-- A team member's change to the team's Cloudflare account can now come from their own workspace terminal as well
-- as from a command their agent ran, and one command can ask for several changes. `source` records which: 'agent'
-- (then `agent_name` and `tool_call_id` say which conversation and which of its commands asked, so the result is
-- written back there) or 'terminal' (typed by the member in their workspace terminal; both are NULL, and the result
-- is seen on the Approvals page). The UNIQUE (agent_name, tool_call_id) goes, since a command may file several.
--
-- SQLite can't drop a table constraint in place, so approval_requests is rebuilt; nothing references it.
CREATE TABLE approval_requests_next (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cloudflare_change')),
  source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'terminal')),
  agent_name TEXT,
  tool_call_id TEXT,
  request_json TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  warning TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'done', 'rejected', 'expired')),
  result TEXT CHECK (result IN ('succeeded', 'failed', 'indeterminate')),
  outcome_json TEXT,
  decided_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (
    (source = 'agent' AND agent_name IS NOT NULL AND tool_call_id IS NOT NULL) OR
    (source = 'terminal' AND agent_name IS NULL AND tool_call_id IS NULL)
  )
);

INSERT INTO approval_requests_next (
  id, org_id, connection_id, requested_by, kind, source, agent_name, tool_call_id, request_json, request_sha256,
  warning, status, result, outcome_json, decided_by, decided_at, created_at, expires_at
)
SELECT
  id, org_id, connection_id, requested_by, kind, 'agent', agent_name, tool_call_id, request_json, request_sha256,
  warning, status, result, outcome_json, decided_by, decided_at, created_at, expires_at
FROM approval_requests;

DROP INDEX idx_approval_requests_org;
DROP INDEX idx_approval_requests_requester;
DROP TABLE approval_requests;
ALTER TABLE approval_requests_next RENAME TO approval_requests;
CREATE INDEX idx_approval_requests_org ON approval_requests(org_id, status, created_at);
CREATE INDEX idx_approval_requests_requester ON approval_requests(requested_by, created_at);
CREATE INDEX idx_approval_requests_command ON approval_requests(agent_name, tool_call_id);
