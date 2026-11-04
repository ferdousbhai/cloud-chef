-- A project keeps answering at the addresses it had: renaming one (`cloudchef repo rename`) leaves its old name here, so
-- clones, links and posts made with it go on working. A project now at that address comes first. Claiming an old name
-- by renaming onto it removes the row.
--
-- project_slug_redirects names org_projects (ON DELETE CASCADE): a later rebuild of org_projects, as 0039 and 0055 do,
-- must step it aside first and bring it back after, or dropping it deletes every redirect.
CREATE TABLE project_slug_redirects (
  created_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES org_projects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (created_by, slug)
) WITHOUT ROWID;
CREATE INDEX idx_project_slug_redirects_project ON project_slug_redirects(project_id);
