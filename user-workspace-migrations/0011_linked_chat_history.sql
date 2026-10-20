-- A member can start a new conversation on a GitHub project. The one before is archived: still there to
-- read, but no longer the project's current conversation, and it takes no more messages. The new one
-- continues its workspace (the agent named here), so unpublished changes carry over.
ALTER TABLE chats ADD COLUMN archived_at INTEGER;
ALTER TABLE chats ADD COLUMN continues_agent_name TEXT;

-- One current conversation per project, replacing 0010's one conversation per project.
CREATE UNIQUE INDEX idx_chats_current_org_project
ON chats(creator_id, org_project_id)
WHERE is_deleted = 0 AND archived_at IS NULL AND org_project_id IS NOT NULL;
DROP INDEX idx_chats_org_project;

CREATE INDEX idx_chats_org_project_history
ON chats(creator_id, org_project_id, archived_at DESC)
WHERE is_deleted = 0 AND org_project_id IS NOT NULL;
