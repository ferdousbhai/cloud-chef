-- Who has each project open, and when each person last had it open: a person, a project, two times and whether their
-- agent is working, never anything they wrote or said. A browser with the project open reports every 30 seconds;
-- someone is here while `here_until` (ms) is ahead of now, which each report moves 90 seconds on and leaving sets to 0.
-- `last_seen_at` stays when they go, so their next visit can say who changed the project since. Scheduled maintenance
-- deletes rows not seen for 180 days.
CREATE TABLE project_visits (
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL,
  here_until INTEGER NOT NULL,
  working INTEGER NOT NULL DEFAULT 0 CHECK (working IN (0, 1)),
  PRIMARY KEY (project_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_project_visits_last_seen ON project_visits(last_seen_at);
