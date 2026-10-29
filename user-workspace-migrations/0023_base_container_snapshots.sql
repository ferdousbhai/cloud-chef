-- The runtime's base snapshot: a container's whole filesystem once CloudChef's setup has run on Cloudflare's managed
-- image, which every later workspace and project-builder start of this runtime restores instead of setting up again
-- (user-workspace-runtime/src/base-container.ts). One row per key, which names the managed image and the setup with
-- every pin in it; a release with a new key sets up once more and replaces the row.
-- `refreshed_at` is when Cloudflare's 30 days last started over (the snapshot was taken or restored). `setup_holder`
-- is the one start allowed to take the snapshot while there is none, until `setup_claimed_at` lapses.
CREATE TABLE base_container_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  snapshot_id TEXT,
  snapshot_size INTEGER,
  taken_at INTEGER,
  refreshed_at INTEGER,
  setup_holder TEXT,
  setup_claimed_at INTEGER
);
