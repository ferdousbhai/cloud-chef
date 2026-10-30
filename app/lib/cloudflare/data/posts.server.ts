import type {
  NotificationView,
  PostComment,
  PostView,
  PublicPerson,
  ReportReason,
  ShowcaseCursor,
} from '~/lib/showcase';

/**
 * Showcase posts (docs/proposals/showcase-and-feed.md): one per public project, made and updated by its publishes,
 * on the page of the person who published it; and what people do with them: follow, like, comment, copy, report.
 * Everything a visitor who isn't signed in may read is shaped here, so nothing private leaves: no email, no private
 * project, no team name.
 */

/** A post moves back to the top of feeds on a publish at most this often. */
export const POST_MOVE_INTERVAL_MS = 24 * 60 * 60_000;
/** A new account's posts reach its followers' feeds once it is this old (its own page shows them at once). */
const NEW_ACCOUNT_FEED_DELAY_MS = 24 * 60 * 60_000;
/** Open reports from this many different people hold a post or comment until an operator decides. */
export const REPORTS_TO_HOLD = 3;
/** Posts an operator removed before a person's page is paused for review. */
const REMOVALS_TO_PAUSE = 2;
const PAGE_SIZE = 24;
const DAY_MS = 24 * 60 * 60_000;
/** What one person, or one visitor's address, may do in a day. */
const DAILY_LIMITS = { follows: 100, comments: 200, reports: 5, signedInReports: 20 } as const;

/** Why a showcase action was refused, in words for the person, with the HTTP status that carries it. */
export class ShowcaseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 429,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading posts
// ---------------------------------------------------------------------------------------------------------------

type PostRow = {
  id: string;
  project_id: string;
  caption: string | null;
  site_url: string;
  shown_at: number;
  published_count: number;
  like_count: number;
  comment_count: number;
  copy_count: number;
  status: 'visible' | 'hidden' | 'removed';
  hidden_reason: 'author' | 'project_private' | 'reported' | null;
  author_id: string;
  project_name: string;
  project_slug: string | null;
  owner_username: string | null;
  author_username: string | null;
  author_name: string;
  author_image: string | null;
  media: string | null;
};

const POST_COLUMNS = `posts.id, posts.project_id, posts.caption, posts.site_url, posts.shown_at, posts.published_count,
  posts.like_count, posts.comment_count, posts.copy_count, posts.status, posts.hidden_reason, posts.author_id,
  projects.name AS project_name, projects.slug AS project_slug, owners.username AS owner_username,
  authors.username AS author_username, authors.name AS author_name, authors.image AS author_image,
  (SELECT json_group_array(json_object('id', media.id, 'kind', media.kind, 'width', media.width,
     'height', media.height, 'durationMs', media.duration_ms, 'contentType', media.content_type))
   FROM post_media AS media WHERE media.post_id = posts.id AND media.state = 'ready') AS media`;

/** What a post is read with: its project, its author, and its project's author (whose username is in its address). */
const POST_JOINS = `JOIN org_projects AS projects ON projects.id = posts.project_id
  JOIN "user" AS authors ON authors.id = posts.author_id
  LEFT JOIN "user" AS owners ON owners.id = projects.created_by`;
const POST_FROM = `posts ${POST_JOINS}`;

/**
 * What anyone may see: a visible post of a public project, on the page of someone with a username whose page isn't
 * paused, at an address (its project's author has a username too).
 */
const PUBLIC = `posts.status = 'visible' AND projects.visibility = 'public' AND authors.username IS NOT NULL
  AND authors.showcase_paused_at IS NULL AND owners.username IS NOT NULL AND projects.slug IS NOT NULL`;

/** Before the cursor (its two parameters), newest first: posts sort by when they were shown, then by id. */
const beforeCursor = (shownAt: string, id: string) =>
  `(posts.shown_at < ${shownAt} OR (posts.shown_at = ${shownAt} AND posts.id < ${id}))`;

type MediaJson = {
  id: string;
  kind: 'screenshot' | 'video' | 'poster';
  width: number | null;
  height: number | null;
  durationMs: number | null;
  contentType: string;
};

/** Where a media item is served: CloudChef's own address, by its id, so a replaced picture is a new address. */
function mediaPath(media: { id: string; contentType: string }): string {
  const extension = media.contentType === 'video/mp4' ? 'mp4' : media.contentType === 'video/webm' ? 'webm' : 'webp';
  return `/media/${media.id}.${extension}`;
}

function toPostView(row: PostRow): PostView {
  // SAFETY: `media` is the json_group_array of POST_COLUMNS, whose objects have exactly these fields.
  const media: MediaJson[] = row.media ? (JSON.parse(row.media) as MediaJson[]) : [];
  const screenshot = media.find((item) => item.kind === 'screenshot');
  const video = media.find((item) => item.kind === 'video');
  const poster = media.find((item) => item.kind === 'poster');
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.project_name,
    path: `/${row.owner_username ?? ''}/${row.project_slug ?? ''}`,
    caption: row.caption,
    siteUrl: row.site_url,
    author: { username: row.author_username ?? '', name: row.author_name, image: row.author_image },
    screenshot: screenshot
      ? { url: mediaPath(screenshot), width: screenshot.width ?? 1280, height: screenshot.height ?? 800 }
      : null,
    video: video
      ? {
          url: mediaPath(video),
          posterUrl: poster ? mediaPath(poster) : null,
          width: video.width,
          height: video.height,
          durationMs: video.durationMs,
        }
      : null,
    updated: row.published_count > 1,
    shownAt: row.shown_at,
    likeCount: row.like_count,
    commentCount: row.comment_count,
    copyCount: row.copy_count,
  };
}

function cursorOf(rows: PostRow[], limit: number): ShowcaseCursor | null {
  const last = rows.at(-1);
  return rows.length === limit && last ? { shownAt: last.shown_at, id: last.id } : null;
}

function cursorValues(cursor: ShowcaseCursor | null | undefined): [number, string] {
  return cursor ? [cursor.shownAt, cursor.id] : [Number.MAX_SAFE_INTEGER, '￿'];
}

/** A person's public page: who they are, their counts, and their newest visible posts. Null without such a person. */
export async function findPerson(db: D1Database, username: string): Promise<PublicPerson | null> {
  const row = await db
    .prepare(
      `SELECT people.id, people.username, people.name, people.image, people.bio,
         (SELECT COUNT(*) FROM follows WHERE followee_id = people.id) AS followers,
         (SELECT COUNT(*) FROM follows WHERE follower_id = people.id) AS following
       FROM "user" AS people WHERE people.username = ?1 AND people.showcase_paused_at IS NULL`,
    )
    .bind(username)
    .first<{
      id: string;
      username: string;
      name: string;
      image: string | null;
      bio: string | null;
      followers: number;
      following: number;
    }>();
  if (!row) {
    return null;
  }
  const posts = await db
    .prepare(`SELECT COUNT(*) AS count FROM ${POST_FROM} WHERE posts.author_id = ?1 AND ${PUBLIC}`)
    .bind(row.id)
    .first<{ count: number }>();
  return {
    username: row.username,
    name: row.name,
    image: row.image,
    bio: row.bio,
    followers: row.followers,
    following: row.following,
    posts: posts?.count ?? 0,
  };
}

/** A person's visible posts, newest first, a page at a time. */
export async function listPersonPosts(
  db: D1Database,
  username: string,
  cursor?: ShowcaseCursor | null,
): Promise<{ posts: PostView[]; next: ShowcaseCursor | null }> {
  const [shownAt, id] = cursorValues(cursor);
  const { results } = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM ${POST_FROM}
       WHERE authors.username = ?1 AND ${PUBLIC} AND ${beforeCursor('?2', '?3')}
       ORDER BY posts.shown_at DESC, posts.id DESC LIMIT ?4`,
    )
    .bind(username, shownAt, id, PAGE_SIZE)
    .all<PostRow>();
  return { posts: results.map(toPostView), next: cursorOf(results, PAGE_SIZE) };
}

/** Everyone's visible posts, newest first: Explore. */
export async function listExplorePosts(
  db: D1Database,
  cursor?: ShowcaseCursor | null,
): Promise<{ posts: PostView[]; next: ShowcaseCursor | null }> {
  const [shownAt, id] = cursorValues(cursor);
  const { results } = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM ${POST_FROM}
       WHERE ${PUBLIC} AND ${beforeCursor('?1', '?2')}
       ORDER BY posts.shown_at DESC, posts.id DESC LIMIT ?3`,
    )
    .bind(shownAt, id, PAGE_SIZE)
    .all<PostRow>();
  return { posts: results.map(toPostView), next: cursorOf(results, PAGE_SIZE) };
}

/**
 * The feed: visible posts of the people `userId` follows, newest first. A new account's posts join feeds once it is
 * a day old, which keeps accounts made to spam out of them.
 */
export async function listFeedPosts(
  db: D1Database,
  userId: string,
  cursor?: ShowcaseCursor | null,
  now = Date.now(),
): Promise<{ posts: PostView[]; next: ShowcaseCursor | null }> {
  const [shownAt, id] = cursorValues(cursor);
  const { results } = await db
    .prepare(
      `SELECT ${POST_COLUMNS} FROM ${POST_FROM}
       JOIN follows ON follows.followee_id = posts.author_id AND follows.follower_id = ?1
       WHERE ${PUBLIC} AND ${beforeCursor('?2', '?3')} AND authors.createdAt < ?5
       ORDER BY posts.shown_at DESC, posts.id DESC LIMIT ?4`,
    )
    .bind(userId, shownAt, id, PAGE_SIZE, now - NEW_ACCOUNT_FEED_DELAY_MS)
    .all<PostRow>();
  return { posts: results.map(toPostView), next: cursorOf(results, PAGE_SIZE) };
}

/**
 * The post at `/<owner>/<slug>`, the project's own address: its public view, or null when it has none anyone may see.
 * `exists` says whether there is a public project there at all, so its page can say the post is not shown rather
 * than that nothing is there.
 */
export async function findPostByAddress(
  db: D1Database,
  owner: string,
  slug: string,
): Promise<{ post: PostView | null; project: { id: string; name: string } | null }> {
  const project = await db
    .prepare(
      `SELECT projects.id, projects.name FROM org_projects AS projects
       JOIN "user" AS owners ON owners.id = projects.created_by
       WHERE owners.username = ?1 AND projects.slug = ?2 AND projects.visibility = 'public'`,
    )
    .bind(owner, slug)
    .first<{ id: string; name: string }>();
  if (!project) {
    return { post: null, project: null };
  }
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE posts.project_id = ?1 AND ${PUBLIC}`)
    .bind(project.id)
    .first<PostRow>();
  return { post: row ? toPostView(row) : null, project };
}

/** A post anyone may see, by id. */
async function findPublicPost(db: D1Database, postId: string): Promise<PostView | null> {
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE posts.id = ?1 AND ${PUBLIC}`)
    .bind(postId)
    .first<PostRow>();
  return row ? toPostView(row) : null;
}

/** May `userId` manage the post: its author, a personal project's owner, or an active admin of a team project's team. */
const MANAGES = `(posts.author_id = ?2
  OR (projects.org_id IS NULL AND projects.created_by = ?2)
  OR (projects.org_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM organization_members AS members
    WHERE members.org_id = projects.org_id AND members.user_id = ?2 AND members.role = 'admin'
      AND members.paused_at IS NULL)))`;

/** A post as one of the people who manage it sees it: whatever its status, and why it is hidden. */
export type ManagedPost = PostView & {
  status: 'visible' | 'hidden' | 'removed';
  hiddenReason: 'author' | 'project_private' | 'reported' | null;
  projectPublic: boolean;
};

async function findManagedPost(db: D1Database, postId: string, userId: string): Promise<ManagedPost | null> {
  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, projects.visibility AS visibility FROM ${POST_FROM}
       WHERE posts.id = ?1 AND ${MANAGES}`,
    )
    .bind(postId, userId)
    .first<PostRow & { visibility: 'public' | 'private' }>();
  return row
    ? {
        ...toPostView(row),
        status: row.status,
        hiddenReason: row.hidden_reason,
        projectPublic: row.visibility === 'public',
      }
    : null;
}

/** The posts of `userId` hidden from their page, for them to show again from it. */
export async function listOwnHiddenPosts(db: D1Database, userId: string): Promise<ManagedPost[]> {
  const { results } = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, projects.visibility AS visibility FROM ${POST_FROM}
       WHERE posts.author_id = ?1 AND posts.status = 'hidden' ORDER BY posts.updated_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<PostRow & { visibility: 'public' | 'private' }>();
  return results.map((row) => ({
    ...toPostView(row),
    status: row.status,
    hiddenReason: row.hidden_reason,
    projectPublic: row.visibility === 'public',
  }));
}

/** What a signed-in person sees differently on the posts in front of them: which they liked, and which they manage. */
export async function viewerStateOfPosts(
  db: D1Database,
  userId: string,
  postIds: readonly string[],
): Promise<{ liked: string[]; managed: string[] }> {
  if (postIds.length === 0) {
    return { liked: [], managed: [] };
  }
  const ids = JSON.stringify(postIds);
  const [liked, managed] = await Promise.all([
    db
      .prepare('SELECT post_id FROM post_likes WHERE user_id = ?1 AND post_id IN (SELECT value FROM json_each(?2))')
      .bind(userId, ids)
      .all<{ post_id: string }>(),
    db
      .prepare(
        `SELECT posts.id FROM posts JOIN org_projects AS projects ON projects.id = posts.project_id
         WHERE posts.id IN (SELECT value FROM json_each(?1)) AND ${MANAGES}`,
      )
      .bind(ids, userId)
      .all<{ id: string }>(),
  ]);
  return { liked: liked.results.map((row) => row.post_id), managed: managed.results.map((row) => row.id) };
}

/** Whether `userId` follows the person `username`. */
export async function followsPerson(db: D1Database, userId: string, username: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS yes FROM follows JOIN "user" AS people ON people.id = follows.followee_id
       WHERE follows.follower_id = ?1 AND people.username = ?2`,
    )
    .bind(userId, username)
    .first<{ yes: number }>();
  return row !== null;
}

// ---------------------------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------------------------

/** What a publish did to a project's post: made or updated it (and so wants a new screenshot), or nothing. */
export type PublicationOutcome =
  | { kind: 'created' | 'updated'; postId: string; siteUrl: string; visible: boolean }
  | { kind: 'unchanged' | 'not_posted' };

/**
 * Records that main's `commit` of a project went live at `siteUrl` (or its recorded live address). Only a public
 * project posts. No post yet: one is made, on the page of whoever pushed the commit (else `by`, else the project's
 * author). A post already there shows the new commit; a visible one moves back to the top of feeds when it last
 * moved more than a day ago. A post its author hid, or one held after reports, stays hidden; one hidden because the
 * project went private shows again, since the project is public once more. A post an operator removed stays removed.
 * Asking again about the commit it already shows changes nothing, so a build's status read many times posts once.
 */
export async function recordPublication(
  db: D1Database,
  args: { projectId: string; commit: string; by: string | null; siteUrl: string | null; now?: number },
): Promise<PublicationOutcome> {
  const now = args.now ?? Date.now();
  const project = await db
    .prepare('SELECT visibility, created_by, site_url FROM org_projects WHERE id = ?')
    .bind(args.projectId)
    .first<{ visibility: 'public' | 'private'; created_by: string | null; site_url: string | null }>();
  const siteUrl = args.siteUrl ?? project?.site_url ?? null;
  if (!project || project.visibility !== 'public' || !siteUrl) {
    return { kind: 'not_posted' };
  }
  const existing = await db
    .prepare('SELECT id, commit_sha, status, hidden_reason FROM posts WHERE project_id = ?')
    .bind(args.projectId)
    .first<{ id: string; commit_sha: string; status: PostRow['status']; hidden_reason: PostRow['hidden_reason'] }>();
  if (!existing) {
    const pusher = await db
      .prepare(
        `SELECT pushed_by FROM project_main_pushes WHERE project_id = ? AND new_commit = ? AND pushed_by IS NOT NULL
         ORDER BY pushed_at DESC LIMIT 1`,
      )
      .bind(args.projectId, args.commit)
      .first<{ pushed_by: string }>();
    const authorId = pusher?.pushed_by ?? args.by ?? project.created_by;
    if (!authorId) {
      return { kind: 'not_posted' };
    }
    const postId = crypto.randomUUID();
    const inserted = await db
      .prepare(
        `INSERT INTO posts (id, project_id, author_id, commit_sha, site_url, status, shown_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'visible', ?6, ?6, ?6) ON CONFLICT (project_id) DO NOTHING`,
      )
      .bind(postId, args.projectId, authorId, args.commit, siteUrl, now)
      .run();
    // Two reads of the same build at once: the other made it.
    return inserted.meta.changes === 1 ? { kind: 'created', postId, siteUrl, visible: true } : { kind: 'unchanged' };
  }
  if (existing.commit_sha === args.commit || existing.status === 'removed') {
    return { kind: 'unchanged' };
  }
  const showsAgain = existing.status === 'hidden' && existing.hidden_reason === 'project_private';
  const updated = await db
    .prepare(
      `UPDATE posts SET commit_sha = ?2, site_url = ?3, published_count = published_count + 1, updated_at = ?4,
         status = CASE WHEN ?5 THEN 'visible' ELSE status END,
         hidden_reason = CASE WHEN ?5 THEN NULL ELSE hidden_reason END,
         shown_at = CASE WHEN ?5 OR (status = 'visible' AND ?4 - shown_at > ?6) THEN ?4 ELSE shown_at END
       WHERE id = ?1 AND commit_sha <> ?2`,
    )
    .bind(existing.id, args.commit, siteUrl, now, showsAgain ? 1 : 0, POST_MOVE_INTERVAL_MS)
    .run();
  return updated.meta.changes === 1
    ? { kind: 'updated', postId: existing.id, siteUrl, visible: showsAgain || existing.status === 'visible' }
    : { kind: 'unchanged' };
}

/**
 * A project made private: its post is hidden (an author's own hiding stays theirs) and its media deleted, so nothing
 * of a private project stays public. Making it public again posts at its next publish, or when its author shows it.
 */
export async function hidePostOfPrivateProject(db: D1Database, projectId: string): Promise<boolean> {
  const post = await db.prepare('SELECT id FROM posts WHERE project_id = ?').bind(projectId).first<{ id: string }>();
  if (!post) {
    return false;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE posts SET status = 'hidden', hidden_reason = 'project_private', updated_at = ?2
         WHERE id = ?1 AND status = 'visible'`,
      )
      .bind(post.id, Date.now()),
    db.prepare('DELETE FROM post_media WHERE post_id = ?').bind(post.id),
  ]);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// The author's controls
// ---------------------------------------------------------------------------------------------------------------

async function requireManagedPost(db: D1Database, postId: string, userId: string): Promise<ManagedPost> {
  const post = await findManagedPost(db, postId, userId);
  if (!post) {
    throw new ShowcaseError('Only the person whose post it is, or their team’s admin, can do that.', 403);
  }
  return post;
}

/** A few words that mark a caption as a scam rather than a project: such a caption isn't saved. */
const BLOCKED_CAPTION_PHRASES = [
  'seed phrase',
  'recovery phrase',
  'private key',
  'wallet connect',
  'verify your account',
  'claim your airdrop',
  'free crypto',
  'send btc',
  'send eth',
];

/** Why a caption can't be posted, or null when it can. */
function captionProblem(caption: string): string | null {
  const lowered = caption.toLowerCase();
  return BLOCKED_CAPTION_PHRASES.some((phrase) => lowered.includes(phrase))
    ? 'That caption looks like it asks people for their accounts or money, so it can’t be posted.'
    : null;
}

/** Sets or clears (empty) a post's caption. */
export async function setPostCaption(
  db: D1Database,
  args: { postId: string; userId: string; caption: string },
): Promise<void> {
  await requireManagedPost(db, args.postId, args.userId);
  const caption = args.caption.trim();
  const problem = caption ? captionProblem(caption) : null;
  if (problem) {
    throw new ShowcaseError(problem, 400);
  }
  await db
    .prepare('UPDATE posts SET caption = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(args.postId, caption || null, Date.now())
    .run();
}

/**
 * "Hide from my page" and "Show on my page". Only a post its author hid can be shown again, or one hidden when its
 * project went private once the project is public again; one held after reports waits for an operator.
 */
export async function setPostShown(
  db: D1Database,
  args: { postId: string; userId: string; shown: boolean; now?: number },
): Promise<void> {
  const post = await requireManagedPost(db, args.postId, args.userId);
  const now = args.now ?? Date.now();
  if (!args.shown) {
    if (post.status === 'visible') {
      await db
        .prepare(
          `UPDATE posts SET status = 'hidden', hidden_reason = 'author', updated_at = ?2 WHERE id = ?1 AND status = 'visible'`,
        )
        .bind(args.postId, now)
        .run();
    }
    return;
  }
  if (post.status === 'visible') {
    return;
  }
  if (post.status === 'removed' || post.hiddenReason === 'reported') {
    throw new ShowcaseError('This post was taken down after reports, so it can’t be shown again.', 409);
  }
  if (!post.projectPublic) {
    throw new ShowcaseError('Make the project public first: only public projects are shown on your page.', 409);
  }
  await db
    .prepare(
      `UPDATE posts SET status = 'visible', hidden_reason = NULL, updated_at = ?2,
         shown_at = CASE WHEN ?2 - shown_at > ?3 THEN ?2 ELSE shown_at END
       WHERE id = ?1 AND status = 'hidden' AND hidden_reason IN ('author', 'project_private')`,
    )
    .bind(args.postId, now, POST_MOVE_INTERVAL_MS)
    .run();
}

/** "Delete post": the post and its media go; the next publish of a project still public makes a new one. */
export async function deletePost(db: D1Database, args: { postId: string; userId: string }): Promise<void> {
  const post = await requireManagedPost(db, args.postId, args.userId);
  if (post.status === 'removed') {
    throw new ShowcaseError('This post was taken down after reports, so it stays off CloudChef.', 409);
  }
  await db.prepare('DELETE FROM posts WHERE id = ?').bind(args.postId).run();
}

/** The line under a person's name on their page. */
export async function setBio(db: D1Database, userId: string, bio: string): Promise<void> {
  const text = bio.trim();
  const problem = text ? captionProblem(text) : null;
  if (problem) {
    throw new ShowcaseError(problem.replace('caption', 'line'), 400);
  }
  await db
    .prepare('UPDATE "user" SET bio = ? WHERE id = ?')
    .bind(text || null, userId)
    .run();
}

// ---------------------------------------------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------------------------------------------

export type NewMedia = {
  id: string;
  kind: 'screenshot' | 'video' | 'poster';
  origin: 'automatic' | 'uploaded';
  r2Key: string;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  commit: string | null;
  state: 'pending' | 'ready';
};

function insertMedia(db: D1Database, postId: string, media: NewMedia, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO post_media (id, post_id, kind, origin, r2_key, content_type, bytes, width, height, duration_ms,
         commit_sha, state, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      media.id,
      postId,
      media.kind,
      media.origin,
      media.r2Key,
      media.contentType,
      media.bytes,
      media.width,
      media.height,
      media.durationMs,
      media.commit,
      media.state,
      now,
    );
}

/**
 * A new automatic screenshot of the post's site, replacing the one before it (its object is deleted with its row).
 * False when the post moved on meanwhile (another commit, or it went), so the picture isn't kept.
 */
export async function replaceScreenshot(
  db: D1Database,
  args: { postId: string; commit: string; media: NewMedia },
): Promise<boolean> {
  const post = await db
    .prepare(`SELECT commit_sha FROM posts WHERE id = ? AND status <> 'removed'`)
    .bind(args.postId)
    .first<{ commit_sha: string }>();
  if (!post || post.commit_sha !== args.commit) {
    return false;
  }
  await db.batch([
    db.prepare(`DELETE FROM post_media WHERE post_id = ? AND kind = 'screenshot'`).bind(args.postId),
    insertMedia(db, args.postId, args.media, Date.now()),
  ]);
  return true;
}

/**
 * A video the author recorded or chose, with its poster frame, replacing the video before it. A new video moves the
 * post back to the top of feeds, at most once a day like a publish.
 */
export async function replaceVideo(
  db: D1Database,
  args: { postId: string; userId: string; video: NewMedia; poster: NewMedia | null; now?: number },
): Promise<void> {
  const post = await requireManagedPost(db, args.postId, args.userId);
  if (post.status === 'removed') {
    throw new ShowcaseError('This post was taken down after reports.', 409);
  }
  const now = args.now ?? Date.now();
  await db.batch([
    db.prepare(`DELETE FROM post_media WHERE post_id = ? AND kind IN ('video', 'poster')`).bind(args.postId),
    insertMedia(db, args.postId, args.video, now),
    ...(args.poster ? [insertMedia(db, args.postId, args.poster, now)] : []),
    db
      .prepare(
        `UPDATE posts SET updated_at = ?2, shown_at = CASE WHEN status = 'visible' AND ?2 - shown_at > ?3 THEN ?2
           ELSE shown_at END WHERE id = ?1`,
      )
      .bind(args.postId, now, POST_MOVE_INTERVAL_MS),
  ]);
}

/** Removes a post's video and its poster. */
export async function removeVideo(db: D1Database, args: { postId: string; userId: string }): Promise<void> {
  await requireManagedPost(db, args.postId, args.userId);
  await db.prepare(`DELETE FROM post_media WHERE post_id = ? AND kind IN ('video', 'poster')`).bind(args.postId).run();
}

/** A media item to serve: only a ready one of a post anyone may see. */
export async function mediaToServe(
  db: D1Database,
  mediaId: string,
): Promise<{ r2Key: string; contentType: string } | null> {
  const row = await db
    .prepare(
      `SELECT media.r2_key, media.content_type FROM post_media AS media
       JOIN posts ON posts.id = media.post_id ${POST_JOINS}
       WHERE media.id = ?1 AND media.state = 'ready' AND ${PUBLIC}`,
    )
    .bind(mediaId)
    .first<{ r2_key: string; content_type: string }>();
  return row ? { r2Key: row.r2_key, contentType: row.content_type } : null;
}

/** R2 objects whose media rows are gone, oldest first, for the maintenance to delete. */
export async function pendingMediaDeletions(db: D1Database, limit = 100): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT r2_key FROM post_media_deletions ORDER BY deleted_at LIMIT ?')
    .bind(limit)
    .all<{ r2_key: string }>();
  return results.map((row) => row.r2_key);
}

export async function forgetMediaDeletions(db: D1Database, keys: readonly string[]): Promise<void> {
  if (keys.length > 0) {
    await db
      .prepare('DELETE FROM post_media_deletions WHERE r2_key IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(keys))
      .run();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Following, likes, comments, copies
// ---------------------------------------------------------------------------------------------------------------

async function userIdOf(db: D1Database, username: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM "user" WHERE username = ? AND showcase_paused_at IS NULL')
    .bind(username)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Notifies `userId` of something `actorId` did, unless they did it to themselves. */
function notify(
  db: D1Database,
  args: {
    userId: string;
    kind: NotificationView['kind'];
    actorId: string | null;
    postId: string | null;
    detail?: string | null;
  },
): D1PreparedStatement | null {
  if (args.actorId !== null && args.actorId === args.userId) {
    return null;
  }
  return db
    .prepare(
      `INSERT INTO notifications (id, user_id, kind, actor_id, post_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), args.userId, args.kind, args.actorId, args.postId, args.detail ?? null, Date.now());
}

/** Follows or stops following the person `username`. Answers whether `userId` follows them now, and their count. */
export async function setFollowing(
  db: D1Database,
  args: { userId: string; username: string; follow: boolean; now?: number },
): Promise<{ following: boolean; followers: number }> {
  const followeeId = await userIdOf(db, args.username);
  if (!followeeId) {
    throw new ShowcaseError('There’s nobody here by that name.', 404);
  }
  if (followeeId === args.userId) {
    throw new ShowcaseError('You can’t follow yourself.', 400);
  }
  const now = args.now ?? Date.now();
  if (args.follow) {
    const today = await db
      .prepare('SELECT COUNT(*) AS count FROM follows WHERE follower_id = ? AND created_at > ?')
      .bind(args.userId, now - DAY_MS)
      .first<{ count: number }>();
    if ((today?.count ?? 0) >= DAILY_LIMITS.follows) {
      throw new ShowcaseError('You’ve followed a lot of people today. Try again tomorrow.', 429);
    }
    const added = await db
      .prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)')
      .bind(args.userId, followeeId, now)
      .run();
    if (added.meta.changes === 1) {
      // Following again soon after stopping doesn't tell them twice.
      const told = await db
        .prepare(
          `SELECT 1 AS yes FROM notifications WHERE user_id = ? AND actor_id = ? AND kind = 'new_follower' AND created_at > ?`,
        )
        .bind(followeeId, args.userId, now - DAY_MS)
        .first();
      const statement = told
        ? null
        : notify(db, { userId: followeeId, kind: 'new_follower', actorId: args.userId, postId: null });
      await statement?.run();
    }
  } else {
    await db
      .prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(args.userId, followeeId)
      .run();
  }
  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM follows WHERE followee_id = ?')
    .bind(followeeId)
    .first<{ count: number }>();
  return { following: args.follow, followers: count?.count ?? 0 };
}

/** The people `userId` follows, or who follow them: visible only to that person. */
export async function listFollowPeople(
  db: D1Database,
  userId: string,
  which: 'followers' | 'following',
): Promise<{ username: string; name: string; image: string | null }[]> {
  const { results } = await db
    .prepare(
      which === 'followers'
        ? `SELECT people.username, people.name, people.image FROM follows JOIN "user" AS people ON people.id = follows.follower_id
           WHERE follows.followee_id = ? AND people.username IS NOT NULL ORDER BY follows.created_at DESC LIMIT 500`
        : `SELECT people.username, people.name, people.image FROM follows JOIN "user" AS people ON people.id = follows.followee_id
           WHERE follows.follower_id = ? AND people.username IS NOT NULL ORDER BY follows.created_at DESC LIMIT 500`,
    )
    .bind(userId)
    .all<{ username: string; name: string; image: string | null }>();
  return results;
}

async function requirePublicPost(db: D1Database, postId: string): Promise<PostView & { authorId: string }> {
  const row = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM ${POST_FROM} WHERE posts.id = ?1 AND ${PUBLIC}`)
    .bind(postId)
    .first<PostRow>();
  if (!row) {
    throw new ShowcaseError('This post isn’t shown any more.', 404);
  }
  return { ...toPostView(row), authorId: row.author_id };
}

/** Likes or unlikes a post anyone may see. Answers the like and the post's count. */
export async function setLiked(
  db: D1Database,
  args: { userId: string; postId: string; like: boolean; now?: number },
): Promise<{ liked: boolean; likeCount: number }> {
  const post = await requirePublicPost(db, args.postId);
  const now = args.now ?? Date.now();
  if (args.like) {
    const added = await db
      .prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)')
      .bind(args.postId, args.userId, now)
      .run();
    if (added.meta.changes === 1) {
      const told = await db
        .prepare(
          `SELECT 1 AS yes FROM notifications WHERE user_id = ? AND actor_id = ? AND post_id = ? AND kind = 'post_liked'`,
        )
        .bind(post.authorId, args.userId, args.postId)
        .first();
      const tell = told
        ? null
        : notify(db, { userId: post.authorId, kind: 'post_liked', actorId: args.userId, postId: args.postId });
      await db.batch([
        db.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').bind(args.postId),
        ...(tell ? [tell] : []),
      ]);
    }
  } else {
    const removed = await db
      .prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?')
      .bind(args.postId, args.userId)
      .run();
    if (removed.meta.changes === 1) {
      await db.prepare('UPDATE posts SET like_count = max(like_count - 1, 0) WHERE id = ?').bind(args.postId).run();
    }
  }
  const count = await db
    .prepare('SELECT like_count FROM posts WHERE id = ?')
    .bind(args.postId)
    .first<{ like_count: number }>();
  return { liked: args.like, likeCount: count?.like_count ?? 0 };
}

/** Who liked a post: only for the people who manage it. */
export async function listLikers(
  db: D1Database,
  args: { postId: string; userId: string },
): Promise<{ username: string | null; name: string }[]> {
  await requireManagedPost(db, args.postId, args.userId);
  const { results } = await db
    .prepare(
      `SELECT people.username, people.name FROM post_likes JOIN "user" AS people ON people.id = post_likes.user_id
       WHERE post_likes.post_id = ? ORDER BY post_likes.created_at DESC LIMIT 500`,
    )
    .bind(args.postId)
    .all<{ username: string | null; name: string }>();
  return results;
}

type CommentRow = {
  id: string;
  body: string;
  created_at: number;
  author_id: string;
  username: string | null;
  name: string;
  image: string | null;
};

function toComment(row: CommentRow): PostComment {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: { username: row.username, name: row.name, image: row.image },
  };
}

/** A post's visible comments, oldest first, a page at a time after `after` (ms). */
export async function listComments(
  db: D1Database,
  postId: string,
  after = 0,
): Promise<{ comments: PostComment[]; more: boolean }> {
  const post = await findPublicPost(db, postId);
  if (!post) {
    return { comments: [], more: false };
  }
  const limit = 50;
  const { results } = await db
    .prepare(
      `SELECT comments.id, comments.body, comments.created_at, comments.author_id, people.username, people.name, people.image
       FROM post_comments AS comments JOIN "user" AS people ON people.id = comments.author_id
       WHERE comments.post_id = ?1 AND comments.status = 'visible' AND comments.created_at > ?2
         AND people.showcase_paused_at IS NULL
       ORDER BY comments.created_at LIMIT ?3`,
    )
    .bind(postId, after, limit + 1)
    .all<CommentRow>();
  return { comments: results.slice(0, limit).map(toComment), more: results.length > limit };
}

/** A comment on a post anyone may see, by someone with a username. */
export async function addComment(
  db: D1Database,
  args: { userId: string; postId: string; body: string; now?: number },
): Promise<PostComment> {
  const body = args.body.trim();
  if (!body || body.length > 1000) {
    throw new ShowcaseError('Write a comment of up to 1,000 characters.', 400);
  }
  const problem = captionProblem(body);
  if (problem) {
    throw new ShowcaseError(problem.replace('caption', 'comment'), 400);
  }
  const post = await requirePublicPost(db, args.postId);
  const now = args.now ?? Date.now();
  const author = await db
    .prepare(
      `SELECT username, name, image, showcase_paused_at,
         (SELECT COUNT(*) FROM post_comments WHERE author_id = ?1 AND created_at > ?2) AS today
       FROM "user" WHERE id = ?1`,
    )
    .bind(args.userId, now - DAY_MS)
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
  if (author.today >= DAILY_LIMITS.comments) {
    throw new ShowcaseError('You’ve commented a lot today. Try again tomorrow.', 429);
  }
  const id = crypto.randomUUID();
  const tell = notify(db, {
    userId: post.authorId,
    kind: 'post_commented',
    actorId: args.userId,
    postId: args.postId,
    detail: body.slice(0, 140),
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO post_comments (id, post_id, author_id, body, status, created_at) VALUES (?, ?, ?, ?, 'visible', ?)`,
      )
      .bind(id, args.postId, args.userId, body, now),
    db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').bind(args.postId),
    ...(tell ? [tell] : []),
  ]);
  return {
    id,
    body,
    createdAt: now,
    author: { username: author.username, name: author.name, image: author.image },
  };
}

/** Deletes a comment: by the person who wrote it, or by someone who manages the post. */
export async function deleteComment(db: D1Database, args: { userId: string; commentId: string }): Promise<void> {
  const comment = await db
    .prepare(
      `SELECT comments.id, comments.post_id, comments.status FROM post_comments AS comments
       JOIN posts ON posts.id = comments.post_id JOIN org_projects AS projects ON projects.id = posts.project_id
       WHERE comments.id = ?1 AND (comments.author_id = ?2 OR ${MANAGES})`,
    )
    .bind(args.commentId, args.userId)
    .first<{ id: string; post_id: string; status: string }>();
  if (!comment) {
    throw new ShowcaseError('Only the person who wrote it, or whose post it is, can delete a comment.', 403);
  }
  await db.batch([
    db.prepare('DELETE FROM post_comments WHERE id = ?').bind(comment.id),
    ...(comment.status === 'visible'
      ? [db.prepare('UPDATE posts SET comment_count = max(comment_count - 1, 0) WHERE id = ?').bind(comment.post_id)]
      : []),
  ]);
}

/**
 * A copy of the project `sourceProjectId` was made by `copierId`: its post counts the copy and tells its author.
 * Nothing happens for a project with no post.
 */
export async function recordCopy(db: D1Database, args: { sourceProjectId: string; copierId: string }): Promise<void> {
  const post = await db
    .prepare(
      `SELECT posts.id, posts.author_id, projects.name FROM posts
       JOIN org_projects AS projects ON projects.id = posts.project_id WHERE posts.project_id = ?`,
    )
    .bind(args.sourceProjectId)
    .first<{ id: string; author_id: string; name: string }>();
  if (!post) {
    return;
  }
  const tell = notify(db, {
    userId: post.author_id,
    kind: 'project_copied',
    actorId: args.copierId,
    postId: post.id,
    detail: post.name,
  });
  await db.batch([
    db.prepare('UPDATE posts SET copy_count = copy_count + 1 WHERE id = ?').bind(post.id),
    ...(tell ? [tell] : []),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// Copies waiting for a space
// ---------------------------------------------------------------------------------------------------------------

/** "Make a copy" by someone with no space yet: kept until they have one. */
export async function addPendingCopy(
  db: D1Database,
  args: { userId: string; projectId: string; name: string },
): Promise<void> {
  const project = await db
    .prepare(`SELECT 1 AS yes FROM org_projects WHERE id = ? AND visibility = 'public'`)
    .bind(args.projectId)
    .first();
  if (!project) {
    throw new ShowcaseError('That project isn’t public any more, so it can’t be copied.', 404);
  }
  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM pending_copies WHERE user_id = ?')
    .bind(args.userId)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= 10) {
    throw new ShowcaseError('You have 10 copies waiting already. They’re made once your space is ready.', 429);
  }
  await db
    .prepare(
      `INSERT INTO pending_copies (user_id, project_id, name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, project_id) DO UPDATE SET name = excluded.name`,
    )
    .bind(args.userId, args.projectId, args.name, Date.now())
    .run();
}

/** The copies `userId` asked for before they had a space, oldest first, while their project is still public. */
export async function listPendingCopies(
  db: D1Database,
  userId: string,
): Promise<{ projectId: string; name: string; sourceName: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT pending.project_id, pending.name, projects.name AS source_name FROM pending_copies AS pending
       JOIN org_projects AS projects ON projects.id = pending.project_id
       WHERE pending.user_id = ? AND projects.visibility = 'public' ORDER BY pending.created_at`,
    )
    .bind(userId)
    .all<{ project_id: string; name: string; source_name: string }>();
  return results.map((row) => ({ projectId: row.project_id, name: row.name, sourceName: row.source_name }));
}

export async function removePendingCopy(db: D1Database, userId: string, projectId: string): Promise<void> {
  await db.prepare('DELETE FROM pending_copies WHERE user_id = ? AND project_id = ?').bind(userId, projectId).run();
}

// ---------------------------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------------------------

/** How many notifications `userId` hasn't read, for the dot on their avatar. */
export async function unreadNotifications(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * The newest notifications of `userId`. Likes of one post on one day are grouped: "Sara and 3 others liked Recipe
 * Box."
 */
export async function listNotifications(db: D1Database, userId: string): Promise<NotificationView[]> {
  const { results } = await db
    .prepare(
      `SELECT notifications.id, notifications.kind, notifications.detail, notifications.created_at,
         notifications.read_at, notifications.post_id,
         actors.username AS actor_username, actors.name AS actor_name, actors.image AS actor_image,
         projects.name AS project_name, owners.username AS owner_username, projects.slug AS project_slug
       FROM notifications
       LEFT JOIN "user" AS actors ON actors.id = notifications.actor_id
       LEFT JOIN posts ON posts.id = notifications.post_id
       LEFT JOIN org_projects AS projects ON projects.id = posts.project_id
       LEFT JOIN "user" AS owners ON owners.id = projects.created_by
       WHERE notifications.user_id = ? ORDER BY notifications.created_at DESC, notifications.rowid DESC LIMIT 200`,
    )
    .bind(userId)
    .all<{
      id: string;
      kind: NotificationView['kind'];
      detail: string | null;
      created_at: number;
      read_at: number | null;
      post_id: string | null;
      actor_username: string | null;
      actor_name: string | null;
      actor_image: string | null;
      project_name: string | null;
      owner_username: string | null;
      project_slug: string | null;
    }>();
  const views: NotificationView[] = [];
  const likeGroups = new Map<string, NotificationView>();
  for (const row of results) {
    const actor = row.actor_name
      ? { username: row.actor_username, name: row.actor_name, image: row.actor_image }
      : null;
    const postPath = row.owner_username && row.project_slug ? `/${row.owner_username}/${row.project_slug}` : null;
    if (row.kind === 'post_liked' && row.post_id) {
      const key = `${row.post_id}:${new Date(row.created_at).toISOString().slice(0, 10)}`;
      const group = likeGroups.get(key);
      if (group) {
        group.others += 1;
        group.unread ||= row.read_at === null;
        continue;
      }
      const view: NotificationView = {
        id: row.id,
        kind: row.kind,
        actor,
        others: 0,
        projectName: row.project_name ?? row.detail,
        postPath,
        detail: null,
        createdAt: row.created_at,
        unread: row.read_at === null,
      };
      likeGroups.set(key, view);
      views.push(view);
      continue;
    }
    views.push({
      id: row.id,
      kind: row.kind,
      actor,
      others: 0,
      projectName: row.project_name ?? (row.kind === 'project_copied' ? row.detail : null),
      postPath,
      detail: row.kind === 'project_copied' ? null : row.detail,
      createdAt: row.created_at,
      unread: row.read_at === null,
    });
  }
  return views.slice(0, 100);
}

export async function markNotificationsRead(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .bind(Date.now(), userId)
    .run();
}

// ---------------------------------------------------------------------------------------------------------------
// Reports and takedown
// ---------------------------------------------------------------------------------------------------------------

/**
 * A report of a post, or of one of its comments, by someone signed in or by a visitor (known only by the SHA-256 of
 * their address). Open reports from `REPORTS_TO_HOLD` different people hold the post or comment until an operator
 * decides; one report CloudChef's own checks file (`automatic`) holds it at once. Answers whether it is held.
 */
export async function fileReport(
  db: D1Database,
  args: {
    postId: string;
    commentId: string | null;
    reporterId: string | null;
    reporterIpHash: string | null;
    reason: ReportReason;
    note: string | null;
    automatic?: boolean;
    now?: number;
  },
): Promise<{ held: boolean }> {
  const now = args.now ?? Date.now();
  const target = await db
    .prepare(
      args.commentId
        ? `SELECT 1 AS yes FROM post_comments WHERE id = ?2 AND post_id = ?1 AND status <> 'removed'`
        : `SELECT 1 AS yes FROM posts WHERE id = ?1 AND status <> 'removed'`,
    )
    .bind(...(args.commentId ? [args.postId, args.commentId] : [args.postId]))
    .first();
  if (!target) {
    throw new ShowcaseError('That isn’t on CloudChef any more.', 404);
  }
  if (!args.automatic) {
    const filed = await db
      .prepare(
        args.reporterId
          ? 'SELECT COUNT(*) AS count FROM post_reports WHERE reporter_id = ? AND created_at > ?'
          : 'SELECT COUNT(*) AS count FROM post_reports WHERE reporter_ip_hash = ? AND created_at > ?',
      )
      .bind(args.reporterId ?? args.reporterIpHash, now - DAY_MS)
      .first<{ count: number }>();
    const limit = args.reporterId ? DAILY_LIMITS.signedInReports : DAILY_LIMITS.reports;
    if ((filed?.count ?? 0) >= limit) {
      throw new ShowcaseError('You’ve sent a lot of reports today. Thank you; try again tomorrow.', 429);
    }
  }
  await db
    .prepare(
      `INSERT INTO post_reports (id, post_id, comment_id, reporter_id, reporter_ip_hash, reason, note, automatic, state,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .bind(
      crypto.randomUUID(),
      args.postId,
      args.commentId,
      args.reporterId,
      args.reporterId ? null : args.reporterIpHash,
      args.reason,
      args.note,
      args.automatic ? 1 : 0,
      now,
    )
    .run();
  const reporters = await db
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(reporter_id, reporter_ip_hash)) AS people, MAX(automatic) AS automatic
       FROM post_reports WHERE post_id = ?1 AND comment_id IS ?2 AND state = 'open'`,
    )
    .bind(args.postId, args.commentId)
    .first<{ people: number; automatic: number | null }>();
  const hold = (reporters?.people ?? 0) >= REPORTS_TO_HOLD || reporters?.automatic === 1;
  if (!hold) {
    return { held: false };
  }
  await (
    args.commentId
      ? db.prepare(`UPDATE post_comments SET status = 'held' WHERE id = ? AND status = 'visible'`).bind(args.commentId)
      : db
          .prepare(
            `UPDATE posts SET status = 'hidden', hidden_reason = 'reported', updated_at = ?2
           WHERE id = ?1 AND status = 'visible'`,
          )
          .bind(args.postId, now)
  ).run();
  // A held comment no longer counts on its post.
  if (args.commentId) {
    await db
      .prepare(
        `UPDATE posts SET comment_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = ?1 AND status = 'visible')
         WHERE id = ?1`,
      )
      .bind(args.postId)
      .run();
  }
  return { held: true };
}

/** One post or comment with open reports, as the operator's page lists it. */
export type ReportedItem = {
  postId: string;
  commentId: string | null;
  reports: { id: string; reason: ReportReason; note: string | null; automatic: boolean; createdAt: number }[];
  post: {
    title: string;
    path: string | null;
    siteUrl: string;
    status: string;
    hiddenReason: string | null;
    caption: string | null;
    screenshotUrl: string | null;
    author: { id: string; username: string | null; name: string; email: string; paused: boolean };
  };
  comment: { body: string; status: string; author: { username: string | null; name: string } } | null;
};

/** Every post and comment with open reports, the most reported first: the operator's page. */
export async function listOpenReports(db: D1Database): Promise<ReportedItem[]> {
  const { results } = await db
    .prepare(
      `SELECT reports.id, reports.post_id, reports.comment_id, reports.reason, reports.note, reports.automatic,
         reports.created_at, projects.name AS project_name, owners.username AS owner_username,
         projects.slug AS project_slug, posts.site_url, posts.status, posts.hidden_reason, posts.caption,
         authors.id AS author_id, authors.username AS author_username, authors.name AS author_name,
         authors.email AS author_email, authors.showcase_paused_at,
         (SELECT media.id FROM post_media AS media WHERE media.post_id = posts.id AND media.kind = 'screenshot')
           AS screenshot_id,
         comments.body AS comment_body, comments.status AS comment_status,
         commenters.username AS commenter_username, commenters.name AS commenter_name
       FROM post_reports AS reports
       JOIN posts ON posts.id = reports.post_id
       JOIN org_projects AS projects ON projects.id = posts.project_id
       JOIN "user" AS authors ON authors.id = posts.author_id
       LEFT JOIN "user" AS owners ON owners.id = projects.created_by
       LEFT JOIN post_comments AS comments ON comments.id = reports.comment_id
       LEFT JOIN "user" AS commenters ON commenters.id = comments.author_id
       WHERE reports.state = 'open' ORDER BY reports.created_at LIMIT 500`,
    )
    .all<{
      id: string;
      post_id: string;
      comment_id: string | null;
      reason: ReportReason;
      note: string | null;
      automatic: number;
      created_at: number;
      project_name: string;
      owner_username: string | null;
      project_slug: string | null;
      site_url: string;
      status: string;
      hidden_reason: string | null;
      caption: string | null;
      author_id: string;
      author_username: string | null;
      author_name: string;
      author_email: string;
      showcase_paused_at: number | null;
      screenshot_id: string | null;
      comment_body: string | null;
      comment_status: string | null;
      commenter_username: string | null;
      commenter_name: string | null;
    }>();
  const items = new Map<string, ReportedItem>();
  for (const row of results) {
    const key = `${row.post_id}:${row.comment_id ?? ''}`;
    let item = items.get(key);
    if (!item) {
      item = {
        postId: row.post_id,
        commentId: row.comment_id,
        reports: [],
        post: {
          title: row.project_name,
          path: row.owner_username && row.project_slug ? `/${row.owner_username}/${row.project_slug}` : null,
          siteUrl: row.site_url,
          status: row.status,
          hiddenReason: row.hidden_reason,
          caption: row.caption,
          // The operator sees a held post's picture too: through their own page, not the public media address.
          screenshotUrl: row.screenshot_id ? `/api/showcase/reports/media?id=${row.screenshot_id}` : null,
          author: {
            id: row.author_id,
            username: row.author_username,
            name: row.author_name,
            email: row.author_email,
            paused: row.showcase_paused_at !== null,
          },
        },
        comment:
          row.comment_id && row.comment_body !== null
            ? {
                body: row.comment_body,
                status: row.comment_status ?? 'visible',
                author: { username: row.commenter_username, name: row.commenter_name ?? 'Someone' },
              }
            : null,
      };
      items.set(key, item);
    }
    item.reports.push({
      id: row.id,
      reason: row.reason,
      note: row.note,
      automatic: row.automatic === 1,
      createdAt: row.created_at,
    });
  }
  return [...items.values()].sort((first, second) => second.reports.length - first.reports.length);
}

/** A media item an operator may look at whatever its post's status, for reviewing reports. */
export async function mediaForReview(
  db: D1Database,
  mediaId: string,
): Promise<{ r2Key: string; contentType: string } | null> {
  const row = await db
    .prepare('SELECT r2_key, content_type FROM post_media WHERE id = ?')
    .bind(mediaId)
    .first<{ r2_key: string; content_type: string }>();
  return row ? { r2Key: row.r2_key, contentType: row.content_type } : null;
}

const REASON_WORDS = {
  scam_or_phishing: 'a scam',
  sexual: 'sexual content',
  violent_or_hateful: 'violent or hateful',
  copied_without_permission: 'copied without permission',
  spam: 'spam',
  other: 'breaking CloudChef’s terms',
} satisfies Record<ReportReason, string>;

/** "reported as a scam", for the notification and email that tell the author. */
function reasonWords(reason: ReportReason): string {
  return REASON_WORDS[reason];
}

/** What an operator decided about a reported post or comment. */
export type ReportDecision = 'dismiss' | 'remove' | 'pause_author';

/**
 * Decides the open reports of one post or comment. Dismissing shows again what reports held. Removing takes a post
 * down for good (its media deleted, its author told) or deletes a comment's words; an author with
 * `REMOVALS_TO_PAUSE` posts removed has their page paused for review. Pausing hides the author's page and every post
 * of theirs. Answers who to email about a removal.
 */
export async function decideReports(
  db: D1Database,
  args: { postId: string; commentId: string | null; operatorId: string; decision: ReportDecision; now?: number },
): Promise<{ removedPostAuthor: { email: string; name: string; title: string; reason: string } | null }> {
  const now = args.now ?? Date.now();
  const open = await db
    .prepare(
      `SELECT reason FROM post_reports WHERE post_id = ?1 AND comment_id IS ?2 AND state = 'open'
       ORDER BY automatic DESC, created_at LIMIT 1`,
    )
    .bind(args.postId, args.commentId)
    .first<{ reason: ReportReason }>();
  const closeReports = db
    .prepare(
      `UPDATE post_reports SET state = ?3, decided_by = ?4, decided_at = ?5
       WHERE post_id = ?1 AND comment_id IS ?2 AND state = 'open'`,
    )
    .bind(args.postId, args.commentId, args.decision === 'dismiss' ? 'dismissed' : 'actioned', args.operatorId, now);
  const recount = db
    .prepare(
      `UPDATE posts SET comment_count = (SELECT COUNT(*) FROM post_comments WHERE post_id = ?1 AND status = 'visible')
       WHERE id = ?1`,
    )
    .bind(args.postId);
  const post = await db
    .prepare(
      `SELECT posts.author_id, authors.email, authors.name, projects.name AS title FROM posts
       JOIN "user" AS authors ON authors.id = posts.author_id
       JOIN org_projects AS projects ON projects.id = posts.project_id WHERE posts.id = ?`,
    )
    .bind(args.postId)
    .first<{ author_id: string; email: string; name: string; title: string }>();
  if (!post) {
    throw new ShowcaseError('That post isn’t on CloudChef any more.', 404);
  }
  const reason = reasonWords(open?.reason ?? 'other');

  if (args.decision === 'dismiss') {
    await db.batch([
      closeReports,
      args.commentId
        ? db
            .prepare(`UPDATE post_comments SET status = 'visible' WHERE id = ? AND status = 'held'`)
            .bind(args.commentId)
        : db
            .prepare(
              `UPDATE posts SET status = 'visible', hidden_reason = NULL, updated_at = ?2
               WHERE id = ?1 AND status = 'hidden' AND hidden_reason = 'reported'`,
            )
            .bind(args.postId, now),
      recount,
    ]);
    return { removedPostAuthor: null };
  }

  if (args.decision === 'pause_author') {
    await db.batch([
      closeReports,
      db.prepare('UPDATE "user" SET showcase_paused_at = ? WHERE id = ?').bind(now, post.author_id),
    ]);
    return { removedPostAuthor: null };
  }

  if (args.commentId) {
    const comment = await db
      .prepare('SELECT author_id FROM post_comments WHERE id = ?')
      .bind(args.commentId)
      .first<{ author_id: string }>();
    const tell = comment
      ? notify(db, {
          userId: comment.author_id,
          kind: 'comment_removed',
          actorId: null,
          postId: args.postId,
          detail: reason,
        })
      : null;
    await db.batch([
      closeReports,
      db.prepare(`UPDATE post_comments SET status = 'removed', body = '-' WHERE id = ?`).bind(args.commentId),
      recount,
      ...(tell ? [tell] : []),
    ]);
    return { removedPostAuthor: null };
  }

  const tell = notify(db, {
    userId: post.author_id,
    kind: 'post_removed',
    actorId: null,
    postId: args.postId,
    detail: reason,
  });
  await db.batch([
    closeReports,
    db
      .prepare(`UPDATE posts SET status = 'removed', hidden_reason = NULL, updated_at = ?2 WHERE id = ?1`)
      .bind(args.postId, now),
    db.prepare('DELETE FROM post_media WHERE post_id = ?').bind(args.postId),
    ...(tell ? [tell] : []),
  ]);
  const removals = await db
    .prepare(`SELECT COUNT(*) AS count FROM posts WHERE author_id = ? AND status = 'removed'`)
    .bind(post.author_id)
    .first<{ count: number }>();
  if ((removals?.count ?? 0) >= REMOVALS_TO_PAUSE) {
    await db
      .prepare('UPDATE "user" SET showcase_paused_at = ? WHERE id = ? AND showcase_paused_at IS NULL')
      .bind(now, post.author_id)
      .run();
  }
  return { removedPostAuthor: { email: post.email, name: post.name, title: post.title, reason } };
}

/** Lifts the pause on a person's page. */
export async function unpausePerson(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE "user" SET showcase_paused_at = NULL WHERE id = ?').bind(userId).run();
}

// ---------------------------------------------------------------------------------------------------------------
// Account export
// ---------------------------------------------------------------------------------------------------------------

/** A post of theirs as the export lists it: its row, and its pictures and videos (`media`, as JSON). */
type ExportedPostRow = {
  id: string;
  project_id: string;
  caption: string | null;
  site_url: string;
  status: string;
  hidden_reason: string | null;
  published_count: number;
  like_count: number;
  comment_count: number;
  copy_count: number;
  created_at: number;
  updated_at: number;
  media: string;
};

/** Everything of the showcase that is `userId`'s, for their account export. */
export async function exportShowcase(db: D1Database, userId: string) {
  const [profile, posts, comments, following, likes] = await Promise.all([
    db.prepare('SELECT bio, showcase_paused_at FROM "user" WHERE id = ?').bind(userId).first(),
    db
      .prepare(
        `SELECT posts.id, posts.project_id, posts.caption, posts.site_url, posts.status, posts.hidden_reason,
           posts.published_count, posts.like_count, posts.comment_count, posts.copy_count, posts.created_at,
           posts.updated_at,
           (SELECT json_group_array(json_object('id', media.id, 'kind', media.kind, 'contentType', media.content_type,
              'bytes', media.bytes, 'state', media.state, 'createdAt', media.created_at))
            FROM post_media AS media WHERE media.post_id = posts.id) AS media
         FROM posts WHERE author_id = ? ORDER BY created_at LIMIT 200`,
      )
      .bind(userId)
      .all<ExportedPostRow>(),
    db
      .prepare(
        'SELECT id, post_id, body, status, created_at FROM post_comments WHERE author_id = ? ORDER BY created_at LIMIT 200',
      )
      .bind(userId)
      .all(),
    db
      .prepare(
        `SELECT people.username, follows.created_at FROM follows JOIN "user" AS people ON people.id = follows.followee_id
         WHERE follows.follower_id = ? ORDER BY follows.created_at LIMIT 200`,
      )
      .bind(userId)
      .all(),
    db
      .prepare('SELECT post_id, created_at FROM post_likes WHERE user_id = ? ORDER BY created_at LIMIT 200')
      .bind(userId)
      .all(),
  ]);
  return {
    profile,
    posts: posts.results.map((post) => ({
      ...post,
      // Each picture or video is at its address while the post is shown; the export lists them, not their bytes.
      // SAFETY: `media` is the json_group_array above, whose objects have these fields.
      media: (JSON.parse(post.media) as { id: string; contentType: string }[]).map((media) => ({
        ...media,
        address: mediaPath(media),
      })),
    })),
    comments: comments.results,
    following: following.results,
    likes: likes.results,
  };
}
