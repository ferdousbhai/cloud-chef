import { transcriptAgentName, type TranscriptIdentity } from 'cloudchef-agent/transcript';
import type { ConversationRow } from './types';

export async function requireConversation(
  db: D1Database,
  args: { workspaceId: string; conversationIndex: number },
): Promise<ConversationRow> {
  const transcript = await db
    .prepare('SELECT * FROM conversations WHERE workspace_id = ? AND conversation_index = ?')
    .bind(args.workspaceId, args.conversationIndex)
    .first<ConversationRow>();
  if (!transcript) {
    throw new Error('Chat transcript not found');
  }
  return transcript;
}

export function transcriptIdentity(row: ConversationRow): TranscriptIdentity {
  return { agentName: row.agent_name, subchatIndex: row.conversation_index };
}

/** Inserts a conversation, only while its parent is a conversation of the owner's live workspace. */
export function prepareInsertConversation(
  db: D1Database,
  args: {
    workspaceId: string;
    initialId: string;
    conversationIndex: number;
    parent: { conversationIndex: number; revision: number };
    ownerId: string;
    transitionToken: string;
  },
): D1PreparedStatement {
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO conversations (
        workspace_id, conversation_index, agent_name,
        parent_conversation_index, parent_revision, transition_token, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      FROM conversations
      WHERE workspace_id = ? AND conversation_index = ?
        AND EXISTS (
          SELECT 1 FROM workspaces
          WHERE workspaces.id = conversations.workspace_id AND workspaces.creator_id = ? AND workspaces.is_deleted = 0
        )`,
    )
    .bind(
      args.workspaceId,
      args.conversationIndex,
      transcriptAgentName(args.initialId, args.conversationIndex),
      args.parent.conversationIndex,
      args.parent.revision,
      args.transitionToken,
      now,
      now,
      args.workspaceId,
      args.parent.conversationIndex,
      args.ownerId,
    );
}
