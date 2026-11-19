-- thread_runs keeps only which chat a person's `@cloudchef` mentions in a thread go to: since 0064, each mention is its
-- own row in mention_requests, and answering_id and answering_since are unread. SQLite can't drop a column that is
-- part of a foreign key, so the table is rebuilt with every row copied. Nothing references it.
CREATE TABLE thread_runs_next (
  thread_id TEXT NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  -- 'edit' (may change and publish the project) or 'read' (read-only), as decided at the latest mention.
  access TEXT NOT NULL CHECK (access IN ('edit', 'read')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;
INSERT INTO thread_runs_next (thread_id, user_id, chat_id, access, created_at)
SELECT thread_id, user_id, chat_id, access, created_at FROM thread_runs;
DROP TABLE thread_runs;
ALTER TABLE thread_runs_next RENAME TO thread_runs;
