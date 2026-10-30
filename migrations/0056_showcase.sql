-- Showcase pages and the feed (docs/proposals/showcase-and-feed.md): each person's public page at their username,
-- with a post for each public project they published; following, likes, comments, notifications, and reports.
-- Pages, posts and Explore are public on the web; everything else needs sign-in.
--
-- posts and pending_copies name org_projects (ON DELETE CASCADE): a later rebuild of org_projects, as 0055 does, must
-- step them aside first and bring them back after, or dropping it deletes every post.

-- A person's line under their name on their page, and the time moderation paused their page (its posts are then
-- hidden everywhere until an operator lifts it).
ALTER TABLE "user" ADD COLUMN bio TEXT CHECK (length(bio) <= 300);
ALTER TABLE "user" ADD COLUMN showcase_paused_at INTEGER;

-- A public project shown on its author's page and in followers' feeds. One per project: later publishes update it,
-- which keeps posting by itself from flooding feeds.
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES org_projects(id) ON DELETE CASCADE,
  -- Whose page it is on: the person whose push published it (a team project's member), else the project's author.
  author_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- What it shows: main's commit that was published, and the live site's address then.
  commit_sha TEXT NOT NULL,
  site_url TEXT NOT NULL,
  caption TEXT CHECK (length(caption) <= 2000),
  -- 'visible'; 'hidden' by its author, because the project went private, or held after reports; 'removed' by an
  -- operator (kept so the next publish doesn't post it again).
  status TEXT NOT NULL CHECK (status IN ('visible', 'hidden', 'removed')),
  hidden_reason TEXT CHECK (hidden_reason IN ('author', 'project_private', 'reported')),
  -- Where it sorts in feeds and on the page: moved by a publish at most once a day, and by a new video.
  shown_at INTEGER NOT NULL,
  published_count INTEGER NOT NULL DEFAULT 1,
  like_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  copy_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_posts_author ON posts(author_id, status, shown_at DESC);
CREATE INDEX idx_posts_shown ON posts(status, shown_at DESC);

-- A post's pictures and videos, in CloudChef's own R2 (SHOWCASE_MEDIA). The newest automatic screenshot replaces the
-- one before it; an uploaded video replaces the video before it, with its poster frame.
CREATE TABLE post_media (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot', 'video', 'poster')),
  -- 'automatic' (taken on publish by Browser Rendering) or 'uploaded' (recorded or chosen by the author).
  origin TEXT NOT NULL CHECK (origin IN ('automatic', 'uploaded')),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  commit_sha TEXT,
  -- 'pending' until checked; 'ready' to show; 'rejected' by the checks or an operator.
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_post_media_post ON post_media(post_id, kind);

-- The R2 objects of media rows gone, however they went (a post deleted, its project deleted or made private, an
-- account erased, all by cascade): the scheduled maintenance deletes each object and then its row here.
CREATE TABLE post_media_deletions (
  r2_key TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
CREATE TRIGGER post_media_deleted AFTER DELETE ON post_media
BEGIN
  INSERT OR IGNORE INTO post_media_deletions (r2_key, deleted_at)
  SELECT OLD.r2_key, unixepoch() * 1000 WHERE OLD.r2_key IS NOT NULL;
END;

CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id, created_at DESC);
CREATE INDEX idx_follows_follower ON follows(follower_id, created_at DESC);

-- Who liked a post: its count is public, who liked it only its author sees.
CREATE TABLE post_likes (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX idx_post_likes_user ON post_likes(user_id, created_at DESC);

CREATE TABLE post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  -- 'visible'; 'held' after reports, until an operator decides; 'removed' by an operator.
  status TEXT NOT NULL CHECK (status IN ('visible', 'held', 'removed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_post_comments_post ON post_comments(post_id, status, created_at);
CREATE INDEX idx_post_comments_author ON post_comments(author_id, created_at DESC);

-- In-app notifications. The account menu's avatar shows a dot while any is unread.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('new_follower', 'project_copied', 'post_liked', 'post_commented', 'post_removed', 'comment_removed')
  ),
  actor_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  -- What the notification names, kept as it was then: the project's name, or the reason it was taken down.
  detail TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);

-- A report of a post, or of one comment on it. Visitors who aren't signed in may report too; their address is kept
-- only as its SHA-256, to limit how many reports one address files.
CREATE TABLE post_reports (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES post_comments(id) ON DELETE CASCADE,
  reporter_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  reporter_ip_hash TEXT,
  reason TEXT NOT NULL CHECK (
    reason IN ('scam_or_phishing', 'sexual', 'violent_or_hateful', 'copied_without_permission', 'spam', 'other')
  ),
  note TEXT CHECK (length(note) <= 1000),
  -- Filed by CloudChef's own checks (the URL Scanner) rather than a person.
  automatic INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('open', 'dismissed', 'actioned')),
  decided_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_post_reports_open ON post_reports(state, created_at);
CREATE INDEX idx_post_reports_post ON post_reports(post_id, state);
CREATE INDEX idx_post_reports_address ON post_reports(reporter_ip_hash, created_at) WHERE reporter_ip_hash IS NOT NULL;

-- "Make a copy" chosen by someone with no space to copy into yet: the copy is made once they have one.
CREATE TABLE pending_copies (
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
