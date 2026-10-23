-- A person's clone token for a project's repository: an Artifacts read token good for a year. Clone shows
-- the same one again while it lasts, and it is revoked once the person can no longer see the team project
-- it reads (`org_project_id`; null for their own app).
CREATE TABLE clone_tokens (
  repo TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_project_id TEXT,
  token_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  remote TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (repo, user_id)
);

CREATE INDEX idx_clone_tokens_org_project ON clone_tokens(org_project_id) WHERE org_project_id IS NOT NULL;
