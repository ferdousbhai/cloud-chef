-- A chat can work on one of the person's organization's GitHub projects instead of a new app: its
-- workspace starts from the repository and its changes go back there. One such chat per project, so
-- reopening a project from the sidebar returns to the same conversation and workspace.
ALTER TABLE chats ADD COLUMN org_project_id TEXT;

CREATE UNIQUE INDEX idx_chats_org_project
ON chats(creator_id, org_project_id)
WHERE is_deleted = 0 AND org_project_id IS NOT NULL;
