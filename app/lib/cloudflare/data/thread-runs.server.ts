/**
 * `@cloudchef` runs (docs/proposals/comment-threads.md). `thread_runs` keeps which chat a person's mentions in a thread
 * go to, in their own space: `chat_id` is the chat's initial id in their workspace runtime, `access` what their latest
 * mention was decided to get ('edit' or 'read'). `mention_requests` keeps each mention until its answer is posted: a
 * person may ask again while CloudChef is still working, and their chat answers them one after another.
 */

export type ThreadRunAccess = 'edit' | 'read';

/** A mention not answered after this long is taken as lost: the thread stops showing CloudChef at work on it. */
export const MENTION_STALE_MS = 12 * 60 * 60_000;

/**
 * Records a mention, and the chat it goes to: the person's chat for the thread, or a new one when they have none yet,
 * or have one of the other kind because their access changed since.
 */
export async function claimThreadRun(
  db: D1Database,
  args: {
    threadId: string;
    userId: string;
    access: ThreadRunAccess;
    commentId: string;
    /** The chat id a new chat gets. */
    newChatId: string;
    now?: number;
  },
): Promise<{ chatId: string; fresh: boolean }> {
  const now = args.now ?? Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO mention_requests (comment_id, thread_id, user_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (comment_id) DO NOTHING`,
      )
      .bind(args.commentId, args.threadId, args.userId, now),
    db
      .prepare(
        `INSERT INTO thread_runs (thread_id, user_id, chat_id, access, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (thread_id, user_id) DO UPDATE SET
           chat_id = CASE WHEN access = ?4 THEN chat_id ELSE ?3 END,
           access = ?4`,
      )
      .bind(args.threadId, args.userId, args.newChatId, args.access, now),
  ]);
  const row = await db
    .prepare('SELECT chat_id FROM thread_runs WHERE thread_id = ? AND user_id = ?')
    .bind(args.threadId, args.userId)
    .first<{ chat_id: string }>();
  const chatId = row?.chat_id ?? args.newChatId;
  return { chatId, fresh: chatId === args.newChatId };
}

/** The chat the person's workspace runtime took the mention into (a project's chat is the one it already had). */
export async function setThreadRunChat(
  db: D1Database,
  args: { threadId: string; userId: string; commentId: string; chatId: string },
): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE thread_runs SET chat_id = ? WHERE thread_id = ? AND user_id = ?')
      .bind(args.chatId, args.threadId, args.userId),
    db
      .prepare('UPDATE mention_requests SET chat_id = ? WHERE comment_id = ? AND user_id = ?')
      .bind(args.chatId, args.commentId, args.userId),
  ]);
}

/**
 * The mention `commentId` was answered, or given up: true the first time only, and only for the chat it was sent to
 * when `chatId` is named, so its answer is posted once.
 */
export async function endThreadRun(
  db: D1Database,
  args: { threadId: string; userId: string; commentId: string; chatId?: string; now?: number },
): Promise<boolean> {
  const ended = await db
    .prepare(
      `UPDATE mention_requests SET answered_at = ?5
       WHERE comment_id = ?3 AND thread_id = ?1 AND user_id = ?2 AND answered_at IS NULL
         AND (?4 IS NULL OR chat_id IS NULL OR chat_id = ?4)`,
    )
    .bind(args.threadId, args.userId, args.commentId, args.chatId ?? null, args.now ?? Date.now())
    .run();
  return ended.meta.changes === 1;
}

/**
 * Whether the chat `chatId` may close the thread now: a mention of `userId`'s in this thread, sent to that chat with
 * edit access, is still unanswered.
 */
export async function chatMayCloseThread(
  db: D1Database,
  args: { threadId: string; userId: string; chatId: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM thread_runs
       JOIN mention_requests AS requests ON requests.thread_id = thread_runs.thread_id
         AND requests.user_id = thread_runs.user_id AND requests.answered_at IS NULL AND requests.chat_id = ?3
       WHERE thread_runs.thread_id = ?1 AND thread_runs.user_id = ?2 AND thread_runs.access = 'edit'`,
    )
    .bind(args.threadId, args.userId, args.chatId)
    .first<{ found: number }>();
  return row !== null;
}
