-- Each push to a team project's main that a member's workspace runtime passed on to the project's repository (from a
-- workspace, or from their own computer through CloudChef's git address): who, when, and main's commit before and
-- after. For a project Workers Builds publishes this is the only record of who published, since Workers Builds reads
-- main from the repository by itself and CloudChef never sees its builds start.
CREATE TABLE project_main_pushes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  pushed_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  old_commit TEXT,
  new_commit TEXT NOT NULL,
  pushed_at INTEGER NOT NULL
);
CREATE INDEX idx_project_main_pushes_project ON project_main_pushes(project_id, pushed_at DESC);
