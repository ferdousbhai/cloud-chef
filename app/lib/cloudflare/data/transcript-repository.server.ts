import {
  CURRENT_TRANSCRIPT_GENERATION,
  transcriptAgentName,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
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
  return {
    agentName: row.agent_name,
    generation: row.generation,
    subchatIndex: row.subchat_index,
  };
}

export function prepareInsertChatTranscript(
  db: D1Database,
  args: {
    chatId: string;
    initialId: string;
    subchatIndex: number;
    parent?: { subchatIndex: number; generation: number; revision: number } | null;
    ownerId: string;
    transitionToken?: string;
    now?: number;
  },
): D1PreparedStatement {
  const generation = CURRENT_TRANSCRIPT_GENERATION;
  const now = args.now ?? Date.now();
  const values = [
    args.chatId,
    args.subchatIndex,
    generation,
    transcriptAgentName(args.initialId, args.subchatIndex, generation),
    args.parent?.subchatIndex ?? null,
    args.parent?.generation ?? null,
    args.parent?.revision ?? null,
    args.transitionToken ?? crypto.randomUUID(),
    now,
    now,
  ];
  if (args.parent) {
    return db
      .prepare(
        `INSERT INTO chat_transcripts (
          chat_id, subchat_index, generation, agent_name,
          parent_subchat_index, parent_generation, parent_revision, transition_token, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM chat_transcripts
        WHERE chat_id = ? AND subchat_index = ? AND generation = ?
          AND EXISTS (
            SELECT 1 FROM chats
            WHERE chats.id = chat_transcripts.chat_id AND chats.creator_id = ? AND chats.is_deleted = 0
          )`,
      )
      .bind(...values, args.chatId, args.parent.subchatIndex, args.parent.generation, args.ownerId);
  }
  return db
    .prepare(
      `INSERT INTO chat_transcripts (
        chat_id, subchat_index, generation, agent_name,
        parent_subchat_index, parent_generation, parent_revision, transition_token, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM chats
        WHERE chats.id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
      )`,
    )
    .bind(...values, args.chatId, args.ownerId);
}
