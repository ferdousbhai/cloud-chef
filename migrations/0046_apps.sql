-- The apps people make in a chat (CloudChef apps, kept in their own repository `p-<chat>` in the account), known to
-- CloudChef itself so they can be public and copied like projects, and reached from the command line. Each person's
-- runtime keeps its own apps' rows current: their names, and their live address as its deploys recorded it.
-- `id` is the chat's id; `slug` is the app's name in addresses, unique among its owner's projects and apps.
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES cloudflare_connections(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  site_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, slug)
);
CREATE INDEX idx_apps_owner ON apps(user_id, connection_id);
CREATE INDEX idx_apps_public ON apps(visibility, created_at DESC) WHERE visibility = 'public';
