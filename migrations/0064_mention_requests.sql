-- `@cloudchef` mentions wait their turn (docs/proposals/comment-threads.md): each mention is its own request until its
-- answer is posted, so a person may ask again in a thread, or in another, while CloudChef is still working; their chat
-- answers them one after another. thread_runs keeps only which chat a person's mentions in a thread go to; its
-- answering_id and answering_since are unread from this release and dropped in a later one.
CREATE TABLE mention_requests (
  -- The comment whose `@cloudchef` this answers.
  comment_id TEXT PRIMARY KEY REFERENCES post_comments(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- The chat it was sent to, once the person's runtime took it.
  chat_id TEXT,
  created_at INTEGER NOT NULL,
  -- When its answer was posted, or it was given up: NULL while it waits or runs.
  answered_at INTEGER
) WITHOUT ROWID;
CREATE INDEX idx_mention_requests_thread ON mention_requests(thread_id, answered_at);
CREATE INDEX idx_mention_requests_user ON mention_requests(user_id, thread_id, answered_at);
