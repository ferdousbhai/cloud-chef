-- A team member's change to the team's Cloudflare account can now come from their own workspace terminal as well
-- as from a command their agent ran, and one command can file several changes. Both columns are added in place, so
-- the Worker serving while this applies keeps filing as before.
--
-- `source`: 'agent' (a command the member's agent ran; `agent_name` names the conversation) or 'terminal' (typed by
-- the member in their workspace terminal: it goes back to no conversation, `agent_name` is '' and `tool_call_id` is
-- the request's own `id`, which keeps UNIQUE (agent_name, tool_call_id) satisfied).
-- `change_number`: which of its command's changes this is, from 1. The first keeps the command's tool call id as
-- `tool_call_id`; a later one is filed as `<tool call id>#<change_number>`, so each has its own key.
ALTER TABLE approval_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'terminal'));
ALTER TABLE approval_requests ADD COLUMN change_number INTEGER NOT NULL DEFAULT 1 CHECK (change_number >= 1);
