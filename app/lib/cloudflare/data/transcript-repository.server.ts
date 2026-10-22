import { transcriptAgentName, type TranscriptIdentity } from 'cloudchef-agent/transcript';
import type { ChatTranscriptRow } from './types';

export async function requireChatTranscript(
  db: D1Database,
  args: { chatId: string; subchatIndex: number },
): Promise<ChatTranscriptRow> {
  const transcript = await db
    .prepare('SELECT * FROM chat_transcripts WHERE chat_id = ? AND subchat_index = ?')
    .bind(args.chatId, args.subchatIndex)
    .first<ChatTranscriptRow>();
  if (!transcript) {
    throw new Error('Chat transcript not found');
  }
  return transcript;
}

export function transcriptIdentity(row: ChatTranscriptRow): TranscriptIdentity {
  return { agentName: row.agent_name, subchatIndex: row.subchat_index };
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
      `INSERT INTO chat_transcripts (
        chat_id, subchat_index, generation, agent_name,
        parent_subchat_index, parent_generation, parent_revision, transition_token, created_at, updated_at
      )
      SELECT ?, ?, 0, ?, ?, 0, ?, ?, ?, ?
      FROM chat_transcripts
      WHERE chat_id = ? AND subchat_index = ?
        AND EXISTS (
          SELECT 1 FROM chats
          WHERE chats.id = chat_transcripts.chat_id AND chats.creator_id = ? AND chats.is_deleted = 0
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
