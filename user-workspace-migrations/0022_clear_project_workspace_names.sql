-- A team or imported project's workspace goes by the project's name. Before, its first message named it too, and the
-- header showed that name while the project's loaded; no workspace of a project keeps one now.
UPDATE workspaces
SET description = NULL, description_source = NULL
WHERE org_project_id IS NOT NULL AND description IS NOT NULL;
