-- Following someone tells you when they post, and CloudChef's replies are kept whole.

-- When the people who follow a post's author were told of it: once, the first time anyone may see the post. Posts
-- already there were never announced and aren't now.
ALTER TABLE posts ADD COLUMN announced_at INTEGER;
UPDATE posts SET announced_at = created_at;

-- The whole of a reply by CloudChef that is longer than a comment; `body` keeps its start, cut to a comment's
-- length. NULL for every comment a person wrote and every reply that fits.
ALTER TABLE post_comments ADD COLUMN long_body TEXT CHECK (long_body IS NULL OR length(long_body) BETWEEN 1001 AND 20000);

-- Notifications gain 'followed_posted'. SQLite can't change a CHECK in place, so the table is rebuilt with every row
-- copied in its order; nothing references it.
CREATE TABLE notifications_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'new_follower', 'project_copied', 'post_liked', 'post_commented', 'post_removed', 'comment_removed',
      'project_shared', 'comment_replied', 'comment_mentioned', 'thread_closed', 'change_suggested',
      'followed_posted'
    )
  ),
  actor_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES org_projects(id) ON DELETE CASCADE,
  -- The thread or reply a thread notification is about; NULL for every other kind.
  comment_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
  detail TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
INSERT INTO notifications_next (id, user_id, kind, actor_id, post_id, project_id, comment_id, detail, created_at, read_at)
SELECT id, user_id, kind, actor_id, post_id, project_id, comment_id, detail, created_at, read_at FROM notifications ORDER BY rowid;
DROP INDEX idx_notifications_user;
DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
