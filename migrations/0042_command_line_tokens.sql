-- Personal tokens for working on projects from the command line (git, and reading how publishes went), made in
-- Settings and shown once: only their hash is kept. Each lasts until it expires or its owner revokes it.
CREATE TABLE command_line_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX command_line_tokens_user ON command_line_tokens (user_id);
