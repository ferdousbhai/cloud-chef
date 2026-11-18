/**
 * `@cloudchef` runs (docs/proposals/comment-threads.md, `thread_runs`): one chat per person per thread, in that
 * person's own space. `chat_id` is the chat's initial id in their workspace runtime; `access` is what the latest
 * mention was decided to get ('edit' or 'read'); `answering_id` is the comment whose mention the running turn
 * answers, NULL while no mention turn runs. At most one mention turn runs per person per thread.
 */

export type ThreadRunAccess = 'edit' | 'read';

/**
 * Claims the person's run of a thread for a mention: the chat its turn goes to, and whether that chat is new (none
 * yet, or one of the other kind because their access changed since). `busy` while a mention turn of theirs runs in
 * the thread.
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
): Promise<{ status: 'claimed'; chatId: string; fresh: boolean } | { status: 'busy' }> {
  const now = args.now ?? Date.now();
  const inserted = await db
    .prepare(
      `INSERT INTO thread_runs (thread_id, user_id, chat_id, access, answering_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id, user_id) DO NOTHING`,
    )
    .bind(args.threadId, args.userId, args.newChatId, args.access, args.commentId, now)
    .run();
  if (inserted.meta.changes === 1) {
    return { status: 'claimed', chatId: args.newChatId, fresh: true };
  }
  // Theirs already: the same chat while the access is the same, a new one of the other kind when it changed.
  const claimed = await db
    .prepare(
      `UPDATE thread_runs SET answering_id = ?3,
         chat_id = CASE WHEN access = ?4 THEN chat_id ELSE ?5 END,
         access = ?4
       WHERE thread_id = ?1 AND user_id = ?2 AND answering_id IS NULL
       RETURNING chat_id, chat_id = ?5 AS fresh`,
    )
    .bind(args.threadId, args.userId, args.commentId, args.access, args.newChatId)
    .first<{ chat_id: string; fresh: number }>();
  return claimed ? { status: 'claimed', chatId: claimed.chat_id, fresh: claimed.fresh === 1 } : { status: 'busy' };
}

/** The chat the person's workspace runtime opened for the run (a project's chat is the one it already had). */
export async function setThreadRunChat(
  db: D1Database,
  args: { threadId: string; userId: string; chatId: string },
): Promise<void> {
  await db
    .prepare('UPDATE thread_runs SET chat_id = ? WHERE thread_id = ? AND user_id = ?')
    .bind(args.chatId, args.threadId, args.userId)
    .run();
}

/**
 * The mention turn answering `commentId` ended (or never started): no turn runs any more. Whether it was the one
 * running, in the chat `chatId` when one is named; only then is its answer posted.
 */
export async function endThreadRun(
  db: D1Database,
  args: { threadId: string; userId: string; commentId: string; chatId?: string },
): Promise<boolean> {
  const ended = await db
    .prepare(
      `UPDATE thread_runs SET answering_id = NULL
       WHERE thread_id = ?1 AND user_id = ?2 AND answering_id = ?3 AND (?4 IS NULL OR chat_id = ?4)`,
    )
    .bind(args.threadId, args.userId, args.commentId, args.chatId ?? null)
    .run();
  return ended.meta.changes === 1;
}

/**
 * Whether the chat `chatId` may close the thread now: a mention of `userId`'s in it started the chat's running turn,
 * with edit access.
 */
export async function chatMayCloseThread(
  db: D1Database,
  args: { threadId: string; userId: string; chatId: string },
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM thread_runs
       WHERE thread_id = ? AND user_id = ? AND chat_id = ? AND access = 'edit' AND answering_id IS NOT NULL`,
    )
    .bind(args.threadId, args.userId, args.chatId)
    .first<{ found: number }>();
  return row !== null;
}
