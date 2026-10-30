-- Chats from before pi-durable move into their transcript when their agent starts (app/agents/legacy-chat.ts). One
-- row per conversation of a workspace this runtime had when it was upgraded, which the runtime's maintenance starts
-- once (app/lib/cloudflare/data/legacy-chat-moves.server.ts) so a chat no one opens moves too. `moved_at` is set
-- once its agent answered how many old messages its transcript shows (`moved_messages`, 0 for none); a failure
-- counts in `attempts` and is tried again. A row with no `moved_at` for a workspace not deleted is a chat still
-- only in the old tables. The release that removes legacy-chat.ts stops naming this table, and the one after drops it.
CREATE TABLE legacy_chat_moves (
  agent_name TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  moved_messages INTEGER,
  moved_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO legacy_chat_moves (agent_name, workspace_id)
SELECT conversations.agent_name, conversations.workspace_id
FROM conversations
JOIN workspaces ON workspaces.id = conversations.workspace_id
WHERE workspaces.is_deleted = 0;
