-- Requests a team's admins approve or reject on the Approvals page. Today one kind: a member's agent asking to
-- change the team's Cloudflare account (`cloudflare_change`), which CloudChef sends itself, once, when an admin
-- approves it. The member's workspace is never handed the account's credential.
--
-- `id` is the request's own id. `agent_name` and `tool_call_id` say which conversation and which of its steps
-- asked, so the result is written back there. `request_json` is the exact request (method, url, body) and
-- `request_sha256` its digest; `warning` is CloudChef's plain-words note on what it does, made when it was filed.
-- `status`: 'pending' until an admin decides or it expires; 'sending' while CloudChef sends it; 'done' once the
-- outcome is in `outcome_json` (with `result`: succeeded, failed or indeterminate); 'rejected'; 'expired'.
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('cloudflare_change')),
  agent_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
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
  UNIQUE (agent_name, tool_call_id)
);
CREATE INDEX idx_approval_requests_org ON approval_requests(org_id, status, created_at);
CREATE INDEX idx_approval_requests_requester ON approval_requests(requested_by, created_at);
