import { ensureInitialChat, findChat, requireChat } from './chat-repository.server';
import { transcriptAgentName } from 'cloudchef-agent/transcript';
import { prepareInsertChatTranscript, requireChatTranscript } from './transcript-repository.server';
import { prepareAgentGcCandidatesStatement } from './agent-gc.server';
import {
  boundedDataPageSize,
  MAX_SUBCHAT_INDEX,
  type ChatHistoryCursor,
  type SubchatCursor,
} from '~/lib/cloudflare/data-pagination';
import { SubchatLimitError } from './errors';
import { EMPTY_CHAT_DISCARD_PREDICATE } from './empty-chat.server';
import { prepareAppResourceGcCandidateStatement } from './app-resource-gc.server';

export async function initializeChat(
  db: D1Database,
  args: { sessionId: string; id: string },
): Promise<{ created: boolean }> {
  const chat = await ensureInitialChat(db, { id: crypto.randomUUID(), creatorId: args.sessionId, initialId: args.id });
  return { created: chat.created };
}

export async function discardEmptyChat(db: D1Database, args: { sessionId: string; id: string }): Promise<null> {
  await db.batch([
    prepareAgentGcCandidatesStatement(db, { ownerId: args.sessionId, initialId: args.id, requireEmpty: true }),
    prepareAppResourceGcCandidateStatement(db, {
      ownerId: args.sessionId,
      initialId: args.id,
      requireEmpty: true,
    }),
    db
      .prepare(
        `UPDATE chats
         SET is_deleted = 1
         WHERE creator_id = ? AND initial_id = ?
           AND ${EMPTY_CHAT_DISCARD_PREDICATE}`,
      )
      .bind(args.sessionId, args.id),
  ]);
  return null;
}

export async function getChat(db: D1Database, args: { id: string; sessionId: string }) {
  const chat = await findChat(db, args);
  if (!chat) {
    return null;
  }
  return {
    initialId: chat.initial_id,
    description: chat.description ?? undefined,
    timestamp: chat.timestamp,
    subchatIndex: chat.last_subchat_index,
  };
}

export async function getAllChats(
  db: D1Database,
  args: { sessionId: string; cursor?: ChatHistoryCursor; limit?: number },
) {
  const limit = boundedDataPageSize(args.limit);
  const cursorClause = args.cursor ? 'AND (chats.timestamp, chats.id) < (?, ?)' : '';
  const { results } = await db
    .prepare(
      `SELECT
         chats.id AS row_id,
         chats.initial_id,
         COALESCE(
           NULLIF(TRIM(chats.description), ''),
           (
             SELECT NULLIF(TRIM(chat_transcripts.description), '')
             FROM chat_transcripts
             WHERE chat_transcripts.chat_id = chats.id
               AND chat_transcripts.description IS NOT NULL
               AND TRIM(chat_transcripts.description) <> ''
             ORDER BY chat_transcripts.subchat_index ASC
             LIMIT 1
           )
         ) AS description,
         chats.timestamp
       FROM chats
       WHERE chats.creator_id = ? AND chats.is_deleted = 0
         AND chats.has_messages = 1
         ${cursorClause}
       ORDER BY chats.timestamp DESC, chats.id DESC
       LIMIT ?`,
    )
    .bind(args.sessionId, ...(args.cursor ? [args.cursor.timestamp, args.cursor.rowId] : []), limit + 1)
    .all<{
      row_id: string;
      initial_id: string;
      description: string | null;
      timestamp: string;
    }>();
  const pageRows = results.slice(0, limit);
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
      id: row.initial_id,
      initialId: row.initial_id,
      description: row.description ?? undefined,
      timestamp: row.timestamp,
    })),
    nextCursor:
      results.length > limit && lastRow
        ? {
            timestamp: lastRow.timestamp,
            rowId: lastRow.row_id,
          }
        : undefined,
  };
}

export async function setDescription(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<null> {
  const chat = await requireChat(db, { id: args.id, sessionId: args.sessionId });
  await db
    .prepare(`UPDATE chats SET description = ?, description_source = 'user' WHERE id = ?`)
    .bind(args.description, chat.id)
    .run();
  return null;
}

export async function setHeuristicProjectDescriptionIfMissing(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE chats
       SET description = ?, description_source = 'heuristic'
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         AND description_source IS NULL
         AND NULLIF(TRIM(description), '') IS NULL`,
    )
    .bind(args.description, args.sessionId, args.id)
    .run();
  return result.meta.changes > 0;
}

/** Finalize the one automatic project title; later prompts never call this transition. */
export async function setGeneratedProjectDescription(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE chats
       SET description = ?, description_source = 'generated'
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         AND (
           description_source = 'heuristic'
           OR (description_source IS NULL AND NULLIF(TRIM(description), '') IS NULL)
         )`,
    )
    .bind(args.description, args.sessionId, args.id)
    .run();
  return result.meta.changes > 0;
}

/** Apply an automatic conversation title unless a manual rename or newer prompt won. */
export async function setGeneratedSubchatDescription(
  db: D1Database,
  args: {
    sessionId: string;
    id: string;
    subchatIndex: number;
    description: string;
    promptGeneration: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE chat_transcripts
       SET description = ?, description_source = 'generated', description_generation = ?
       WHERE chat_id = (
         SELECT id FROM chats
         WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
       )
         AND subchat_index = ?
         AND description_generation <= ?
         AND (
           description_source IN ('heuristic', 'generated')
           OR (description_source IS NULL AND description IS NULL)
         )`,
    )
    .bind(args.description, args.promptGeneration, args.sessionId, args.id, args.subchatIndex, args.promptGeneration)
    .run();
  return result.meta.changes > 0;
}

export async function setHeuristicSubchatDescriptionIfMissing(
  db: D1Database,
  args: { sessionId: string; id: string; subchatIndex: number; description: string; promptGeneration: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE chat_transcripts
       SET description = ?, description_source = 'heuristic', description_generation = ?
       WHERE chat_id = (
         SELECT id FROM chats
         WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
       )
         AND subchat_index = ?
         AND description_source IS NULL
         AND description IS NULL`,
    )
    .bind(args.description, args.promptGeneration, args.sessionId, args.id, args.subchatIndex)
    .run();
  return result.meta.changes > 0;
}

export async function setSubchatDescription(
  db: D1Database,
  args: { sessionId: string; chatId: string; subchatIndex: number; description: string },
): Promise<null> {
  const result = await db
    .prepare(
      `UPDATE chat_transcripts
       SET description = ?, description_source = 'user'
       WHERE chat_id = (
         SELECT id FROM chats
         WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
       )
         AND subchat_index = ?`,
    )
    .bind(args.description, args.sessionId, args.chatId, args.subchatIndex)
    .run();
  if (result.meta.changes === 0) {
    throw new Error('Chat not found');
  }
  return null;
}

export async function removeChat(db: D1Database, args: { sessionId: string; id: string }) {
  await db.batch([
    prepareAgentGcCandidatesStatement(db, { initialId: args.id, ownerId: args.sessionId }),
    prepareAppResourceGcCandidateStatement(db, { initialId: args.id, ownerId: args.sessionId }),
    db
      .prepare(
        `UPDATE chats
         SET is_deleted = 1
         WHERE initial_id = ? AND creator_id = ? AND is_deleted = 0`,
      )
      .bind(args.id, args.sessionId),
  ]);
  return { kind: 'success' } as const;
}

export async function getSubchats(
  db: D1Database,
  args: { sessionId: string; chatId: string; cursor?: SubchatCursor; limit?: number },
) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const limit = boundedDataPageSize(args.limit);
  const cursorSubchatIndex = args.cursor?.subchatIndex ?? -1;
  const { results } = await db
    .prepare(
      `SELECT subchat_index, description, updated_at, generation, agent_name
       FROM chat_transcripts
       WHERE chat_id = ? AND subchat_index > ?
       ORDER BY subchat_index ASC
       LIMIT ?`,
    )
    .bind(chat.id, cursorSubchatIndex, limit + 1)
    .all<{
      subchat_index: number;
      description: string | null;
      updated_at: number;
      generation: number;
      agent_name: string;
    }>();
  const pageRows = results.slice(0, limit);
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({
      subchatIndex: row.subchat_index,
      description: row.description ?? undefined,
      updatedAt: row.updated_at,
      transcript: {
        agentName: row.agent_name,
        generation: row.generation,
        subchatIndex: row.subchat_index,
      },
    })),
    nextCursor:
      results.length > limit && lastRow
        ? {
            subchatIndex: lastRow.subchat_index,
          }
        : undefined,
  };
}

export async function createSubchat(
  db: D1Database,
  args: { sessionId: string; chatId: string; parentRevision: number },
) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  if (chat.last_subchat_index >= MAX_SUBCHAT_INDEX) {
    throw new SubchatLimitError();
  }
  const newSubchatIndex = chat.last_subchat_index + 1;
  const parentTranscript = await requireChatTranscript(db, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
  });
  const now = Date.now();
  const transitionToken = crypto.randomUUID();
  const parentRevision = args.parentRevision;
  const agentName = transcriptAgentName(chat.initial_id, newSubchatIndex, 0);
  let results: D1Result[];
  try {
    results = await db.batch([
      prepareInsertChatTranscript(db, {
        chatId: chat.id,
        initialId: chat.initial_id,
        subchatIndex: newSubchatIndex,
        parent: {
          subchatIndex: parentTranscript.subchat_index,
          generation: parentTranscript.generation,
          revision: parentRevision,
        },
        ownerId: args.sessionId,
        transitionToken,
        now,
      }),
      db
        .prepare(
          `UPDATE chats
           SET last_subchat_index = ?
           WHERE id = ? AND last_subchat_index = ? AND EXISTS (
             SELECT 1 FROM chat_transcripts
             WHERE chat_id = ? AND subchat_index = ? AND generation = 0 AND transition_token = ?
           )`,
        )
        .bind(newSubchatIndex, chat.id, chat.last_subchat_index, chat.id, newSubchatIndex, transitionToken),
    ]);
  } catch (error) {
    try {
      const committed = await db
        .prepare(
          `SELECT 1 AS found
           FROM chats
           JOIN chat_transcripts AS transcripts ON transcripts.chat_id = chats.id
           WHERE chats.id = ? AND chats.creator_id = ? AND chats.is_deleted = 0
             AND chats.last_subchat_index = ?
             AND transcripts.subchat_index = ? AND transcripts.generation = 0
             AND transcripts.agent_name = ? AND transcripts.transition_token = ?
             AND transcripts.parent_subchat_index = ? AND transcripts.parent_generation = ?
             AND transcripts.parent_revision = ?
           LIMIT 1`,
        )
        .bind(
          chat.id,
          args.sessionId,
          newSubchatIndex,
          newSubchatIndex,
          agentName,
          transitionToken,
          parentTranscript.subchat_index,
          parentTranscript.generation,
          parentRevision,
        )
        .first<{ found: number }>();
      if (committed) {
        return newSubchatIndex;
      }
    } catch {
      // Preserve the original batch failure when the commit receipt cannot be read.
    }
    throw error;
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('Chat transcript changed while creating a subchat; retry the operation');
  }
  return newSubchatIndex;
}
