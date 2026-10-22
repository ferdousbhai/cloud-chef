import { ensureInitialChat, findChat, requireChat } from './chat-repository.server';
import { prepareInsertChatTranscript } from './transcript-repository.server';
import type { ChatRow, ChatTranscriptRow } from './types';
import { prepareAgentGcCandidatesStatement } from './agent-gc.server';
import { MAX_SUBCHAT_INDEX } from '~/lib/cloudflare/data-operation-schemas';
import { DataNotFoundError, SubchatLimitError } from './errors';
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
  return { description: chat.description ?? undefined };
}

export async function getAllChats(db: D1Database, args: { sessionId: string }) {
  const { results } = await db
    .prepare(
      `SELECT
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
         -- A GitHub project's chat is listed with the GitHub projects, not as an app of one's own.
         AND chats.org_project_id IS NULL
       ORDER BY chats.timestamp DESC, chats.id DESC`,
    )
    .bind(args.sessionId)
    .all<{
      initial_id: string;
      description: string | null;
      timestamp: string;
    }>();
  return results.map((row) => ({
    id: row.initial_id,
    initialId: row.initial_id,
    description: row.description ?? undefined,
    timestamp: row.timestamp,
  }));
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
    throw new DataNotFoundError('Chat not found');
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
    // Removing a GitHub project's current conversation hands the project back to the one it continued,
    // the latest earlier one, rather than leaving that one read-only with nothing current to work in.
    // After the removal above, in the same transaction, so the project never has two current ones.
    db
      .prepare(
        `UPDATE chats
         SET archived_at = NULL
         WHERE id = (
           SELECT previous.id FROM chats AS previous
           WHERE previous.creator_id = ?1 AND previous.is_deleted = 0 AND previous.archived_at IS NOT NULL
             AND previous.org_project_id = (
               SELECT removed.org_project_id FROM chats AS removed
               WHERE removed.creator_id = ?1 AND removed.initial_id = ?2 AND removed.is_deleted = 1
               ORDER BY removed.timestamp DESC LIMIT 1
             )
             AND NOT EXISTS (
               SELECT 1 FROM chats AS current
               WHERE current.creator_id = ?1 AND current.org_project_id = previous.org_project_id
                 AND current.is_deleted = 0 AND current.archived_at IS NULL
             )
           ORDER BY previous.archived_at DESC LIMIT 1
         )`,
      )
      .bind(args.sessionId, args.id),
  ]);
  return { kind: 'success' } as const;
}

export async function getSubchats(db: D1Database, args: { sessionId: string; chatId: string }) {
  const chat = await requireChat(db, { id: args.chatId, sessionId: args.sessionId });
  const { results } = await db
    .prepare(
      `SELECT subchat_index, description, updated_at, agent_name
       FROM chat_transcripts
       WHERE chat_id = ?
       ORDER BY subchat_index ASC`,
    )
    .bind(chat.id)
    .all<{
      subchat_index: number;
      description: string | null;
      updated_at: number;
      agent_name: string;
    }>();
  return results.map((row) => ({
    subchatIndex: row.subchat_index,
    description: row.description ?? undefined,
    updatedAt: row.updated_at,
    transcript: { agentName: row.agent_name, subchatIndex: row.subchat_index },
  }));
}

/**
 * Adds the chat's next subchat, continuing `parent`, its latest. The batch commits only while the chat
 * still ends at that parent, so values read earlier cannot add a second subchat at the same index.
 */
export async function createSubchat(
  db: D1Database,
  args: { sessionId: string; chat: ChatRow; parent: ChatTranscriptRow; parentRevision: number },
) {
  const { chat, parent } = args;
  if (chat.last_subchat_index >= MAX_SUBCHAT_INDEX) {
    throw new SubchatLimitError();
  }
  const newSubchatIndex = chat.last_subchat_index + 1;
  const transitionToken = crypto.randomUUID();
  const results = await db.batch([
    prepareInsertChatTranscript(db, {
      chatId: chat.id,
      initialId: chat.initial_id,
      subchatIndex: newSubchatIndex,
      parent: { subchatIndex: parent.subchat_index, revision: args.parentRevision },
      ownerId: args.sessionId,
      transitionToken,
    }),
    db
      .prepare(
        `UPDATE chats
         SET last_subchat_index = ?
         WHERE id = ? AND last_subchat_index = ? AND EXISTS (
           SELECT 1 FROM chat_transcripts
           WHERE chat_id = ? AND subchat_index = ? AND transition_token = ?
         )`,
      )
      .bind(newSubchatIndex, chat.id, chat.last_subchat_index, chat.id, newSubchatIndex, transitionToken),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('Chat transcript changed while creating a subchat; retry the operation');
  }
  return newSubchatIndex;
}
