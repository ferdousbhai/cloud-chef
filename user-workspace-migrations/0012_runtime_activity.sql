-- Redeploying this Worker resets its Durable Objects, which ends any turn, validation, preview or
-- deployment they are running. Each BuilderAgent records here whether it is doing such work, so the
-- control plane can upgrade the Worker only when none is, and so it can tell a busy workspace from a
-- quiet one at all: the work itself lives in per-conversation Durable Objects it cannot see.
-- `updated_at` bounds a row a Durable Object never cleared (it was evicted mid-work and never woke):
-- a busy row counts for as long as the longest turn can run, an idle one for a short quiet period.
CREATE TABLE runtime_activity (
  agent_name TEXT PRIMARY KEY,
  busy INTEGER NOT NULL CHECK (busy IN (0, 1)),
  updated_at INTEGER NOT NULL
);

-- The window an upgrade claimed while nothing was busy. Work that starts inside it waits it out on the
-- Worker version being replaced, so the redeploy cannot land mid-work; the new version, named by
-- `target_version`, does not wait.
CREATE TABLE runtime_upgrade_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
