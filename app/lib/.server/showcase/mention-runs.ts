import { z } from 'zod';
import type { CloudflareAuthSession } from '~/lib/.server/auth';
import { publicOrigin } from '~/lib/.server/public-origin';
import { findReadableProject } from '~/lib/cloudflare/data/org-projects.server';
import { findPublicPostFacts, type PublicPostFacts } from '~/lib/cloudflare/data/posts.server';
import { addAgentReply, findThread, listReplies } from '~/lib/cloudflare/data/post-threads.server';
import { claimThreadRun, endThreadRun, setThreadRunChat } from '~/lib/cloudflare/data/thread-runs.server';
import type { PostComment, PostThread } from '~/lib/showcase';
import { runtimeFor } from '~/server-handlers/command-line';
import { couldNotFinish } from '~/lib/thread-comments';

/** What the comment box is told after a comment that mentions `@cloudchef`. */
export type MentionAnswer =
  | { status: 'working' }
  | { status: 'no_space'; message: string }
  | { status: 'busy'; message: string }
  | { status: 'failed'; message: string };

const BUSY = 'CloudChef is still working on your last request here. Ask again once it has replied.';
/** How long the person's runtime is given to take the turn on. */
const START_TIMEOUT_MS = 30_000;

const startAnswerSchema = z.object({ status: z.enum(['started', 'busy']), chatId: z.string().min(1).max(512) });

/**
 * `@cloudchef` in a thread (docs/proposals/comment-threads.md): starts, or continues, the writer's chat for this
 * thread in their own space, and the turn's final message is posted as the reply to `commentId` when it ends
 * (`runtime-projects/comments/answered`). The run is always theirs: their space, their model, their usage. Someone who
 * can edit the project gets a turn in the project's own chat (for a project shared with them, from their own
 * account, as when they open it); anyone else a read-only chat seeded from the post's project at its live commit,
 * tied to no project. Their later mentions in the thread go to the same chat. Null when there's nothing to answer.
 */
export async function answerMention(
  env: Env,
  args: { request: Request; session: CloudflareAuthSession; threadId: string; commentId: string },
): Promise<MentionAnswer | null> {
  const { session, threadId, commentId } = args;
  const userId = session.user.id;
  const thread = await findThread(env.DB, threadId, userId);
  const post = thread ? await postOfThread(env.DB, threadId) : null;
  if (!thread || !post) {
    return null;
  }
  const comment =
    commentId === thread.id
      ? thread.first
      : (await listReplies(env.DB, thread.id)).find((reply) => reply.id === commentId);
  if (!comment) {
    return null;
  }
  const origin = publicOrigin(args.request);
  const project = await findReadableProject(env.DB, { id: post.projectId }, userId);
  const access = project?.role === 'edit' ? 'edit' : 'read';
  // Their space: the project's own account when they work in it, else the one they build in now.
  const connectionId =
    project && access === 'edit' && !project.shared ? project.connectionId : (session.context?.connectionId ?? null);
  if (!connectionId) {
    const message = 'Choose where to build first, then ask again.';
    await addAgentReply(env.DB, { threadId, askerId: userId, body: `${message} ${origin}/` });
    return { status: 'no_space', message };
  }
  const claim = await claimThreadRun(env.DB, {
    threadId,
    userId,
    access,
    commentId,
    newChatId: crypto.randomUUID(),
  });
  if (claim.status === 'busy') {
    return { status: 'busy', message: BUSY };
  }
  const failed = async (reason: string): Promise<MentionAnswer> => {
    if (await endThreadRun(env.DB, { threadId, userId, commentId })) {
      await addAgentReply(env.DB, { threadId, askerId: userId, body: couldNotFinish(reason) });
    }
    return { status: 'failed', message: reason };
  };
  const runtime = await runtimeFor(args.request, env, userId, connectionId);
  if ('refusal' in runtime) {
    return failed(runtime.refusal);
  }
  const mentionThread = { threadId, number: thread.number, post: post.path, access };
  const text = await mentionMessage(env.DB, {
    origin,
    post,
    thread,
    comment,
    asker: session.user.username,
  });
  const title = `#${thread.number} ${thread.first.body.replace(/\s+/g, ' ').trim()}`.slice(0, 120);
  const body =
    access === 'edit'
      ? { access, orgProjectId: post.projectId, chatId: claim.chatId, commentId, title, text, thread: mentionThread }
      : {
          access,
          chatId: claim.chatId,
          commentId,
          title,
          text,
          thread: mentionThread,
          question: { projectId: post.projectId, commit: post.commitSha, post: post.path },
        };
  let answered: unknown;
  let ok = false;
  try {
    const response = await fetch(new URL('/v1/mentions/start', runtime.endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${runtime.token}`, origin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });
    ok = response.ok;
    answered = await response.json().catch(() => null);
  } catch {
    return failed('your workspace couldn’t be reached just now');
  }
  const started = startAnswerSchema.safeParse(answered);
  if (!ok || !started.success) {
    const error = z.object({ error: z.string() }).safeParse(answered);
    return failed(error.success ? error.data.error : 'your workspace didn’t take the request');
  }
  if (started.data.status === 'busy') {
    await endThreadRun(env.DB, { threadId, userId, commentId });
    return { status: 'busy', message: BUSY };
  }
  await setThreadRunChat(env.DB, { threadId, userId, chatId: started.data.chatId });
  return { status: 'working' };
}

async function postOfThread(db: D1Database, threadId: string): Promise<PublicPostFacts | null> {
  const row = await db
    .prepare('SELECT post_id FROM post_comments WHERE id = ?')
    .bind(threadId)
    .first<{ post_id: string }>();
  return row ? findPublicPostFacts(db, row.post_id) : null;
}

function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function byline(comment: PostComment): string {
  return comment.author.username ? `@${comment.author.username}` : 'someone';
}

/**
 * The turn's first message: the thread's first comment and the comment that mentioned CloudChef; for a suggestion,
 * the copy's public git address and the commit it suggests. The rest of the thread is read with `cloudchef comments`.
 */
async function mentionMessage(
  db: D1Database,
  args: {
    origin: string;
    post: PublicPostFacts;
    thread: PostThread;
    comment: PostComment;
    asker: string | null;
  },
): Promise<string> {
  const { origin, post, thread, comment } = args;
  const lines = [
    `${args.asker ? `@${args.asker}` : 'The person'} mentioned @cloudchef in thread #${thread.number} on ${origin}${post.path}.`,
    '',
    `The thread's first comment, by ${byline(thread.first)}:`,
    quoted(thread.first.body),
  ];
  if (comment.id !== thread.first.id) {
    lines.push('', `The comment that mentioned you, by ${byline(comment)}:`, quoted(comment.body));
  }
  if (thread.kind === 'suggestion') {
    const copy = await db
      .prepare('SELECT suggested_commit FROM post_comments WHERE id = ?')
      .bind(thread.id)
      .first<{ suggested_commit: string | null }>();
    const path = thread.suggestion?.path;
    if (path) {
      lines.push(
        '',
        `This thread suggests a change from a public copy, ${thread.suggestion?.name ?? path}: its code is at ${origin}${path}.git${copy?.suggested_commit ? `, commit ${copy.suggested_commit}` : ''}, and its site at ${thread.suggestion?.siteUrl ?? 'its post'}.`,
      );
    }
  }
  lines.push('', 'Read the whole thread with `cloudchef comments show ' + String(thread.number) + '`.');
  return lines.join('\n');
}
