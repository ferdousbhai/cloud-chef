-- Each time a project's owner (a team project's admin) replaced its main with a branch's history that doesn't add to
-- main's (`cloudchef repo rewrite-main`): who, when, from which branch, and main's commit before and after. A push
-- only ever adds to main, so it isn't kept here.
CREATE TABLE project_main_rewrites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  rewritten_by TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  branch TEXT NOT NULL,
  old_commit TEXT NOT NULL,
  new_commit TEXT NOT NULL,
  rewritten_at INTEGER NOT NULL
);
CREATE INDEX idx_project_main_rewrites_project ON project_main_rewrites(project_id, rewritten_at DESC);
