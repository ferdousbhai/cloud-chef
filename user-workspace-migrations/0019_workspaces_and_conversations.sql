-- Names that say what each thing is. A workspace (was `chats`) is one working copy of a project: its files and
-- container, one per own app and one per member per team project. A conversation (was `chat_transcripts`) is one
-- thread of messages with the agent; a workspace has many, one open at a time (`last_conversation_index`).
-- Rows keep their ids, so every agent, deployment and link stays where it is.
--
-- The archive-and-continue columns of 0011 go: a team project's new conversation is a new row of the same
-- workspace, so nothing archives a workspace or continues another's agent any more (none in production are set).
DROP INDEX idx_chats_current_org_project;
DROP INDEX idx_chats_org_project_history;
ALTER TABLE chats DROP COLUMN archived_at;
ALTER TABLE chats DROP COLUMN continues_agent_name;
ALTER TABLE chats RENAME COLUMN last_subchat_index TO last_conversation_index;
ALTER TABLE chats RENAME TO workspaces;

ALTER TABLE chat_transcripts RENAME COLUMN chat_id TO workspace_id;
ALTER TABLE chat_transcripts RENAME COLUMN subchat_index TO conversation_index;
ALTER TABLE chat_transcripts RENAME COLUMN parent_subchat_index TO parent_conversation_index;
ALTER TABLE chat_transcripts RENAME TO conversations;

ALTER TABLE deployments RENAME COLUMN chat_id TO workspace_id;
ALTER TABLE app_resource_gc_candidates RENAME COLUMN chat_id TO workspace_id;
ALTER TABLE agent_gc_candidates RENAME COLUMN chat_id TO workspace_id;
ALTER TABLE agent_gc_candidates RENAME COLUMN subchat_index TO conversation_index;

DROP INDEX idx_chats_active_initial;
CREATE UNIQUE INDEX idx_workspaces_active_initial
ON workspaces(creator_id, initial_id) WHERE is_deleted = 0;
DROP INDEX idx_chats_history;
CREATE INDEX idx_workspaces_history
ON workspaces(creator_id, is_deleted, timestamp DESC, id DESC);
-- One workspace per person per team project.
CREATE UNIQUE INDEX idx_workspaces_org_project
ON workspaces(creator_id, org_project_id) WHERE is_deleted = 0 AND org_project_id IS NOT NULL;
DROP INDEX idx_deployments_chat_created;
CREATE INDEX idx_deployments_workspace_created
ON deployments(workspace_id, created_at DESC);
