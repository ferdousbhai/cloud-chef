-- Two admin controls over an organization's members.
--
-- Drafts: a member may build new apps of their own (drafts) in the organization's account, or only work
-- on the GitHub projects they are given. A member without drafts is never handed the organization's
-- Cloudflare authorization: their changes reach production only through GitHub.
ALTER TABLE organization_members ADD COLUMN drafts_allowed INTEGER NOT NULL DEFAULT 1
  CHECK (drafts_allowed IN (0, 1));

-- Production requests: a member asks for a draft to become a real project. An admin approves it into a
-- new GitHub repository that deploys through the repository's own pipeline, or declines it. The draft's
-- source travels with the request (gzipped), since it lives in the member's own workspace.
CREATE TABLE production_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT,
  preview_url TEXT,
  snapshot_gzip_base64 TEXT NOT NULL,
  snapshot_files INTEGER NOT NULL,
  -- 'approving' while one admin's approval is creating the repository, so no other can start.
  status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'declined')),
  -- When an approval claimed it; a claim that never finished lapses, so the request isn't stuck.
  claimed_at INTEGER,
  project_id TEXT REFERENCES org_projects(id) ON DELETE SET NULL,
  decided_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  decided_at INTEGER,
  decision_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_production_requests_org
ON production_requests(org_id, status, created_at DESC);
CREATE INDEX idx_production_requests_requester
ON production_requests(requested_by, created_at DESC);

-- An approval in progress: the admin is authorizing with GitHub so CloudChef can create the repository
-- as them. Pruned with the other short-lived sign-in states.
CREATE TABLE github_approval_states (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES production_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  repo_name TEXT NOT NULL,
  private INTEGER NOT NULL CHECK (private IN (0, 1)),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_github_approval_states_expires
ON github_approval_states(expires_at);
