import { z } from 'zod';
import { findAccessibleProject, findReadableProject } from '~/lib/cloudflare/data/org-projects.server';
import { ShowcaseError } from '~/lib/cloudflare/data/posts.server';
import {
  addAgentReply,
  canEditProject,
  closeThread,
  findThreadByNumber,
  listReplies,
  listThreads,
  markThreadOnItsWay,
  offerChange,
  openThreadCount,
  postOfProject,
} from '~/lib/cloudflare/data/post-threads.server';
import { chatMayCloseThread, endThreadRun } from '~/lib/cloudflare/data/thread-runs.server';
import type { PostComment, PostThread } from '~/lib/showcase';
import {
  commentsRequestSchema,
  COULD_NOT_FINISH,
  suggestRequestSchema,
  type CommentsListAnswer,
  type CommentsShowAnswer,
  type CommentsThreadSummary,
} from '~/lib/thread-comments';
import { readAuthenticatedRuntimeRequest } from './runtime-authentication';

/**
 * `cloudchef comments` from a workspace runtime (docs/proposals/comment-threads.md): the threads on the public post of
 * the project the workspace works on, or reads. Nothing the runtime says is trusted: who may read or close is checked
 * here, from the person's role on the project and their mention runs (`thread_runs`).
 */

const MAX_REQUEST_BYTES = 8 * 1024;
const NO_POST = 'This project has no post yet (it gets one when it is published), so it has no comment threads.';

function json<Answer>(body: Answer, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function summary(thread: PostThread): CommentsThreadSummary {
  return {
    number: thread.number,
    kind: thread.kind,
    state: thread.state,
    by: thread.first.author.username,
    at: thread.first.createdAt,
    body: thread.first.body,
    replies: thread.replyCount,
    earlierVersion: thread.onEarlierVersion,
  };
}

function reply(comment: PostComment) {
  return { by: comment.author.username, at: comment.createdAt, body: comment.body, byAgent: comment.byAgent };
}

/** `POST /api/cloudflare/runtime-projects/comments`: list, show, or close a thread of the project's post. */
export async function runtimeCommentsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(env, request, commentsRequestSchema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Comments request',
    invalid: 'Invalid comments request.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity } = authenticated;
  const userId = identity.userId;
  // Threads are on public posts only, which anyone signed in may read: a project they may read, then.
  const project = await findReadableProject(env.DB, { id: body.orgProjectId }, userId);
  const post = project ? await postOfProject(env.DB, project.id) : null;
  if (!project || !post) {
    return json({ error: NO_POST }, 409);
  }
  if (body.op === 'list') {
    const { threads } = await listThreads(env.DB, post.id, userId);
    const answer: CommentsListAnswer = {
      post: post.path,
      open: await openThreadCount(env.DB, post.id),
      threads: threads.filter((thread) => thread.state !== 'closed').map(summary),
      runsInPost: project.siteFrameable,
      isPrivate: !post.isPublic,
    };
    return json(answer);
  }
  const thread = await findThreadByNumber(env.DB, { projectId: project.id, number: body.number, viewerId: userId });
  if (!thread) {
    return json({ error: `There is no thread #${body.number} on ${post.path}.` }, 404);
  }
  if (body.op === 'show') {
    const answer: CommentsShowAnswer = {
      post: post.path,
      thread: {
        ...summary(thread),
        closeReason: thread.closeReason,
        sameAs: thread.sameAs,
        locked: thread.locked,
        suggestion: thread.suggestion
          ? { name: thread.suggestion.name, path: thread.suggestion.path, ownChange: thread.suggestion.ownChange }
          : null,
      },
      replies: (await listReplies(env.DB, thread.id)).map(reply),
    };
    return json(answer);
  }
  // Closing: only the agent, in a full run a mention in this very thread started, and only while that turn runs.
  if (
    !(await canEditProject(env.DB, project.id, userId)) ||
    !(await chatMayCloseThread(env.DB, { threadId: thread.id, userId, chatId: body.chatId }))
  ) {
    return json(
      {
        error: `Only a chat that a @cloudchef mention in thread #${thread.number} started, by someone who can change the project, closes it, while answering that mention.`,
      },
      403,
    );
  }
  try {
    if (body.reason === 'changed') {
      if (!body.fixCommit) {
        return json({ error: 'The project has no saved version yet to wait for.' }, 409);
      }
      const state = await markThreadOnItsWay(env.DB, { userId, threadId: thread.id, fixCommit: body.fixCommit });
      return json({ state });
    }
    const closed = await closeThread(env.DB, {
      userId,
      threadId: thread.id,
      reason: body.reason,
      sameAs: body.sameAs ?? null,
    });
    return json({ state: closed.state });
  } catch (error) {
    if (error instanceof ShowcaseError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
}

const answeredSchema = z.strictObject({
  threadId: z.string().uuid(),
  commentId: z.string().uuid(),
  chatId: z.string().min(1).max(512),
  /** `answered` posts `text`; `failed` posts that CloudChef couldn't finish, with `text` as the reason; `stopped` nothing. */
  outcome: z.enum(['answered', 'failed', 'stopped']),
  text: z.string().max(64 * 1024),
});

/**
 * `POST /api/cloudflare/runtime-projects/comments/answered`: a mention turn ended in the person's chat. Its final
 * message is posted as CloudChef's reply in the thread, for the person whose mention started it, only when that turn
 * was the one running for them in that chat; a stopped turn posts nothing.
 */
export async function runtimeCommentsAnsweredAction({
  request,
  env,
}: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(env, request, answeredSchema, {
    maxBytes: 80 * 1024,
    label: 'Mention answer',
    invalid: 'Invalid mention answer.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity } = authenticated;
  const ended = await endThreadRun(env.DB, {
    threadId: body.threadId,
    userId: identity.userId,
    commentId: body.commentId,
    chatId: body.chatId,
  });
  if (!ended || body.outcome === 'stopped') {
    return json({ posted: false });
  }
  const text = body.outcome === 'answered' ? body.text : COULD_NOT_FINISH;
  const posted = await addAgentReply(env.DB, { threadId: body.threadId, askerId: identity.userId, body: text });
  return json({ posted: posted !== null });
}

/**
 * `POST /api/cloudflare/runtime-projects/suggest`: `cloudchef suggest` from a workspace on a project the person may
 * see but, usually, not change. Their commit, which their workspace saved in the project's repository, is offered on
 * the project's post as a suggestion thread, for the people who can change the project to accept or decline; an offer
 * of theirs still open takes the new commit instead. Whether the repository holds the commit is found when it is
 * looked at or accepted, in the project's account.
 */
export async function runtimeSuggestAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const authenticated = await readAuthenticatedRuntimeRequest(env, request, suggestRequestSchema, {
    maxBytes: MAX_REQUEST_BYTES,
    label: 'Suggestion',
    invalid: 'Invalid suggestion.',
  });
  if (authenticated instanceof Response) {
    return authenticated;
  }
  const { body, identity } = authenticated;
  // Someone the project is theirs, their team's or shared with: only their workspaces save commits in it.
  const project = await findAccessibleProject(env.DB, body.orgProjectId, identity.userId);
  const post = project ? await postOfProject(env.DB, project.id) : null;
  if (!project || !post) {
    return json(
      {
        error:
          'This project has no post yet (it gets one when it is published), so there is nowhere to offer a change. Tell the people who make it another way.',
      },
      409,
    );
  }
  try {
    const offered = await offerChange(env.DB, {
      userId: identity.userId,
      postId: post.id,
      body: body.message,
      commit: body.commit,
    });
    return json({ post: post.path, ...offered });
  } catch (error) {
    if (error instanceof ShowcaseError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
}
