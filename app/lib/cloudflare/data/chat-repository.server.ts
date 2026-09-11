import type { ChatRow } from './types';
import { DataNotFoundError } from './errors';

const CHAT_COLUMNS =
  'chats.id, chats.creator_id, chats.initial_id, chats.description, chats.timestamp, chats.last_subchat_index, chats.has_messages, chats.is_deleted';

/**
 * Create the chat catalog row and its BuilderAgent transcript identity, or bring back the one a
 * failed first message discarded.
 *
 * The homepage pins its chat id for the life of the page, so the ordinary "send failed, try again"
 * path re-initializes an id whose row `discardEmptyChat` has already soft-deleted. Without the
 * revive the insert matched nothing, the owner-scoped read below found nothing, and every later
 * send failed with a generic 500 until the page was reloaded.
 */
export async function ensureInitialChat(
  db: D1Database,
  args: { id: string; creatorId: string; initialId: string },
): Promise<ChatRow & { created: boolean }> {
  const createdAt = Date.now();
  const results = await db.batch([
    // Revive first, so the insert below sees an active row and stays a no-op: a second row for the
    // same initial_id would violate the partial unique index on (creator_id, initial_id), and its
    // transcript would collide on the globally unique agent_name the surviving one still holds.
    // Only a still-empty chat is eligible; a discarded chat that ever accepted content is not.
    db
      .prepare(
        `UPDATE chats
         SET is_deleted = 0
         WHERE id = (
           SELECT id FROM chats
           WHERE creator_id = ? AND initial_id = ? AND is_deleted = 1 AND has_messages = 0
           ORDER BY timestamp DESC, id DESC
           LIMIT 1
         )`,
      )
      .bind(args.creatorId, args.initialId),
    // The discard queued this chat's BuilderAgent and app resources for deletion. A revived chat
    // has to drop those receipts, or the sweep destroys the Agent it was just given back. An
    // active chat has candidates only because it was discarded, so this is scoped to the revival.
    db
      .prepare(
        `DELETE FROM agent_gc_candidates
         WHERE chat_id IN (
           SELECT id FROM chats WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         )`,
      )
      .bind(args.creatorId, args.initialId),
    db
      .prepare(
        `DELETE FROM app_resource_gc_candidates
         WHERE chat_id IN (
           SELECT id FROM chats WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         )`,
      )
      .bind(args.creatorId, args.initialId),
    db
      .prepare(
        `INSERT INTO chats (
          id, creator_id, initial_id, description, timestamp, last_subchat_index, has_messages, is_deleted
        )
        SELECT ?, ?, ?, NULL, ?, 0, 0, 0
        WHERE NOT EXISTS (SELECT 1 FROM chats WHERE initial_id = ?)
        ON CONFLICT DO NOTHING`,
      )
      .bind(args.id, args.creatorId, args.initialId, new Date().toISOString(), args.initialId),
    db
      .prepare(
        `INSERT INTO chat_transcripts (
          chat_id, subchat_index, generation, agent_name,
          parent_subchat_index, parent_generation, parent_revision, transition_token,
          created_at, updated_at
        )
        SELECT chats.id, 0, 0, chats.initial_id, NULL, NULL, NULL, ?, ?, ?
        FROM chats
        WHERE chats.id = ? AND chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
        ON CONFLICT(chat_id, subchat_index) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), createdAt, createdAt, args.id, args.creatorId, args.initialId),
  ]);

  const chat = await db
    .prepare(
      `SELECT ${CHAT_COLUMNS} FROM chats
       WHERE chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.creatorId, args.initialId)
    .first<ChatRow>();
  if (!chat) {
    throw new DataNotFoundError('Unable to initialize chat');
  }
  // A revived chat is empty again, so a second failed submission must still be able to discard it.
  return { ...chat, created: results[0].meta.changes > 0 || results[3].meta.changes > 0 };
}

export function findChat(db: D1Database, args: { id: string; sessionId: string }): Promise<ChatRow | null> {
  return db
    .prepare(
      `SELECT ${CHAT_COLUMNS} FROM chats
       WHERE chats.creator_id = ? AND chats.initial_id = ? AND chats.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.sessionId, args.id)
    .first<ChatRow>();
}

export async function requireChat(db: D1Database, args: { id: string; sessionId: string }): Promise<ChatRow> {
  const chat = await findChat(db, args);
  if (!chat) {
    throw new DataNotFoundError('Chat not found');
  }
  return chat;
}

/** Record only the catalog fact that an Agent accepted content; the Agent owns the checkpoint. */
export async function markChatStarted(
  db: D1Database,
  args: { sessionId: string; chatId: string; agentName: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE chats
       SET has_messages = 1
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM chat_transcripts
           WHERE chat_transcripts.chat_id = chats.id AND chat_transcripts.agent_name = ?
         )`,
    )
    .bind(args.sessionId, args.chatId, args.agentName)
    .run();
}
