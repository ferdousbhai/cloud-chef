-- Comment threads (docs/proposals/comment-threads.md): a comment with no parent starts a thread, the post's issue,
-- numbered per post; replies are one level deep. A thread is open, on its way (a change made for it is waiting to go
-- live) or closed with a reason. People follow threads; `@cloudchef` in a thread starts a run in the asker's space.

-- On every comment: its thread (NULL on a thread's first comment), the post's commit live when it was written, and
-- whether CloudChef posted it (`author_id` is then the person whose mention it answers).
ALTER TABLE post_comments ADD COLUMN parent_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE;
ALTER TABLE post_comments ADD COLUMN commit_sha TEXT;
ALTER TABLE post_comments ADD COLUMN by_agent INTEGER NOT NULL DEFAULT 0 CHECK (by_agent IN (0, 1));

-- The rest are set on a thread's first comment only, NULL on replies.
ALTER TABLE post_comments ADD COLUMN number INTEGER;
-- 'comment', or 'suggestion' (a change suggested from a public copy, named in suggested_*).
ALTER TABLE post_comments ADD COLUMN kind TEXT CHECK (kind IN ('comment', 'suggestion'));
-- 'open'; 'on_its_way' (closed as changed by CloudChef, waiting for a publish that has fix_commit); 'closed'.
ALTER TABLE post_comments ADD COLUMN state TEXT CHECK (state IN ('open', 'on_its_way', 'closed'));
ALTER TABLE post_comments ADD COLUMN close_reason TEXT CHECK (close_reason IN ('changed', 'not_planned', 'duplicate'));
ALTER TABLE post_comments ADD COLUMN duplicate_of TEXT REFERENCES post_comments(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN fix_commit TEXT;
ALTER TABLE post_comments ADD COLUMN state_by TEXT REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN state_at INTEGER;
ALTER TABLE post_comments ADD COLUMN locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1));
-- When it was pinned to the top of its post; at most three per post, checked when pinning.
ALTER TABLE post_comments ADD COLUMN pinned_at INTEGER;
-- When anything last happened in it (a reply, a state change): open threads sort by it.
ALTER TABLE post_comments ADD COLUMN active_at INTEGER;
ALTER TABLE post_comments ADD COLUMN suggested_project_id TEXT REFERENCES org_projects(id) ON DELETE SET NULL;
ALTER TABLE post_comments ADD COLUMN suggested_commit TEXT;

-- Every existing comment becomes an open thread, numbered in the order it was written.
UPDATE post_comments SET kind = 'comment', state = 'open', active_at = created_at, number = (
  SELECT COUNT(*) FROM post_comments AS earlier
  WHERE earlier.post_id = post_comments.post_id
    AND (earlier.created_at < post_comments.created_at
      OR (earlier.created_at = post_comments.created_at AND earlier.rowid <= post_comments.rowid))
);
CREATE UNIQUE INDEX idx_post_comments_number ON post_comments(post_id, number) WHERE number IS NOT NULL;
CREATE INDEX idx_post_comments_thread ON post_comments(parent_id, created_at);
CREATE INDEX idx_post_comments_state ON post_comments(post_id, state);

-- Who follows a thread: its starter, everyone who replied or was mentioned, and anyone who pressed Follow. `muted`
-- after Mute, so replying again doesn't follow it again.
CREATE TABLE thread_followers (
  thread_id TEXT NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_thread_followers_user ON thread_followers(user_id);
INSERT OR IGNORE INTO thread_followers (thread_id, user_id, created_at)
SELECT id, author_id, created_at FROM post_comments;
INSERT OR IGNORE INTO thread_followers (thread_id, user_id, created_at)
SELECT comments.id, posts.author_id, comments.created_at FROM post_comments AS comments
JOIN posts ON posts.id = comments.post_id;

-- `@cloudchef` runs: one chat per person per thread, in that person's space.
CREATE TABLE thread_runs (
  thread_id TEXT NOT NULL REFERENCES post_comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  -- 'edit' (may change and publish the project) or 'read' (read-only), as decided at the latest mention.
  access TEXT NOT NULL CHECK (access IN ('edit', 'read')),
  -- The comment whose mention the running turn answers; NULL when no turn is running.
  answering_id TEXT REFERENCES post_comments(id) ON DELETE SET NULL,
  -- When that turn was claimed: a claim older than a few hours is taken as lost (its runtime never reported back).
  answering_since INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;

-- Notifications gain the comment they are about and the kinds of threads. SQLite can't change a CHECK in place, so
-- the table is rebuilt with every row copied in its order; nothing references it.
CREATE TABLE notifications_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'new_follower', 'project_copied', 'post_liked', 'post_commented', 'post_removed', 'comment_removed',
      'project_shared', 'comment_replied', 'comment_mentioned', 'thread_closed', 'change_suggested'
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
SELECT id, user_id, kind, actor_id, post_id, project_id, NULL, detail, created_at, read_at FROM notifications ORDER BY rowid;
DROP INDEX idx_notifications_user;
DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
