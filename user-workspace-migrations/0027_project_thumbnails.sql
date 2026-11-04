-- A picture of each project's live site for its card, taken by this account's own Browser Rendering and kept here,
-- so it stays in the account (app/lib/cloudflare/data/project-thumbnails.server.ts). `requested_at` keeps a site that
-- can't be pictured from being tried on every view; `image` is empty until the first picture.
CREATE TABLE project_thumbnails (
  project_id TEXT PRIMARY KEY,
  image BLOB,
  taken_at INTEGER,
  requested_at INTEGER NOT NULL
);
