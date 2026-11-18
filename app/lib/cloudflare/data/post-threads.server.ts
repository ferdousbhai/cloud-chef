import type { CloseReason, NotificationView, PostComment, PostThread, ThreadState } from '~/lib/showcase';
import { COMMENT_MAX } from '~/lib/showcase';
import { findAccessibleProject } from './org-projects.server';
import {
  COMMENTS_PER_DAY,
  ShowcaseError,
  captionProblem,
  findPublicPostFacts,
  type PublicPostFacts,
} from './posts.server';

/**
 * Comment threads (docs/proposals/comment-threads.md): a post's comments, where each top-level comment starts a
 * thread, the post's issue. A thread is numbered on its post, has replies one level deep, is open, on its way or
 * closed with a reason, can be locked and pinned, and is followed by the people in it.
 *
 * Who may do what: anyone signed in with a username comments; people who can edit the project ("editors") and the
 * thread's starter close and reopen it; editors lock and pin; the writer or an editor deletes a comment.
 */

const DAY_MS = 24 * 60 * 60_000;
/** Threads a post's page shows, pinned and open ones first. */
const THREADS_SHOWN = 200;
/** Replies shown under each thread before "Show N more". */
const REPLIES_SHOWN = 3;
const PINNED_MAX = 3;
/** People one comment can notify by mentioning them. */
const MENTIONS_MAX = 5;

const MENTION = /(?<![\w@./-])@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})(?![\w-])/gi;

/** The usernames a comment mentions with `@`, lowercased, in order, without `cloudchef`. */
export function mentionedUsernames(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    const name = match[1].toLowerCase();
    if (name !== 'cloudchef') {
      names.add(name);
    }
  }
  return [...names];
}

/** Whether a comment asks CloudChef, with `@cloudchef`. */
export function mentionsCloudChef(body: string): boolean {
  return [...body.matchAll(MENTION)].some((match) => match[1].toLowerCase() === 'cloudchef');
}

/** May `userId` edit the project: a member or share with the edit role. */
export async function canEditProject(db: D1Database, projectId: string, userId: string): Promise<boolean> {
  return (await findAccessibleProject(db, projectId, userId))?.role === 'edit';
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

type CommentRow = {
  id: string;
  body: string;
  created_at: number;
  author_id: string;
  by_agent: number;
  username: string | null;
  name: string;
  image: string | null;
};

const COMMENT_COLUMNS = `comments.id, comments.body, comments.created_at, comments.author_id, comments.by_agent,
  people.username, people.name, people.image`;

/** A comment anyone may see: visible, by someone whose page isn't paused. */
const SHOWN = `comments.status = 'visible' AND people.showcase_paused_at IS NULL`;

function toComment(row: CommentRow): PostComment {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: { username: row.username, name: row.name, image: row.image },
    byAgent: row.by_agent === 1,
  };
}

type ThreadRow = CommentRow & {
  post_id: string;
  number: number;
  kind: 'comment' | 'suggestion';
  state: ThreadState;
  close_reason: CloseReason | null;
  same_as: number | null;
  state_at: number | null;
  locked: number;
  pinned_at: number | null;
  active_at: number;
  commit_sha: string | null;
  live_commit: string;
  reply_count: number;
  working: number;
  suggested_name: string | null;
  suggested_path: string | null;
  suggested_site: string | null;
  following: number | null;
};

/** A thread's columns; `?1` is the viewer's id (or ''). */
const THREAD_COLUMNS = `${COMMENT_COLUMNS}, comments.post_id, comments.number, comments.kind, comments.state,
  comments.close_reason, (SELECT same.number FROM post_comments AS same WHERE same.id = comments.duplicate_of) AS same_as,
  comments.state_at, comments.locked, comments.pinned_at, comments.active_at, comments.commit_sha,
  posts.commit_sha AS live_commit,
  (SELECT COUNT(*) FROM post_comments AS replies JOIN "user" AS repliers ON repliers.id = replies.author_id
   WHERE replies.parent_id = comments.id AND replies.status = 'visible' AND repliers.showcase_paused_at IS NULL)
   AS reply_count,
  EXISTS (SELECT 1 FROM thread_runs WHERE thread_runs.thread_id = comments.id AND thread_runs.answering_id IS NOT NULL)
   AS working,
  copies.name AS suggested_name,
  CASE WHEN copy_posts.status = 'visible' AND copies.visibility = 'public' AND copy_owners.username IS NOT NULL
    THEN '/' || copy_owners.username || '/' || copies.slug END AS suggested_path,
  CASE WHEN copies.visibility = 'public' THEN copies.site_url END AS suggested_site,
  (SELECT 1 - followers.muted FROM thread_followers AS followers
   WHERE followers.thread_id = comments.id AND followers.user_id = ?1) AS following`;

const THREAD_FROM = `post_comments AS comments
  JOIN "user" AS people ON people.id = comments.author_id
  JOIN posts ON posts.id = comments.post_id
  LEFT JOIN org_projects AS copies ON copies.id = comments.suggested_project_id
  LEFT JOIN posts AS copy_posts ON copy_posts.project_id = copies.id
  LEFT JOIN "user" AS copy_owners ON copy_owners.id = copies.created_by`;

const THREAD_ORDER = `(comments.pinned_at IS NULL), comments.pinned_at,
  CASE comments.state WHEN 'open' THEN 0 WHEN 'on_its_way' THEN 1 ELSE 2 END, comments.active_at DESC`;

function toThread(row: ThreadRow, replies: PostComment[], viewer: { id: string; editor: boolean } | null): PostThread {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    state: row.state,
    closeReason: row.close_reason,
    sameAs: row.same_as,
    stateAt: row.state_at,
    locked: row.locked === 1,
    pinned: row.pinned_at !== null,
    activeAt: row.active_at,
    onEarlierVersion: row.commit_sha !== null && row.commit_sha !== row.live_commit,
    first: toComment(row),
    replies,
    replyCount: row.reply_count,
    suggestion:
      row.kind === 'suggestion' && row.suggested_name
        ? { name: row.suggested_name, path: row.suggested_path, siteUrl: row.suggested_site }
        : null,
    working: row.working === 1,
    viewer: viewer
      ? {
          following: row.following === 1,
          canClose: viewer.editor || row.author_id === viewer.id,
          canEdit: viewer.editor,
        }
      : null,
  };
}

/** The latest replies of each thread in `threadIds`, oldest first. */
async function latestReplies(db: D1Database, threadIds: readonly string[]): Promise<Map<string, PostComment[]>> {
  const replies = new Map<string, PostComment[]>();
  if (threadIds.length === 0) {
    return replies;
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT ${COMMENT_COLUMNS}, comments.parent_id,
           ROW_NUMBER() OVER (PARTITION BY comments.parent_id ORDER BY comments.created_at DESC, comments.rowid DESC) AS rank
         FROM post_comments AS comments JOIN "user" AS people ON people.id = comments.author_id
         WHERE comments.parent_id IN (SELECT value FROM json_each(?1)) AND ${SHOWN}
       ) WHERE rank <= ?2 ORDER BY created_at, rank DESC`,
    )
    .bind(JSON.stringify(threadIds), REPLIES_SHOWN)
    .all<CommentRow & { parent_id: string }>();
  for (const row of results) {
    const list = replies.get(row.parent_id) ?? [];
    list.push(toComment(row));
    replies.set(row.parent_id, list);
  }
  return replies;
}

async function viewerOf(
  db: D1Database,
  post: PublicPostFacts,
  viewerId: string | null,
): Promise<{ id: string; editor: boolean } | null> {
  return viewerId ? { id: viewerId, editor: await canEditProject(db, post.projectId, viewerId) } : null;
}

/** A post's threads as its page shows them: pinned first, then open, on its way and closed, by latest activity. */
export async function listThreads(
  db: D1Database,
  postId: string,
  viewerId: string | null,
): Promise<{ threads: PostThread[]; open: number }> {
  const post = await findPublicPostFacts(db, postId);
  if (!post) {
    return { threads: [], open: 0 };
  }
  const viewer = await viewerOf(db, post, viewerId);
  const { results } = await db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM ${THREAD_FROM}
       WHERE comments.post_id = ?2 AND comments.parent_id IS NULL AND ${SHOWN}
       ORDER BY ${THREAD_ORDER} LIMIT ?3`,
    )
    .bind(viewerId ?? '', postId, THREADS_SHOWN)
    .all<ThreadRow>();
  const replies = await latestReplies(
    db,
    results.map((row) => row.id),
  );
  const threads = results.map((row) => toThread(row, replies.get(row.id) ?? [], viewer));
  return { threads, open: await openThreadCount(db, postId) };
}

/** How many of a post's threads are open. */
export async function openThreadCount(db: D1Database, postId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM post_comments AS comments JOIN "user" AS people ON people.id = comments.author_id
       WHERE comments.post_id = ? AND comments.parent_id IS NULL AND comments.state = 'open' AND ${SHOWN}`,
    )
    .bind(postId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** One thread anyone may see, by id. */
export async function findThread(
  db: D1Database,
  threadId: string,
  viewerId: string | null,
): Promise<PostThread | null> {
  const row = await db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM ${THREAD_FROM}
       WHERE comments.id = ?2 AND comments.parent_id IS NULL AND ${SHOWN}`,
    )
    .bind(viewerId ?? '', threadId)
    .first<ThreadRow>();
  if (!row) {
    return null;
  }
  const post = await findPublicPostFacts(db, row.post_id);
  if (!post) {
    return null;
  }
  const replies = await latestReplies(db, [row.id]);
  return toThread(row, replies.get(row.id) ?? [], await viewerOf(db, post, viewerId));
}

/** Every visible reply of a thread, oldest first. */
export async function listReplies(db: D1Database, threadId: string): Promise<PostComment[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM post_comments AS comments JOIN "user" AS people ON people.id = comments.author_id
       WHERE comments.parent_id = ? AND ${SHOWN} ORDER BY comments.created_at, comments.rowid LIMIT 1000`,
    )
    .bind(threadId)
    .all<CommentRow>();
  return results.map(toComment);
}

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------

type Author = { username: string; name: string; image: string | null };

/** The writer of a new comment: with a username, page not paused, under the daily limit. */
async function requireWriter(db: D1Database, userId: string, now: number): Promise<Author> {
  const author = await db
    .prepare(
      `SELECT username, name, image, showcase_paused_at,
         (SELECT COUNT(*) FROM post_comments WHERE author_id = ?1 AND by_agent = 0 AND created_at > ?2) AS today
       FROM "user" WHERE id = ?1`,
    )
    .bind(userId, now - DAY_MS)
    .first<{
      username: string | null;
      name: string;
      image: string | null;
      showcase_paused_at: number | null;
      today: number;
    }>();
  if (!author?.username) {
    throw new ShowcaseError('Choose a username first, so people know who commented.', 409);
  }
  if (author.showcase_paused_at !== null) {
    throw new ShowcaseError('Your page is paused for review, so you can’t comment for now.', 403);
  }
  if (author.today >= COMMENTS_PER_DAY) {
    throw new ShowcaseError('You’ve commented a lot today. Try again tomorrow.', 429);
  }
  return { username: author.username, name: author.name, image: author.image };
}

function checkedBody(raw: string): string {
  const body = raw.trim();
  if (!body || body.length > COMMENT_MAX) {
    throw new ShowcaseError('Write a comment of up to 1,000 characters.', 400);
  }
  const problem = captionProblem(body);
  if (problem) {
    throw new ShowcaseError(problem.replace('caption', 'comment'), 400);
  }
  return body;
}

function notify(
  db: D1Database,
  args: {
    userId: string;
    kind: NotificationView['kind'];
    actorId: string | null;
    postId: string;
    commentId: string;
    detail: string | null;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifications (id, user_id, kind, actor_id, post_id, comment_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.userId,
      args.kind,
      args.actorId,
      args.postId,
      args.commentId,
      args.detail,
      Date.now(),
    );
}

function follow(db: D1Database, threadId: string, userId: string, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT OR IGNORE INTO thread_followers (thread_id, user_id, created_at) VALUES (?, ?, ?)')
    .bind(threadId, userId, now);
}

/** The ids of the people mentioned in `body` who have a username, at most a few. */
async function mentionedPeople(db: D1Database, body: string): Promise<string[]> {
  const names = mentionedUsernames(body).slice(0, MENTIONS_MAX);
  if (names.length === 0) {
    return [];
  }
  const { results } = await db
    .prepare(`SELECT id FROM "user" WHERE username IN (SELECT value FROM json_each(?)) AND showcase_paused_at IS NULL`)
    .bind(JSON.stringify(names))
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

/** Who is told of something in a thread: its followers who haven't muted it, and not `exceptIds`. */
async function followersOf(db: D1Database, threadId: string, exceptIds: readonly string[]): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id FROM thread_followers WHERE thread_id = ? AND muted = 0
         AND user_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .bind(threadId, JSON.stringify(exceptIds))
    .all<{ user_id: string }>();
  return results.map((row) => row.user_id);
}

async function nextNumber(db: D1Database, postId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM post_comments WHERE post_id = ?')
    .bind(postId)
    .first<{ next: number }>();
  return row?.next ?? 1;
}

/**
 * Starts a thread on a post anyone may see. Its starter and the post's author follow it; the post's author and anyone
 * mentioned are told. A suggestion names a public copy its writer can edit.
 */
export async function startThread(
  db: D1Database,
  args: { userId: string; postId: string; body: string; suggestFrom?: string; now?: number },
): Promise<PostThread> {
  const body = checkedBody(args.body);
  const post = await findPublicPostFacts(db, args.postId);
  if (!post) {
    throw new ShowcaseError('This post isn’t shown any more.', 404);
  }
  const now = args.now ?? Date.now();
  await requireWriter(db, args.userId, now);
  let suggestion: { projectId: string; commit: string } | null = null;
  if (args.suggestFrom) {
    suggestion = await requireSuggestableCopy(db, { userId: args.userId, copyId: args.suggestFrom, of: post });
  }
  const id = crypto.randomUUID();
  const mentioned = await mentionedPeople(db, body);
  const told = new Set<string>([args.userId]);
  const notifications: D1PreparedStatement[] = [];
  if (!told.has(post.authorId)) {
    told.add(post.authorId);
    notifications.push(
      notify(db, {
        userId: post.authorId,
        kind: suggestion ? 'change_suggested' : 'post_commented',
        actorId: args.userId,
        postId: post.id,
        commentId: id,
        detail: body.slice(0, 140),
      }),
    );
  }
  for (const userId of mentioned) {
    if (!told.has(userId)) {
      told.add(userId);
      notifications.push(
        notify(db, {
          userId,
          kind: 'comment_mentioned',
          actorId: args.userId,
          postId: post.id,
          commentId: id,
          detail: body.slice(0, 140),
        }),
      );
    }
  }
  // Two threads started at once can take the same number: the unique index refuses the second, which tries again.
  for (let attempt = 0; ; attempt += 1) {
    const number = await nextNumber(db, post.id);
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO post_comments (id, post_id, author_id, body, status, created_at, commit_sha, number, kind, state,
               active_at, suggested_project_id, suggested_commit)
             VALUES (?, ?, ?, ?, 'visible', ?, ?, ?, ?, 'open', ?, ?, ?)`,
          )
          .bind(
            id,
            post.id,
            args.userId,
            body,
            now,
            post.commitSha,
            number,
            suggestion ? 'suggestion' : 'comment',
            now,
            suggestion?.projectId ?? null,
            suggestion?.commit ?? null,
          ),
        db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(post.id),
        follow(db, id, args.userId, now),
        follow(db, id, post.authorId, now),
        ...mentioned.map((userId) => follow(db, id, userId, now)),
        ...notifications,
      ]);
      break;
    } catch (error) {
      if (attempt >= 2 || !String(error).includes('UNIQUE')) {
        throw error;
      }
    }
  }
  const thread = await findThread(db, id, args.userId);
  if (!thread) {
    throw new ShowcaseError('Your comment couldn’t be posted. Try again.', 409);
  }
  return thread;
}

/** The thread's first comment and its post, for a change to it; null when nobody may see it. */
async function threadFacts(
  db: D1Database,
  threadId: string,
): Promise<{ id: string; authorId: string; state: ThreadState; locked: boolean; post: PublicPostFacts } | null> {
  const row = await db
    .prepare(
      `SELECT comments.id, comments.post_id, comments.author_id, comments.state, comments.locked
       FROM post_comments AS comments JOIN "user" AS people ON people.id = comments.author_id
       WHERE comments.id = ? AND comments.parent_id IS NULL AND ${SHOWN}`,
    )
    .bind(threadId)
    .first<{ id: string; post_id: string; author_id: string; state: ThreadState; locked: number }>();
  if (!row) {
    return null;
  }
  const post = await findPublicPostFacts(db, row.post_id);
  return post ? { id: row.id, authorId: row.author_id, state: row.state, locked: row.locked === 1, post } : null;
}

async function requireThread(db: D1Database, threadId: string) {
  const thread = await threadFacts(db, threadId);
  if (!thread) {
    throw new ShowcaseError('This thread isn’t shown any more.', 404);
  }
  return thread;
}

async function insertReply(
  db: D1Database,
  args: {
    thread: NonNullable<Awaited<ReturnType<typeof threadFacts>>>;
    authorId: string;
    body: string;
    byAgent: boolean;
    now: number;
  },
): Promise<string> {
  const { thread, now } = args;
  const id = crypto.randomUUID();
  const mentioned = args.byAgent ? [] : await mentionedPeople(db, args.body);
  const followers = await followersOf(db, thread.id, args.byAgent ? [] : [args.authorId]);
  const told = new Set<string>(args.byAgent ? [] : [args.authorId]);
  const notifications: D1PreparedStatement[] = [];
  for (const userId of mentioned) {
    if (!told.has(userId)) {
      told.add(userId);
      notifications.push(
        notify(db, {
          userId,
          kind: 'comment_mentioned',
          actorId: args.byAgent ? null : args.authorId,
          postId: thread.post.id,
          commentId: id,
          detail: args.body.slice(0, 140),
        }),
      );
    }
  }
  for (const userId of followers) {
    if (!told.has(userId)) {
      told.add(userId);
      notifications.push(
        notify(db, {
          userId,
          kind: 'comment_replied',
          actorId: args.byAgent ? null : args.authorId,
          postId: thread.post.id,
          commentId: id,
          detail: args.body.slice(0, 140),
        }),
      );
    }
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO post_comments (id, post_id, author_id, body, status, created_at, parent_id, commit_sha, by_agent)
         VALUES (?, ?, ?, ?, 'visible', ?, ?, ?, ?)`,
      )
      .bind(id, thread.post.id, args.authorId, args.body, now, thread.id, thread.post.commitSha, args.byAgent ? 1 : 0),
    db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(thread.post.id),
    db.prepare('UPDATE post_comments SET active_at = ? WHERE id = ?').bind(now, thread.id),
    ...(args.byAgent ? [] : [follow(db, thread.id, args.authorId, now)]),
    ...mentioned.map((userId) => follow(db, thread.id, userId, now)),
    ...notifications,
  ]);
  return id;
}

async function readComment(db: D1Database, id: string): Promise<PostComment> {
  const row = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS} FROM post_comments AS comments JOIN "user" AS people ON people.id = comments.author_id
       WHERE comments.id = ?`,
    )
    .bind(id)
    .first<CommentRow>();
  if (!row) {
    throw new ShowcaseError('Your comment couldn’t be posted. Try again.', 409);
  }
  return toComment(row);
}

/** A reply in a thread. A locked thread takes replies only from people who can edit the project. */
export async function addReply(
  db: D1Database,
  args: { userId: string; threadId: string; body: string; now?: number },
): Promise<PostComment> {
  const body = checkedBody(args.body);
  const thread = await requireThread(db, args.threadId);
  const now = args.now ?? Date.now();
  await requireWriter(db, args.userId, now);
  if (thread.locked && !(await canEditProject(db, thread.post.projectId, args.userId))) {
    throw new ShowcaseError('This thread is locked: only the people who make this app can reply.', 403);
  }
  return readComment(db, await insertReply(db, { thread, authorId: args.userId, body, byAgent: false, now }));
}

/**
 * CloudChef's answer to `askerId`'s `@cloudchef` in a thread: the run's final message, cut to a comment's length. It
 * isn't counted in the asker's daily limit and is posted even in a locked thread, since the asker asked there.
 */
export async function addAgentReply(
  db: D1Database,
  args: { threadId: string; askerId: string; body: string; now?: number },
): Promise<PostComment | null> {
  const thread = await threadFacts(db, args.threadId);
  if (!thread) {
    return null;
  }
  const trimmed = args.body.trim() || 'CloudChef had nothing to add.';
  const body = trimmed.length > COMMENT_MAX ? `${trimmed.slice(0, COMMENT_MAX - 1).trimEnd()}…` : trimmed;
  const now = args.now ?? Date.now();
  return readComment(db, await insertReply(db, { thread, authorId: args.askerId, body, byAgent: true, now }));
}

/** Closes a thread with a reason: by an editor or its starter. A duplicate names another thread of the post. */
export async function closeThread(
  db: D1Database,
  args: { userId: string; threadId: string; reason: CloseReason; sameAs?: number | null; now?: number },
): Promise<PostThread> {
  const thread = await requireThread(db, args.threadId);
  const editor = await canEditProject(db, thread.post.projectId, args.userId);
  if (!editor && thread.authorId !== args.userId) {
    throw new ShowcaseError('Only the people who make this app, or who started the thread, can close it.', 403);
  }
  let duplicateOf: string | null = null;
  if (args.reason === 'duplicate') {
    const same = await db
      .prepare('SELECT id FROM post_comments WHERE post_id = ? AND number = ? AND id != ?')
      .bind(thread.post.id, args.sameAs ?? -1, thread.id)
      .first<{ id: string }>();
    if (!same) {
      throw new ShowcaseError('Name another thread on this post, by its number.', 400);
    }
    duplicateOf = same.id;
  }
  const now = args.now ?? Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE post_comments SET state = 'closed', close_reason = ?, duplicate_of = ?, fix_commit = NULL, state_by = ?,
           state_at = ?, active_at = ? WHERE id = ?`,
      )
      .bind(args.reason, duplicateOf, args.userId, now, now, thread.id),
    ...(await closedNotifications(db, thread, args.userId, args.reason)),
  ]);
  return (await findThread(db, thread.id, args.userId))!;
}

async function closedNotifications(
  db: D1Database,
  thread: NonNullable<Awaited<ReturnType<typeof threadFacts>>>,
  actorId: string | null,
  reason: CloseReason,
): Promise<D1PreparedStatement[]> {
  const followers = await followersOf(db, thread.id, actorId ? [actorId] : []);
  return followers.map((userId) =>
    notify(db, {
      userId,
      kind: 'thread_closed',
      actorId,
      postId: thread.post.id,
      commentId: thread.id,
      detail: reason,
    }),
  );
}

/** Opens a closed or on-its-way thread again: by an editor or its starter. */
export async function reopenThread(
  db: D1Database,
  args: { userId: string; threadId: string; now?: number },
): Promise<PostThread> {
  const thread = await requireThread(db, args.threadId);
  if (thread.authorId !== args.userId && !(await canEditProject(db, thread.post.projectId, args.userId))) {
    throw new ShowcaseError('Only the people who make this app, or who started the thread, can open it again.', 403);
  }
  const now = args.now ?? Date.now();
  await db
    .prepare(
      `UPDATE post_comments SET state = 'open', close_reason = NULL, duplicate_of = NULL, fix_commit = NULL,
         state_by = ?, state_at = ?, active_at = ? WHERE id = ?`,
    )
    .bind(args.userId, now, now, thread.id)
    .run();
  return (await findThread(db, thread.id, args.userId))!;
}

async function requireEditorOf(db: D1Database, threadId: string, userId: string) {
  const thread = await requireThread(db, threadId);
  if (!(await canEditProject(db, thread.post.projectId, userId))) {
    throw new ShowcaseError('Only the people who make this app can do that.', 403);
  }
  return thread;
}

/** Locks or unlocks a thread: by an editor. */
export async function setThreadLocked(
  db: D1Database,
  args: { userId: string; threadId: string; locked: boolean },
): Promise<PostThread> {
  const thread = await requireEditorOf(db, args.threadId, args.userId);
  await db
    .prepare('UPDATE post_comments SET locked = ? WHERE id = ?')
    .bind(args.locked ? 1 : 0, thread.id)
    .run();
  return (await findThread(db, thread.id, args.userId))!;
}

/** Pins or unpins a thread: by an editor, at most three on a post. */
export async function setThreadPinned(
  db: D1Database,
  args: { userId: string; threadId: string; pinned: boolean; now?: number },
): Promise<PostThread> {
  const thread = await requireEditorOf(db, args.threadId, args.userId);
  if (args.pinned) {
    const pinned = await db
      .prepare('SELECT COUNT(*) AS count FROM post_comments WHERE post_id = ? AND pinned_at IS NOT NULL AND id != ?')
      .bind(thread.post.id, thread.id)
      .first<{ count: number }>();
    if ((pinned?.count ?? 0) >= PINNED_MAX) {
      throw new ShowcaseError('Three threads are pinned already. Unpin one first.', 409);
    }
  }
  await db
    .prepare('UPDATE post_comments SET pinned_at = CASE WHEN ? THEN COALESCE(pinned_at, ?) END WHERE id = ?')
    .bind(args.pinned ? 1 : 0, args.now ?? Date.now(), thread.id)
    .run();
  return (await findThread(db, thread.id, args.userId))!;
}

/** Follows a thread, or mutes it so nothing in it is told any more, even after replying again. */
export async function setThreadFollowing(
  db: D1Database,
  args: { userId: string; threadId: string; follow: boolean; now?: number },
): Promise<{ following: boolean }> {
  const thread = await requireThread(db, args.threadId);
  await db
    .prepare(
      `INSERT INTO thread_followers (thread_id, user_id, muted, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET muted = ?3`,
    )
    .bind(thread.id, args.userId, args.follow ? 0 : 1, args.now ?? Date.now())
    .run();
  return { following: args.follow };
}

/**
 * Deletes a comment: by the person who wrote it (or who asked CloudChef, for its answer), by someone who can edit the
 * project, or by someone who manages the post. Deleting a thread's first comment deletes its replies.
 */
export async function deleteComment(db: D1Database, args: { userId: string; commentId: string }): Promise<void> {
  const comment = await db
    .prepare(
      `SELECT comments.id, comments.post_id, comments.author_id, posts.project_id, posts.author_id AS post_author
       FROM post_comments AS comments JOIN posts ON posts.id = comments.post_id WHERE comments.id = ?`,
    )
    .bind(args.commentId)
    .first<{ id: string; post_id: string; author_id: string; project_id: string; post_author: string }>();
  const allowed =
    comment &&
    (comment.author_id === args.userId ||
      comment.post_author === args.userId ||
      (await canEditProject(db, comment.project_id, args.userId)));
  if (!comment || !allowed) {
    throw new ShowcaseError('Only the person who wrote it, or who makes this app, can delete a comment.', 403);
  }
  const visible = await db
    .prepare(`SELECT COUNT(*) AS count FROM post_comments WHERE (id = ?1 OR parent_id = ?1) AND status = 'visible'`)
    .bind(comment.id)
    .first<{ count: number }>();
  await db.batch([
    db.prepare('DELETE FROM post_comments WHERE id = ?').bind(comment.id),
    db
      .prepare('UPDATE posts SET comment_count = max(comment_count - ?, 0) WHERE id = ?')
      .bind(visible?.count ?? 0, comment.post_id),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// Suggestions and copies
// ---------------------------------------------------------------------------------------------------------------

/** A copy `userId` may suggest from: of this post's project, public with a visible post, and theirs to edit. */
async function requireSuggestableCopy(
  db: D1Database,
  args: { userId: string; copyId: string; of: PublicPostFacts },
): Promise<{ projectId: string; commit: string }> {
  const copy = await db
    .prepare(
      `SELECT copies.id, copy_posts.commit_sha FROM org_projects AS copies
       JOIN posts AS copy_posts ON copy_posts.project_id = copies.id AND copy_posts.status = 'visible'
       WHERE copies.id = ? AND copies.copied_from = ? AND copies.visibility = 'public'`,
    )
    .bind(args.copyId, args.of.projectId)
    .first<{ id: string; commit_sha: string }>();
  if (!copy || !(await canEditProject(db, copy.id, args.userId))) {
    throw new ShowcaseError('Suggest a change from your own public copy of this app, once it’s published.', 403);
  }
  return { projectId: copy.id, commit: copy.commit_sha };
}

export type CopyOfPost = {
  name: string;
  path: string;
  author: { username: string; name: string; image: string | null };
};

/** The public copies of a post's project that have a post of their own, newest first. */
export async function listCopies(db: D1Database, postId: string): Promise<CopyOfPost[]> {
  const post = await findPublicPostFacts(db, postId);
  if (!post) {
    return [];
  }
  const { results } = await db
    .prepare(
      `SELECT copies.name, copies.slug, owners.username, owners.name AS owner_name, owners.image
       FROM org_projects AS copies
       JOIN posts AS copy_posts ON copy_posts.project_id = copies.id AND copy_posts.status = 'visible'
       JOIN "user" AS owners ON owners.id = copies.created_by
       WHERE copies.copied_from = ? AND copies.visibility = 'public' AND copies.slug IS NOT NULL
         AND owners.username IS NOT NULL AND owners.showcase_paused_at IS NULL
       ORDER BY copies.created_at DESC LIMIT 200`,
    )
    .bind(post.projectId)
    .all<{ name: string; slug: string; username: string; owner_name: string; image: string | null }>();
  return results.map((row) => ({
    name: row.name,
    path: `/${row.username}/${row.slug}`,
    author: { username: row.username, name: row.owner_name, image: row.image },
  }));
}

/** The viewer's public copies of a post's project they could suggest a change from. */
export async function listOwnSuggestableCopies(
  db: D1Database,
  args: { userId: string; postId: string },
): Promise<{ id: string; name: string }[]> {
  const post = await findPublicPostFacts(db, args.postId);
  if (!post) {
    return [];
  }
  const { results } = await db
    .prepare(
      `SELECT copies.id, copies.name FROM org_projects AS copies
       JOIN posts AS copy_posts ON copy_posts.project_id = copies.id AND copy_posts.status = 'visible'
       WHERE copies.copied_from = ? AND copies.visibility = 'public' ORDER BY copies.created_at DESC LIMIT 20`,
    )
    .bind(post.projectId)
    .all<{ id: string; name: string }>();
  const own: { id: string; name: string }[] = [];
  for (const copy of results) {
    if (await canEditProject(db, copy.id, args.userId)) {
      own.push(copy);
    }
  }
  return own;
}

// ---------------------------------------------------------------------------------------------------------------
// A change going live
// ---------------------------------------------------------------------------------------------------------------

/**
 * CloudChef made a change for a thread: it is on its way until a publish whose commit has `fixCommit` in its history
 * goes live, or closed as changed at once when `fixCommit` is live already. By someone who can edit the project.
 */
export async function markThreadOnItsWay(
  db: D1Database,
  args: { userId: string; threadId: string; fixCommit: string; now?: number },
): Promise<ThreadState> {
  const thread = await requireEditorOf(db, args.threadId, args.userId);
  const now = args.now ?? Date.now();
  if (thread.post.commitSha === args.fixCommit) {
    await db.batch([
      db
        .prepare(
          `UPDATE post_comments SET state = 'closed', close_reason = 'changed', duplicate_of = NULL, fix_commit = ?,
             state_by = ?, state_at = ?, active_at = ? WHERE id = ?`,
        )
        .bind(args.fixCommit, args.userId, now, now, thread.id),
      ...(await closedNotifications(db, thread, null, 'changed')),
    ]);
    return 'closed';
  }
  await db
    .prepare(
      `UPDATE post_comments SET state = 'on_its_way', close_reason = NULL, duplicate_of = NULL, fix_commit = ?,
         state_by = ?, state_at = ?, active_at = ? WHERE id = ?`,
    )
    .bind(args.fixCommit, args.userId, now, now, thread.id)
    .run();
  return 'on_its_way';
}

/** A project's threads on their way, with the commit each waits for. */
export async function waitingFixes(
  db: D1Database,
  projectId: string,
): Promise<{ threadId: string; fixCommit: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT comments.id, comments.fix_commit FROM post_comments AS comments JOIN posts ON posts.id = comments.post_id
       WHERE posts.project_id = ? AND comments.state = 'on_its_way' AND comments.fix_commit IS NOT NULL LIMIT 100`,
    )
    .bind(projectId)
    .all<{ id: string; fix_commit: string }>();
  return results.map((row) => ({ threadId: row.id, fixCommit: row.fix_commit }));
}

/** The threads in `threadIds` (of `projectId`) whose change went live at `at`: closed as changed, followers told. */
export async function closeThreadsWentLive(
  db: D1Database,
  args: { projectId: string; threadIds: readonly string[]; at: number },
): Promise<void> {
  for (const threadId of args.threadIds) {
    const thread = await threadFacts(db, threadId);
    if (!thread || thread.post.projectId !== args.projectId || thread.state !== 'on_its_way') {
      continue;
    }
    await db.batch([
      db
        .prepare(
          `UPDATE post_comments SET state = 'closed', close_reason = 'changed', state_at = ?, active_at = ?
           WHERE id = ? AND state = 'on_its_way'`,
        )
        .bind(args.at, args.at, thread.id),
      ...(await closedNotifications(db, thread, null, 'changed')),
    ]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// For the agent (`cloudchef comments`)
// ---------------------------------------------------------------------------------------------------------------

/** A project's post, if it has one anyone may see. */
export async function publicPostOfProject(db: D1Database, projectId: string): Promise<PublicPostFacts | null> {
  const row = await db.prepare('SELECT id FROM posts WHERE project_id = ?').bind(projectId).first<{ id: string }>();
  return row ? findPublicPostFacts(db, row.id) : null;
}

/** A thread of a project's post by its number. */
export async function findThreadByNumber(
  db: D1Database,
  args: { projectId: string; number: number; viewerId: string | null },
): Promise<PostThread | null> {
  const post = await publicPostOfProject(db, args.projectId);
  if (!post) {
    return null;
  }
  const row = await db
    .prepare('SELECT id FROM post_comments WHERE post_id = ? AND number = ? AND parent_id IS NULL')
    .bind(post.id, args.number)
    .first<{ id: string }>();
  return row ? findThread(db, row.id, args.viewerId) : null;
}

/** How many open threads the visible posts of `projectIds` have, by project id; projects with none are left out. */
export async function openThreadsOfProjects(
  db: D1Database,
  projectIds: readonly string[],
): Promise<Record<string, number>> {
  if (projectIds.length === 0) {
    return {};
  }
  const { results } = await db
    .prepare(
      `SELECT posts.project_id, COUNT(*) AS count FROM post_comments AS comments
       JOIN posts ON posts.id = comments.post_id AND posts.status = 'visible'
       JOIN "user" AS people ON people.id = comments.author_id
       WHERE posts.project_id IN (SELECT value FROM json_each(?)) AND comments.parent_id IS NULL
         AND comments.state = 'open' AND ${SHOWN}
       GROUP BY posts.project_id`,
    )
    .bind(JSON.stringify(projectIds.slice(0, 200)))
    .all<{ project_id: string; count: number }>();
  return Object.fromEntries(results.map((row) => [row.project_id, row.count]));
}
