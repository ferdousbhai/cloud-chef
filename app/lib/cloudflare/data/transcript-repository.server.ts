import { transcriptAgentName, type TranscriptIdentity } from 'cloudchef-agent/transcript';
import type { ChatTranscriptRow } from './types';

export async function requireChatTranscript(
  db: D1Database,
  args: { chatId: string; subchatIndex: number },
): Promise<ChatTranscriptRow> {
  const transcript = await db
    .prepare('SELECT * FROM conversations WHERE workspace_id = ? AND conversation_index = ?')
    .bind(args.chatId, args.subchatIndex)
    .first<ChatTranscriptRow>();
  if (!transcript) {
    throw new Error('Chat transcript not found');
  }
  return transcript;
}

export function transcriptIdentity(row: ChatTranscriptRow): TranscriptIdentity {
  return { agentName: row.agent_name, subchatIndex: row.conversation_index };
}

/** Inserts a subchat's transcript, only while its parent is a transcript of the owner's live chat. */
export function prepareInsertChatTranscript(
  db: D1Database,
  args: {
    chatId: string;
    initialId: string;
    subchatIndex: number;
    parent: { subchatIndex: number; revision: number };
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
      args.chatId,
      args.subchatIndex,
      transcriptAgentName(args.initialId, args.subchatIndex),
      args.parent.subchatIndex,
      args.parent.revision,
      args.transitionToken,
      now,
      now,
      args.chatId,
      args.parent.subchatIndex,
      args.ownerId,
    );
}
