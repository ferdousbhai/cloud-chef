-- Sharing a project with a person, as a document is shared: by their username or an email address, to view it or to
-- edit it. A team's members get their roles in org_project_access, as before; project_shares is for everyone else: a
-- person's own project shared with anyone, or a team's shared with someone outside the team. The person it is shared
-- with works on it from their own Cloudflare account, never the owner's.
--
-- project_shares, project_invitations and notifications name org_projects (ON DELETE CASCADE): a later rebuild of
-- org_projects, as 0039 and 0055 do, must step them aside first and bring them back after, or dropping it deletes
-- every share, invitation and sharing notification.
CREATE TABLE project_shares (
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  shared_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  shared_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_project_shares_user ON project_shares(user_id);

-- A project shared with an email address, until someone who proves that address takes it (then it becomes their
-- project_shares row and this row is deleted) or it expires. The emailed link carries a token; only its SHA-256 is
-- kept. It lapses with its inviter: an invitation whose inviter no longer runs the project can't be taken.
CREATE TABLE project_invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('view', 'edit')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  -- When the last email for it went out, and when it stops working (each resend moves it on).
  sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (project_id, email)
);
CREATE INDEX idx_project_invitations_email ON project_invitations(email, expires_at);

-- Notifications gain 'project_shared' (someone shared a project with you), which names the project. SQLite can't
-- change a CHECK in place, so the table is rebuilt with every row copied in its order; nothing references it.
CREATE TABLE notifications_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'new_follower', 'project_copied', 'post_liked', 'post_commented', 'post_removed', 'comment_removed',
      'project_shared'
    )
  ),
  actor_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  -- The project a 'project_shared' notification is about; NULL for every other kind.
  project_id TEXT REFERENCES org_projects(id) ON DELETE CASCADE,
  detail TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
INSERT INTO notifications_next (id, user_id, kind, actor_id, post_id, project_id, detail, created_at, read_at)
SELECT id, user_id, kind, actor_id, post_id, NULL, detail, created_at, read_at FROM notifications ORDER BY rowid;
DROP INDEX idx_notifications_user;
DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
