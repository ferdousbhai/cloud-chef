import { z } from 'zod';
import { getAuthSession, type CloudflareAuthSession } from '~/lib/.server/auth';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { publicOrigin } from '~/lib/.server/public-origin';
import { sha256Hex } from '~/lib/hex-digest';
import {
  addPendingCopy,
  decideReports,
  deletePost,
  fileReport,
  followsAnyone,
  followsPerson,
  listExplorePosts,
  listFollowedPosts,
  listFollowPeople,
  listLikers,
  listNotifications,
  listOpenReports,
  listOwnHiddenPosts,
  listPendingCopies,
  listPersonPosts,
  markNotificationsRead,
  removePendingCopy,
  removeReel,
  setBio,
  setFollowing,
  setLiked,
  setPostCaption,
  setPostShown,
  ShowcaseError,
  unpausePerson,
  unreadNotifications,
  viewerStateOfPosts,
  findPostByAddress,
} from '~/lib/cloudflare/data/posts.server';
import {
  addReply,
  closeThread,
  deleteComment,
  findThread,
  listCopies,
  listOwnSuggestableCopies,
  listReplies,
  listThreads,
  markThreadOnItsWay,
  mentionsCloudChef,
  offeredChange,
  offeredChangeNumber,
  offeredChangesAwaitingPreview,
  recordOfferedPreview,
  openThreadsOfProjects,
  reopenThread,
  setThreadFollowing,
  setThreadLocked,
  setThreadPinned,
  startThread,
} from '~/lib/cloudflare/data/post-threads.server';
import { answerMention } from '~/lib/.server/showcase/mention-runs';
import { recordRunsInPost } from '~/lib/.server/showcase/jobs';
import { deleteGoneMediaBestEffort, serveMediaForReview } from '~/lib/.server/showcase/media';
import { BIO_MAX, CAPTION_MAX, COMMENT_MAX, REPORT_REASONS, type ShowcaseCursor } from '~/lib/showcase';
import { SENDER } from './email-auth';
import { copyProjectFor, forwardToProjectAccount } from './command-line';
import { deploymentOfCommit } from '~/lib/cloudflare/data/project-deployments.server';
import { cancelOlderPublishes, memberIdentity, workersBuildOfCommit } from './runtime-projects';
import { findAccessibleProject, recordMainPush } from '~/lib/cloudflare/data/org-projects.server';
import {
  SHARED_MERGE,
  SHARED_PREVIEW,
  sharedChangesAnswerSchema,
  suggestedBranch,
  sharedMergeAnswerSchema,
  type SharedMergeAnswer,
} from '~/lib/.server/cloudflare/shared-project';
import { answeringOrganizationErrors } from './signed-in';

/**
 * The showcase's routes (docs/proposals/showcase-and-feed.md): what a page shows a signed-in person differently,
 * following, likes, comments, reports, an author's controls on their post, notifications, copies
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
 * who they are, which of its posts they liked and manage, whether they follow the person whose page or post it is,
 * and whether they follow anyone at all. A visitor gets `signedIn: false`.
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
    const [posts, following, followsSomeone, unread] = await Promise.all([
      viewerStateOfPosts(env.DB, session.user.id, postIds),
      person.success && person.data !== session.user.username
        ? followsPerson(env.DB, session.user.id, person.data)
        : Promise.resolve(null),
      followsAnyone(env.DB, session.user.id),
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
      followsAnyone: followsSomeone,
      unread,
    });
  });

/**
 * `GET /api/showcase/explore?before=&beforeId=`: the next page of Explore, for anyone. With `following=1`, only the
 * posts of the people the signed-in person follows.
 */
export const explorePageAction: Handler = async ({ request, env }) => {
  const url = new URL(request.url);
  if (url.searchParams.get('following') !== '1') {
    return json(await listExplorePosts(env.DB, cursorFrom(url)));
  }
  return signedInShowcase(request, env, async ({ session }) =>
    json(await listFollowedPosts(env.DB, session.user.id, cursorFrom(url))),
  );
};

/** `GET /api/showcase/person?username=&before=&beforeId=`: the next page of a person's posts, for anyone. */
export const personPageAction: Handler = async ({ request, env }) => {
  const url = new URL(request.url);
  const username = USERNAME.safeParse(url.searchParams.get('username'));
  return username.success
    ? json(await listPersonPosts(env.DB, username.data, cursorFrom(url)))
    : json({ error: 'Name a person.' }, 400);
};

/**
 * For someone who can edit the project, reading its threads: the previews Workers Builds has built of the changes
 * offered there, whose addresses only it knows, are asked for and kept, so each thread links its own. Nothing a page
 * view should fail on.
 */
async function findOfferedPreviews(env: Env, postId: string, userId: string): Promise<void> {
  try {
    const awaiting = await offeredChangesAwaitingPreview(env.DB, postId);
    const project = awaiting[0] ? await findAccessibleProject(env.DB, awaiting[0].projectId, userId) : null;
    if (project?.role !== 'edit') {
      return;
    }
    for (const change of awaiting) {
      const build = await workersBuildOfCommit(env, project, change.commit);
      if (build?.previewUrl) {
        await recordOfferedPreview(env.DB, change.threadId, build.previewUrl);
      }
    }
  } catch {
    console.warn({ event: 'offered_previews_not_found' });
  }
}

/** `GET /api/showcase/threads?postId=`: a post's comment threads, for anyone who may see it. */
export const threadsAction: Handler = ({ request, env }) =>
  answering(async () => {
    const postId = ID.safeParse(new URL(request.url).searchParams.get('postId'));
    if (!postId.success) {
      return json({ error: 'Name a post.' }, 400);
    }
    const session = await getAuthSession(env, request);
    if (session) {
      await findOfferedPreviews(env, postId.data, session.user.id);
    }
    return json(await listThreads(env.DB, postId.data, session?.user.id ?? null));
  });

/** `GET /api/showcase/open-threads?projectIds=a,b`: how many open threads each project's post has, for its card. */
export const openThreadsAction: Handler = ({ request, env }) =>
  answering(async () => {
    const ids = (new URL(request.url).searchParams.get('projectIds') ?? '').split(',').filter(Boolean);
    const parsed = z.array(z.string().min(1).max(64)).max(200).safeParse(ids);
    if (!parsed.success) {
      return json({ error: 'Name up to 200 projects.' }, 400);
    }
    return json({ open: await openThreadsOfProjects(env.DB, parsed.data) });
  });

/** A refusing site is asked again at most this often for a post, in this isolate, so a page view rarely waits on it. */
const RECHECK_INTERVAL_MS = 10 * 60_000;
const rechecked = new Map<string, number>();

function recheckDue(postId: string, now = Date.now()): boolean {
  const last = rechecked.get(postId);
  if (last !== undefined && now - last < RECHECK_INTERVAL_MS) {
    return false;
  }
  if (rechecked.size > 1_000) {
    rechecked.clear();
  }
  rechecked.set(postId, now);
  return true;
}

/**
 * `GET /api/showcase/post?owner=&slug=`: the post at a project's address as the signed-in person sees it, a private
 * project's among them when they may view it. The page itself is rendered the same for everyone, from public posts
 * only; the browser asks this when that found none.
 */
export const postByAddressAction: Handler = ({ request, env }) =>
  answering(async () => {
    const url = new URL(request.url);
    const owner = USERNAME.safeParse(url.searchParams.get('owner'));
    const slug = z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .safeParse(url.searchParams.get('slug'));
    if (!owner.success || !slug.success) {
      return json({ error: 'Name a project.' }, 400);
    }
    const session = await getAuthSession(env, request);
    const found = session ? await findPostByAddress(env.DB, owner.data, slug.data, session.user.id) : null;
    if (!found?.project) {
      return json({ error: 'Not found.' }, 404);
    }
    // A private project's post has no picture to fall back on, and its site is checked only at a publish: one recorded
    // as refusing is asked again here, so a fix made since shows the working app at once.
    if (found.post && !found.post.siteFrameable && !found.project.isPublic && recheckDue(found.post.id)) {
      await recordRunsInPost(env.DB, { postId: found.post.id, siteUrl: found.post.siteUrl });
      const again = await findPostByAddress(env.DB, owner.data, slug.data, session!.user.id);
      return json(again.project ? again : found);
    }
    return json(found);
  });

/** `GET /api/showcase/threads/replies?threadId=`: every reply in a thread. */
export const repliesAction: Handler = ({ request, env }) =>
  answering(async () => {
    const threadId = ID.safeParse(new URL(request.url).searchParams.get('threadId'));
    if (!threadId.success) {
      return json({ error: 'Name a thread.' }, 400);
    }
    return json({ replies: await listReplies(env.DB, threadId.data) });
  });

/** `GET /api/showcase/post-copies?postId=`: a post's public copies, and the signed-in person's own they could suggest from. */
export const copiesAction: Handler = ({ request, env }) =>
  answering(async () => {
    const postId = ID.safeParse(new URL(request.url).searchParams.get('postId'));
    if (!postId.success) {
      return json({ error: 'Name a post.' }, 400);
    }
    const session = await getAuthSession(env, request);
    return json({
      copies: await listCopies(env.DB, postId.data, session?.user.id ?? null),
      own: session ? await listOwnSuggestableCopies(env.DB, { userId: session.user.id, postId: postId.data }) : [],
    });
  });

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

const commentSchema = z.union([
  z.strictObject({ postId: ID, body: z.string().max(COMMENT_MAX * 2), suggestFrom: ID.optional() }),
  z.strictObject({ threadId: ID, body: z.string().max(COMMENT_MAX * 2) }),
]);

/**
 * `POST /api/showcase/comments/add`: a new thread on a post (`postId`, or a suggestion from a copy with
 * `suggestFrom`), or a reply in one (`threadId`). A comment that mentions `@cloudchef` starts CloudChef's answer,
 * in the writer's own space.
 */
export const addCommentAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, commentSchema, 'Write a comment.', 8_192);
    if ('response' in body) {
      return body.response;
    }
    const userId = session.user.id;
    if ('threadId' in body.data) {
      const comment = await addReply(env.DB, { userId, threadId: body.data.threadId, body: body.data.body });
      const working = mentionsCloudChef(comment.body)
        ? await answerMention(env, { request, session, threadId: body.data.threadId, commentId: comment.id })
        : null;
      return json({ comment, mention: working }, 201);
    }
    const thread = await startThread(env.DB, {
      userId,
      postId: body.data.postId,
      body: body.data.body,
      suggestFrom: body.data.suggestFrom,
    });
    const working = mentionsCloudChef(thread.first.body)
      ? await answerMention(env, { request, session, threadId: thread.id, commentId: thread.id })
      : null;
    return json({ thread, mention: working }, 201);
  });

const threadStateSchema = z.discriminatedUnion('action', [
  z.strictObject({
    threadId: ID,
    action: z.literal('close'),
    reason: z.enum(['changed', 'not_planned', 'duplicate']),
    sameAs: z.number().int().positive().nullable().default(null),
  }),
  z.strictObject({ threadId: ID, action: z.literal('reopen') }),
  z.strictObject({ threadId: ID, action: z.literal('lock'), locked: z.boolean() }),
  z.strictObject({ threadId: ID, action: z.literal('pin'), pinned: z.boolean() }),
  z.strictObject({ threadId: ID, action: z.literal('follow'), follow: z.boolean() }),
]);

/** `POST /api/showcase/threads/state`: close, open again, lock, pin, or follow a thread. */
export const threadStateAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, threadStateSchema, 'Name the thread and what to do.');
    if ('response' in body) {
      return body.response;
    }
    const userId = session.user.id;
    const change = body.data;
    switch (change.action) {
      case 'close': {
        const thread = await closeThread(env.DB, { userId, ...change });
        await removeOfferedPreviewBranch(request, env, { threadId: thread.id, userId });
        return json({ thread });
      }
      case 'reopen':
        return json({ thread: await reopenThread(env.DB, { userId, threadId: change.threadId }) });
      case 'lock':
        return json({ thread: await setThreadLocked(env.DB, { userId, ...change }) });
      case 'pin':
        return json({ thread: await setThreadPinned(env.DB, { userId, ...change }) });
      case 'follow':
        return json(await setThreadFollowing(env.DB, { userId, ...change }));
    }
  });

/** How long the project's account has to answer about an offered change, or bring it in. */
const OFFERED_CHANGE_TIMEOUT_MS = 60_000;

/**
 * Asks a runtime in the project's account about the change a thread offers, as `userId` who can edit the project: what
 * it would change (`changes`), or to bring it into main (`merge`). The repository never leaves that account.
 */
async function askProjectAccount(
  request: Request,
  env: Env,
  args: {
    projectId: string;
    userId: string;
    op: 'changes' | typeof SHARED_MERGE | typeof SHARED_PREVIEW;
    commit: string;
    body?: unknown;
  },
): Promise<Response> {
  const project = await findAccessibleProject(env.DB, args.projectId, args.userId);
  if (!project || project.role !== 'edit') {
    throw new ShowcaseError('Only the people who make this app can do that.', 403);
  }
  const url = new URL('/api/showcase/threads/change', request.url);
  url.search = new URLSearchParams({ commit: args.commit }).toString();
  const asked = new Request(url, {
    method: args.body === undefined ? 'GET' : 'POST',
    body: args.body === undefined ? null : JSON.stringify(args.body),
    signal: AbortSignal.timeout(OFFERED_CHANGE_TIMEOUT_MS),
  });
  try {
    return await forwardToProjectAccount(asked, env, {
      project: { id: project.id, connectionId: project.connectionId },
      userId: args.userId,
      role: 'edit',
      op: args.op,
      workspace: 'offered-change',
    });
  } catch {
    throw new ShowcaseError('The project couldn’t be reached just now. Try again.', 409);
  }
}

/**
 * A closed thread that offered a change has no more use for the branch its preview was built from: it is removed from
 * the project's repository, by whoever closed the thread (someone who can edit the project, or who offered the
 * change). A branch that can't be removed now only stays listed. An accepted change's is removed by the merge.
 */
async function removeOfferedPreviewBranch(
  request: Request,
  env: Env,
  args: { threadId: string; userId: string },
): Promise<void> {
  try {
    const offered = await offeredChangeNumber(env.DB, args.threadId);
    const project = offered ? await findAccessibleProject(env.DB, offered.projectId, args.userId) : null;
    if (!offered || !project) {
      return;
    }
    const asked = new Request(new URL('/api/showcase/threads/state', request.url), {
      method: 'POST',
      body: JSON.stringify({ commit: null, branch: suggestedBranch(offered.number) }),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = await forwardToProjectAccount(asked, env, {
      project: { id: project.id, connectionId: project.connectionId },
      userId: args.userId,
      role: project.role === 'edit' ? 'edit' : 'view',
      op: SHARED_PREVIEW,
      workspace: 'offered-change',
    });
    await answer.body?.cancel();
  } catch {
    console.warn({ event: 'offered_change_branch_not_removed' });
  }
}

const threadIdSchema = z.strictObject({ threadId: ID });

/** The most files of an offered change named before the rest are counted. */
const OFFERED_FILES_SHOWN = 12;

/**
 * `POST /api/showcase/threads/change`: someone who can edit the project looks at the change a thread offers, before
 * deciding. Answers whether it still fits and, as detail, the files it changes, and whether its preview is ready to
 * try; one that wasn't started when the change was offered is started now.
 */
export const offeredChangeAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const asked = await readJsonRequest(request, threadIdSchema, 'Name the thread.');
    if ('response' in asked) {
      return asked.response;
    }
    const threadId = { data: asked.data.threadId };
    const change = await offeredChange(env.DB, { threadId: threadId.data, userId: session.user.id });
    const answer = await askProjectAccount(request, env, {
      projectId: change.projectId,
      userId: session.user.id,
      op: 'changes',
      commit: change.commit,
    });
    const read = answer.ok ? sharedChangesAnswerSchema.safeParse(await answer.json().catch(() => null)) : null;
    if (!read?.success) {
      await answer.body?.cancel().catch(() => undefined);
      return json({ error: 'The change couldn’t be read just now. Try again.' }, 503);
    }
    const { state, changed, conflicts } = read.data;
    // What pressing Accept would do, or why it can't be brought in, in the words Accept itself would answer with.
    const note =
      state === 'ready'
        ? 'Accepting puts this into the project and publishes it.'
        : notMerged(
            state === 'conflict' ? { status: 'conflict', files: conflicts } : { status: state },
            change.offeredBy,
          );
    // Its preview, the way to try it before deciding: started now if it wasn't, on a branch of its own. A project
    // CloudChef deploys itself has it among its deployments; Workers Builds is asked about one it deploys, and the
    // address it gives is kept for the thread to link.
    const project = await findAccessibleProject(env.DB, change.projectId, session.user.id);
    let built: 'none' | 'building' | 'succeeded' | 'failed' | 'unknown' = 'none';
    if (project?.deploysWith === 'workers_builds') {
      const build = await workersBuildOfCommit(env, project, change.commit);
      built = !build
        ? 'unknown'
        : build.state === 'queued'
          ? 'building'
          : build.state === 'cancelled'
            ? 'none'
            : build.state === 'succeeded' && !build.previewUrl
              ? 'unknown'
              : build.state;
      if (build?.previewUrl) {
        await recordOfferedPreview(env.DB, change.threadId, build.previewUrl);
      }
    } else {
      const preview = await deploymentOfCommit(env.DB, { projectId: change.projectId, commit: change.commit });
      built =
        preview?.kind !== 'preview'
          ? 'none'
          : preview.state === 'succeeded' || preview.state === 'failed'
            ? preview.state
            : preview.state === 'queued' || preview.state === 'building' || preview.state === 'deploying'
              ? 'building'
              : 'unknown';
    }
    if (state === 'ready' && built === 'none') {
      const started = await askProjectAccount(request, env, {
        projectId: change.projectId,
        userId: session.user.id,
        op: SHARED_PREVIEW,
        commit: change.commit,
        body: { commit: change.commit, branch: suggestedBranch(change.number) },
      }).then(
        async (kicked) => {
          await kicked.body?.cancel();
          return kicked.ok;
        },
        () => false,
      );
      built = started ? 'building' : 'unknown';
    }
    const trying =
      built === 'succeeded'
        ? 'Try it first: close this and use Try it on the thread (reload the page if it isn’t there yet). '
        : built === 'failed'
          ? 'Its preview couldn’t be built, so it can’t be tried first. '
          : built === 'building'
            ? 'Its preview is being built: open this again in a minute or two for the link to try it. '
            : '';
    const more = changed.length - OFFERED_FILES_SHOWN;
    return json({
      acceptable: state === 'ready' || state === 'already',
      changed: changed.slice(0, OFFERED_FILES_SHOWN),
      note: `${more > 0 ? `And ${more} more ${more === 1 ? 'file' : 'files'}. ` : ''}${state === 'ready' ? trying : ''}${note}`,
    });
  });

/** Why an accepted change wasn't brought in, for the person who pressed Accept. */
function notMerged(answer: Exclude<SharedMergeAnswer, { status: 'merged' }>, offeredBy: string): string {
  switch (answer.status) {
    case 'conflict': {
      const files = answer.files.slice(0, 5).join(', ');
      const more = answer.files.length > 5 ? ` and ${answer.files.length - 5} more` : '';
      return `This change no longer fits: the project has since changed ${files}${more} too. Ask ${offeredBy} to bring their change up to date and offer it again.`;
    }
    case 'missing':
      return `The change is no longer kept: ${offeredBy} removed it, or the workspace they made it in. Ask them to offer it again.`;
    case 'unrelated':
      return 'This change wasn’t made on this project’s versions, so it can’t be brought in.';
    case 'secrets':
      return 'This change holds a file of secrets (such as .env), so it wasn’t brought in.';
    case 'moved':
      return 'The project changed while this was brought in. Try again.';
    case 'already':
      return 'The project already has this change.';
  }
}

/**
 * `POST /api/showcase/threads/accept`: someone who can edit the project accepts the change a thread offers. A runtime
 * in the project's account brings its commit into main (`mergeIntoMain`), which is published as any push of main is;
 * the push is recorded as the accepter's, and the thread is on its way until that version is live.
 */
export const acceptChangeAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, threadIdSchema, 'Name the thread.');
    if ('response' in body) {
      return body.response;
    }
    const userId = session.user.id;
    const change = await offeredChange(env.DB, { threadId: body.data.threadId, userId });
    const author = await memberIdentity(env.DB, userId);
    if (!author) {
      return json({ error: 'Your account has no email to make the change in your name.' }, 409);
    }
    const answer = await askProjectAccount(request, env, {
      projectId: change.projectId,
      userId,
      op: SHARED_MERGE,
      commit: change.commit,
      body: {
        branch: suggestedBranch(change.number),
        commit: change.commit,
        message: `Accept ${change.offeredBy}'s change (#${change.number})`,
        author,
      },
    });
    const merged = answer.ok ? sharedMergeAnswerSchema.safeParse(await answer.json().catch(() => null)) : null;
    if (!merged?.success) {
      await answer.body?.cancel().catch(() => undefined);
      return json({ error: 'The change couldn’t be brought in just now. Try again.' }, 503);
    }
    if (merged.data.status !== 'merged' && merged.data.status !== 'already') {
      return json({ error: notMerged(merged.data, change.offeredBy) }, 409);
    }
    let fixCommit = change.commit;
    if (merged.data.status === 'merged') {
      fixCommit = merged.data.to;
      await recordMainPush(env.DB, {
        projectId: change.projectId,
        userId,
        oldCommit: merged.data.from,
        newCommit: merged.data.to,
        pushedAt: Date.now(),
      });
      const project = await findAccessibleProject(env.DB, change.projectId, userId);
      if (project?.deploysWith === 'workers_builds') {
        await cancelOlderPublishes({ request, env }, project, merged.data.to, userId);
      }
    }
    await markThreadOnItsWay(env.DB, { userId, threadId: change.threadId, fixCommit });
    return json({ thread: await findThread(env.DB, change.threadId, userId) });
  });

const commentIdSchema = z.strictObject({ commentId: ID });

/** `POST /api/showcase/comments/delete`: by the person who wrote it, or who makes the app. */
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

/** `POST /api/showcase/posts/clip/remove`: "Remove clip", which leaves the post with its screenshot. */
export const removeReelAction: Handler = ({ request, env }) =>
  signedInShowcase(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, postIdSchema, 'Name the post.');
    if ('response' in body) {
      return body.response;
    }
    await removeReel(env.DB, { userId: session.user.id, postId: body.data.postId });
    await deleteGoneMediaBestEffort(env);
    return json({ removed: true });
  });

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
    return id.success ? serveMediaForReview(env, id.data) : json({ error: 'Name a picture.' }, 400);
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
