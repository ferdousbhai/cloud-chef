import { z } from 'zod';
import { getAuthSession, type CloudflareAuthSession } from '~/lib/.server/auth';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { publicOrigin } from '~/lib/.server/public-origin';
import { sha256Hex } from '~/lib/hex-digest';
import {
  addComment,
  addPendingCopy,
  decideReports,
  deleteComment,
  deletePost,
  fileReport,
  followsPerson,
  listComments,
  listExplorePosts,
  listFeedPosts,
  listFollowPeople,
  listLikers,
  listNotifications,
  listOpenReports,
  listOwnHiddenPosts,
  listPendingCopies,
  listPersonPosts,
  markNotificationsRead,
  removePendingCopy,
  removeVideo,
  replaceVideo,
  setBio,
  setFollowing,
  setLiked,
  setPostCaption,
  setPostShown,
  ShowcaseError,
  unpausePerson,
  unreadNotifications,
  viewerStateOfPosts,
  type NewMedia,
} from '~/lib/cloudflare/data/posts.server';
import {
  deleteGoneMediaBestEffort,
  mediaKey,
  serveMediaForReview,
  sniffContentType,
} from '~/lib/.server/showcase/media';
import { classifyMedia } from '~/lib/.server/showcase/screenshot';
import {
  BIO_MAX,
  CAPTION_MAX,
  COMMENT_MAX,
  POSTER_MAX_BYTES,
  REPORT_REASONS,
  VIDEO_LIMITS,
  type ShowcaseCursor,
} from '~/lib/showcase';
import { SENDER } from './email-auth';
import { copyProjectFor } from './command-line';
import { answeringOrganizationErrors } from './signed-in';

/**
 * The showcase's routes (docs/proposals/showcase-and-feed.md): what a page shows a signed-in person differently,
 * following, likes, comments, reports, an author's controls on their post, video uploads, notifications, copies
 * waiting for a space, and the operators' reports page. Reading pages and posts is public (the routes' loaders, in
 * `app/lib/showcase-loaders.ts`); changing anything needs sign-in, except reporting.
 */

type Handler = (args: { request: Request; env: Env }) => Promise<Response>;

const ID = z.string().uuid();
const USERNAME = z.string().regex(/^[a-z0-9-]{1,39}$/);

function json<Answer>(body: Answer, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Answers a showcase refusal with its words and status; anything else is the route's crash. */
async function answering(run: () => Promise<Response>): Promise<Response> {
  try {
    return await answeringOrganizationErrors(run);
  } catch (error) {
    if (error instanceof ShowcaseError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
}

function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin;
}

/**
 * Runs `handler` for a signed-in person. A change (any POST) must come from CloudChef's own pages, and is limited per
 * person, so a script can't follow or like at volume.
 */
function signedInShowcase(
  request: Request,
  env: Env,
  handler: (args: { session: CloudflareAuthSession }) => Promise<Response>,
): Promise<Response> {
  return answering(async () => {
    if (request.method !== 'GET' && !sameOrigin(request)) {
      return json({ error: 'Invalid request origin.' }, 403);
    }
    const session = await getAuthSession(env, request);
    if (!session) {
      return json({ error: 'Sign in first.' }, 401);
    }
    if (request.method !== 'GET') {
      const { success } = await env.SHOWCASE_ACTION_RATE_LIMITER.limit({ key: `showcase:${session.user.id}` });
      if (!success) {
        return json({ error: 'That’s a lot at once. Wait a minute and try again.' }, 429);
      }
    }
    return handler({ session });
  });
}

function cursorFrom(url: URL): ShowcaseCursor | null {
  const shownAt = Number(url.searchParams.get('before'));
  const id = url.searchParams.get('beforeId');
  return Number.isSafeInteger(shownAt) && shownAt > 0 && id && ID.safeParse(id).success ? { shownAt, id } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

/**
 * `GET /api/showcase/viewer?posts=<ids>&person=<username>`: what the signed-in person sees differently on a page:
 * who they are, which of its posts they liked and manage, and whether they follow the person whose page it is. A
 * visitor gets `signedIn: false`.
 */
export const viewerAction: Handler = ({ request, env }) =>
  answering(async () => {
    const session = await getAuthSession(env, request);
    if (!session) {
      return json({ signedIn: false });
    }
    const url = new URL(request.url);
    const postIds = (url.searchParams.get('posts') ?? '')
      .split(',')
      .filter((id) => ID.safeParse(id).success)
      .slice(0, 100);
    const person = USERNAME.safeParse(url.searchParams.get('person'));
    const [posts, following, unread] = await Promise.all([
      viewerStateOfPosts(env.DB, session.user.id, postIds),
      person.success && person.data !== session.user.username
        ? followsPerson(env.DB, session.user.id, person.data)
        : Promise.resolve(null),
      unreadNotifications(env.DB, session.user.id),
    ]);
    return json({
      signedIn: true,
      me: {
        username: session.user.username,
        name: session.user.name,
        image: session.user.image,
        hasSpace: session.context !== null,
      },
      liked: posts.liked,
      managed: posts.managed,
      following,
      unread,
    });
  });

/** `GET /api/showcase/explore?before=&beforeId=`: the next page of Explore, for anyone. */
export const explorePageAction: Handler = async ({ request, env }) =>
  json(await listExplorePosts(env.DB, cursorFrom(new URL(request.url))));

/** `GET /api/showcase/person?username=&before=&beforeId=`: the next page of a person's posts, for anyone. */
export const personPageAction: Handler = async ({ request, env }) => {
  const url = new URL(request.url);
  const username = USERNAME.safeParse(url.searchParams.get('username'));
  return username.success
    ? json(await listPersonPosts(env.DB, username.data, cursorFrom(url)))
    : json({ error: 'Name a person.' }, 400);
};

/** `GET /api/showcase/feed?before=&beforeId=`: posts from the people the signed-in person follows. */
export const feedAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) =>
    json(await listFeedPosts(env.DB, session.user.id, cursorFrom(new URL(request.url)))),
  );

/** `GET /api/showcase/comments?postId=&after=`: a post's comments, for anyone who may see it. */
export const commentsAction: Handler = async ({ request, env }) => {
  const url = new URL(request.url);
  const postId = ID.safeParse(url.searchParams.get('postId'));
  if (!postId.success) {
    return json({ error: 'Name a post.' }, 400);
  }
  const after = Number(url.searchParams.get('after') ?? 0);
  return json(await listComments(env.DB, postId.data, Number.isSafeInteger(after) ? after : 0));
};

// ---------------------------------------------------------------------------------------------------------------
// Following, likes, comments
// ---------------------------------------------------------------------------------------------------------------

const followSchema = z.strictObject({ username: USERNAME, follow: z.boolean() });

/** `POST /api/showcase/follow`: follow or stop following someone. */
export const followAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, followSchema, 'Name the person to follow.');
    if ('response' in body) {
      return body.response;
    }
    return json(await setFollowing(env.DB, { userId: session.user.id, ...body.data }));
  });

/** `GET /api/showcase/follows?which=followers|following`: the signed-in person's own lists. */
export const followListAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const which = new URL(request.url).searchParams.get('which') === 'following' ? 'following' : 'followers';
    return json({ people: await listFollowPeople(env.DB, session.user.id, which) });
  });

const likeSchema = z.strictObject({ postId: ID, like: z.boolean() });

/** `POST /api/showcase/like`: like or unlike a post. */
export const likeAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, likeSchema, 'Name the post to like.');
    if ('response' in body) {
      return body.response;
    }
    return json(await setLiked(env.DB, { userId: session.user.id, ...body.data }));
  });

/** `GET /api/showcase/likers?postId=`: who liked a post, for the people who manage it. */
export const likersAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const postId = ID.safeParse(new URL(request.url).searchParams.get('postId'));
    if (!postId.success) {
      return json({ error: 'Name a post.' }, 400);
    }
    return json({ people: await listLikers(env.DB, { postId: postId.data, userId: session.user.id }) });
  });

const commentSchema = z.strictObject({ postId: ID, body: z.string().max(COMMENT_MAX * 2) });

/** `POST /api/showcase/comments/add`: a comment on a post. */
export const addCommentAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, commentSchema, 'Write a comment.', 8_192);
    if ('response' in body) {
      return body.response;
    }
    return json({ comment: await addComment(env.DB, { userId: session.user.id, ...body.data }) }, 201);
  });

const commentIdSchema = z.strictObject({ commentId: ID });

/** `POST /api/showcase/comments/delete`: by the person who wrote it, or whose post it is. */
export const deleteCommentAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, commentIdSchema, 'Name the comment.');
    if ('response' in body) {
      return body.response;
    }
    await deleteComment(env.DB, { userId: session.user.id, commentId: body.data.commentId });
    return json({ deleted: true });
  });

// ---------------------------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------------------------

const reportSchema = z.strictObject({
  postId: ID,
  commentId: ID.nullable().default(null),
  reason: z.enum(REPORT_REASONS),
  note: z.string().trim().max(1000).default(''),
});

/**
 * `POST /api/showcase/report`: a report of a post or comment, by anyone, signed in or not. A visitor is known only by
 * the SHA-256 of their address, and limited per address (a few a minute, five a day).
 */
export const reportAction: Handler = ({ request, env }) =>
  answering(async () => {
    if (!sameOrigin(request)) {
      return json({ error: 'Invalid request origin.' }, 403);
    }
    const ipHash = await sha256Hex(`showcase-report:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
    const { success } = await env.SHOWCASE_REPORT_RATE_LIMITER.limit({ key: ipHash.slice(0, 32) });
    if (!success) {
      return json({ error: 'That’s a lot of reports at once. Wait a minute and try again.' }, 429);
    }
    const body = await readJsonRequest(request, reportSchema, 'Choose what is wrong.');
    if ('response' in body) {
      return body.response;
    }
    const session = await getAuthSession(env, request);
    await fileReport(env.DB, {
      postId: body.data.postId,
      commentId: body.data.commentId,
      reporterId: session?.user.id ?? null,
      reporterIpHash: ipHash,
      reason: body.data.reason,
      note: body.data.note || null,
    });
    // Whether it is now held is CloudChef's to know: the reporter is thanked the same either way.
    return json({ reported: true }, 201);
  });

// ---------------------------------------------------------------------------------------------------------------
// The author's controls
// ---------------------------------------------------------------------------------------------------------------

const captionSchema = z.strictObject({ postId: ID, caption: z.string().max(CAPTION_MAX) });

/** `POST /api/showcase/posts/caption`: set or clear a post's caption. */
export const captionAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, captionSchema, 'Write a caption of up to 2,000 characters.', 16_384);
    if ('response' in body) {
      return body.response;
    }
    await setPostCaption(env.DB, { userId: session.user.id, ...body.data });
    return json({ caption: body.data.caption.trim() || null });
  });

const shownSchema = z.strictObject({ postId: ID, shown: z.boolean() });

/** `POST /api/showcase/posts/shown`: "Hide from my page" or "Show on my page". */
export const shownAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, shownSchema, 'Choose to show or hide the post.');
    if ('response' in body) {
      return body.response;
    }
    await setPostShown(env.DB, { userId: session.user.id, ...body.data });
    return json({ shown: body.data.shown });
  });

const postIdSchema = z.strictObject({ postId: ID });

/** `POST /api/showcase/posts/delete`: delete a post and its media. */
export const deletePostAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, postIdSchema, 'Name the post.');
    if ('response' in body) {
      return body.response;
    }
    await deletePost(env.DB, { userId: session.user.id, postId: body.data.postId });
    await deleteGoneMediaBestEffort(env);
    return json({ deleted: true });
  });

/** `POST /api/showcase/posts/video/remove`: take a post's video off it. */
export const removeVideoAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, postIdSchema, 'Name the post.');
    if ('response' in body) {
      return body.response;
    }
    await removeVideo(env.DB, { userId: session.user.id, postId: body.data.postId });
    await deleteGoneMediaBestEffort(env);
    return json({ removed: true });
  });

/** A whole multipart video upload: the video, its poster frame, and the form's few fields. */
const MAX_UPLOAD_BYTES = VIDEO_LIMITS.bytes + POSTER_MAX_BYTES + 64 * 1024;

/**
 * `POST /api/showcase/posts/video` (multipart: `postId`, `durationMs`, `width`, `height`, `video`, `poster`): a video
 * the author recorded in the browser or chose, at most 30 seconds and 25 MB, MP4 or WebM, with a poster frame the
 * browser took from it. What each file is comes from its bytes, never from what the browser said.
 */
export const uploadVideoAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const declared = Number(request.headers.get('Content-Length') ?? 'NaN');
    if (!Number.isFinite(declared) || declared > MAX_UPLOAD_BYTES) {
      return json({ error: 'Choose a video of up to 25 MB.' }, 413);
    }
    const form = await request.formData().catch(() => null);
    const postId = ID.safeParse(form?.get('postId'));
    const durationMs = Number(form?.get('durationMs'));
    const video = form?.get('video');
    const poster = form?.get('poster');
    if (!postId.success || !(video instanceof File)) {
      return json({ error: 'Choose a video for the post.' }, 400);
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > VIDEO_LIMITS.seconds * 1000 + 500) {
      return json({ error: 'Choose a video of up to 30 seconds.' }, 400);
    }
    if (video.size > VIDEO_LIMITS.bytes) {
      return json({ error: 'Choose a video of up to 25 MB.' }, 413);
    }
    const videoBytes = new Uint8Array(await video.arrayBuffer());
    const videoType = sniffContentType(videoBytes);
    if (videoType !== 'video/mp4' && videoType !== 'video/webm') {
      return json({ error: 'Choose an MP4 or WebM video.' }, 400);
    }
    let posterMedia: { bytes: Uint8Array; contentType: string } | null = null;
    if (poster instanceof File && poster.size > 0 && poster.size <= POSTER_MAX_BYTES) {
      const posterBytes = new Uint8Array(await poster.arrayBuffer());
      const posterType = sniffContentType(posterBytes);
      if (posterType === 'image/webp' || posterType === 'image/jpeg' || posterType === 'image/png') {
        posterMedia = { bytes: posterBytes, contentType: posterType };
      }
    }
    const dimension = (name: string) => {
      const value = Number(form?.get(name));
      return Number.isSafeInteger(value) && value > 0 && value <= 8192 ? value : null;
    };
    const [width, height] = [dimension('width'), dimension('height')];
    // The project's own post, checked before anything is stored.
    await findManagedPostOrThrow(env, postId.data, session.user.id);

    const videoId = crypto.randomUUID();
    const videoKey = mediaKey(postId.data, videoId, videoType);
    const stored: string[] = [];
    try {
      await env.SHOWCASE_MEDIA.put(videoKey, videoBytes, { httpMetadata: { contentType: videoType } });
      stored.push(videoKey);
      const videoMedia: NewMedia = {
        id: videoId,
        kind: 'video',
        origin: 'uploaded',
        r2Key: videoKey,
        contentType: videoType,
        bytes: videoBytes.byteLength,
        width,
        height,
        durationMs: Math.round(durationMs),
        commit: null,
        // Only the poster can be looked at by a classifier; the video waits with it.
        state: 'ready',
      };
      let posterRow: NewMedia | null = null;
      if (posterMedia) {
        const posterId = crypto.randomUUID();
        const posterKey = mediaKey(postId.data, posterId, posterMedia.contentType);
        await env.SHOWCASE_MEDIA.put(posterKey, posterMedia.bytes, {
          httpMetadata: { contentType: posterMedia.contentType },
        });
        stored.push(posterKey);
        const state = await classifyMedia(env, posterMedia.bytes, posterMedia.contentType);
        videoMedia.state = state;
        posterRow = {
          id: posterId,
          kind: 'poster',
          origin: 'uploaded',
          r2Key: posterKey,
          contentType: posterMedia.contentType,
          bytes: posterMedia.bytes.byteLength,
          width,
          height,
          durationMs: null,
          commit: null,
          state,
        };
      }
      await replaceVideo(env.DB, {
        postId: postId.data,
        userId: session.user.id,
        video: videoMedia,
        poster: posterRow,
      });
    } catch (error) {
      await env.SHOWCASE_MEDIA.delete(stored).catch(() => undefined);
      throw error;
    }
    await deleteGoneMediaBestEffort(env);
    return json({ uploaded: true }, 201);
  });

async function findManagedPostOrThrow(env: Env, postId: string, userId: string): Promise<void> {
  const managed = await viewerStateOfPosts(env.DB, userId, [postId]);
  if (!managed.managed.includes(postId)) {
    throw new ShowcaseError('Only the person whose post it is, or their team’s admin, can do that.', 403);
  }
}

/** `GET /api/showcase/posts/hidden`: the signed-in person's own hidden posts, for their page. */
export const hiddenPostsAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) =>
    json({ posts: await listOwnHiddenPosts(env.DB, session.user.id) }),
  );

const bioSchema = z.strictObject({ bio: z.string().max(BIO_MAX) });

/** `POST /api/showcase/profile`: the line under the person's name on their page. */
export const profileAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, bioSchema, 'Write up to 300 characters.');
    if ('response' in body) {
      return body.response;
    }
    await setBio(env.DB, session.user.id, body.data.bio);
    return json({ bio: body.data.bio.trim() || null });
  });

// ---------------------------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------------------------

/** `GET /api/showcase/notifications`: the signed-in person's notifications, newest first. */
export const notificationsAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) =>
    json({ notifications: await listNotifications(env.DB, session.user.id) }),
  );

/** `POST /api/showcase/notifications/read`: marks them all read. */
export const readNotificationsAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    await markNotificationsRead(env.DB, session.user.id);
    return json({ read: true });
  });

// ---------------------------------------------------------------------------------------------------------------
// Copies waiting for a space
// ---------------------------------------------------------------------------------------------------------------

const copyLaterSchema = z.strictObject({ projectId: ID, name: z.string().trim().min(1).max(80) });

/**
 * `POST /api/showcase/copies/wait`: "Make a copy" by someone signed in with no space to copy into yet. The copy is
 * kept waiting and made once they have one (`POST /api/showcase/copies/make`).
 */
export const waitingCopyAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, copyLaterSchema, 'Choose the project to copy.');
    if ('response' in body) {
      return body.response;
    }
    await addPendingCopy(env.DB, { userId: session.user.id, ...body.data });
    return json({ waiting: true }, 201);
  });

/** `GET /api/showcase/copies`: the copies waiting for the signed-in person's space. */
export const waitingCopiesAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) =>
    json({ copies: await listPendingCopies(env.DB, session.user.id) }),
  );

const makeCopySchema = z.strictObject({ projectId: ID });

/**
 * `POST /api/showcase/copies/make`: makes one waiting copy now, in the account the person works in. It stays waiting
 * when their workspace isn't ready yet, and goes when it can never be made (the project went private or was deleted).
 */
export const makeWaitingCopyAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, makeCopySchema, 'Choose the copy to make.');
    if ('response' in body) {
      return body.response;
    }
    if (!session.context) {
      return json({ error: 'Connect a Cloudflare account first, for the copy to go into.' }, 409);
    }
    const waiting = (await listPendingCopies(env.DB, session.user.id)).find(
      (copy) => copy.projectId === body.data.projectId,
    );
    if (!waiting) {
      return json({ error: 'That copy isn’t waiting any more.' }, 404);
    }
    const copied = await copyProjectFor(request, env, {
      userId: session.user.id,
      projectId: waiting.projectId,
      connectionId: session.context.connectionId,
      name: waiting.name,
    });
    if ('refusal' in copied) {
      if (copied.status === 404 || copied.status === 403) {
        await removePendingCopy(env.DB, session.user.id, waiting.projectId);
      }
      return json({ error: copied.refusal }, copied.status);
    }
    await removePendingCopy(env.DB, session.user.id, waiting.projectId);
    return json(copied, 201);
  });

/** `POST /api/showcase/copies/forget`: stop waiting for a copy. */
export const forgetWaitingCopyAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, makeCopySchema, 'Choose the copy.');
    if ('response' in body) {
      return body.response;
    }
    await removePendingCopy(env.DB, session.user.id, body.data.projectId);
    return json({ forgotten: true });
  });

// ---------------------------------------------------------------------------------------------------------------
// Operators: reports and takedown
// ---------------------------------------------------------------------------------------------------------------

/** Whether `userId` is one of the operators named in `OPERATOR_USER_IDS`. */
function isOperator(env: Env, userId: string): boolean {
  return (env.OPERATOR_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}

function operatorOnly(
  request: Request,
  env: Env,
  handler: (session: CloudflareAuthSession) => Promise<Response>,
): Promise<Response> {
  return answering(async () => {
    if (request.method !== 'GET' && !sameOrigin(request)) {
      return json({ error: 'Invalid request origin.' }, 403);
    }
    const session = await getAuthSession(env, request);
    if (!session || !isOperator(env, session.user.id)) {
      return json({ error: 'This page is for CloudChef’s operators.' }, 403);
    }
    return handler(session);
  });
}

/** `GET /api/showcase/reports`: every post and comment with open reports. */
export const listReportsAction: Handler = ({ request, env }) =>
  operatorOnly(request, env, async () => json({ items: await listOpenReports(env.DB) }));

/** `GET /api/showcase/reports/media?id=`: a reported post's picture, whatever its status. */
export const reportMediaAction: Handler = ({ request, env }) =>
  operatorOnly(request, env, async () => {
    const id = ID.safeParse(new URL(request.url).searchParams.get('id'));
    return id.success ? serveMediaForReview(env, request, id.data) : json({ error: 'Name a picture.' }, 400);
  });

const decideSchema = z.strictObject({
  postId: ID,
  commentId: ID.nullable().default(null),
  decision: z.enum(['dismiss', 'remove', 'pause_author']),
});

/**
 * `POST /api/showcase/reports/decide`: dismiss the reports, remove the post or comment, or pause its author's page.
 * A removed post's author is told in CloudChef and by email.
 */
export const decideReportAction: Handler = ({ request, env }) =>
  operatorOnly(request, env, async (session) => {
    const body = await readJsonRequest(request, decideSchema, 'Choose what to do.');
    if ('response' in body) {
      return body.response;
    }
    const { removedPostAuthor } = await decideReports(env.DB, { ...body.data, operatorId: session.user.id });
    await deleteGoneMediaBestEffort(env);
    if (removedPostAuthor && env.SIGN_IN_EMAIL) {
      const support = new URL('/support', publicOrigin(request)).toString();
      const text =
        `Hi ${removedPostAuthor.name},\n\n${removedPostAuthor.title} was taken off your CloudChef page because it was ` +
        `reported as ${removedPostAuthor.reason}. The project itself is unchanged.\n\n` +
        `If you think that's wrong, tell us at ${support}.\n\nCloudChef`;
      await env.SIGN_IN_EMAIL.send({
        from: SENDER,
        to: removedPostAuthor.email,
        subject: `${removedPostAuthor.title} was taken off your CloudChef page`,
        text,
        html: text
          .split('\n\n')
          .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
          .join(''),
      }).catch(() => console.error('[Showcase] Unable to email a removal notice'));
    }
    return json({ decided: true });
  });

const unpauseSchema = z.strictObject({ userId: z.string().min(1).max(200) });

/** `POST /api/showcase/reports/unpause`: lifts the pause on a person's page. */
export const unpauseAction: Handler = ({ request, env }) =>
  operatorOnly(request, env, async () => {
    const body = await readJsonRequest(request, unpauseSchema, 'Name the person.');
    if ('response' in body) {
      return body.response;
    }
    await unpausePerson(env.DB, body.data.userId);
    return json({ unpaused: true });
  });

/** `GET /api/showcase/operator`: whether the signed-in person may open /reports. */
export const operatorAction: Handler = async ({ request, env }) => {
  const session = await getAuthSession(env, request);
  return json({ operator: session ? isOperator(env, session.user.id) : false });
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
