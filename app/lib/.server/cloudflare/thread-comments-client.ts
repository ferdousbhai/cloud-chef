import { z } from 'zod';
import type { RuntimeConnectionIdentity } from './cloudflare-api-runtime-identity';
import { postRuntimeRoute } from './user-workspace-cloudflare-credential';
import {
  commentsCloseAnswerSchema,
  commentsListAnswerSchema,
  commentsShowAnswerSchema,
  formatCommentsList,
  formatCommentsThread,
  type CommentsListAnswer,
  type CommentsRequest,
} from '~/lib/thread-comments';

/**
 * A workspace runtime's side of comment threads (docs/proposals/comment-threads.md): `cloudchef comments` asked of
 * the control plane (`runtime-projects/comments`), and a mention turn's end told to it
 * (`runtime-projects/comments/answered`).
 */

type RuntimeEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;
type Identity = Pick<RuntimeConnectionIdentity, 'userId' | 'connectionId' | 'connectionGeneration'>;

const TIMEOUT_MS = 20_000;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

/** The command's output and whether it worked, as the container prints it. */
export type CommentsOutput = { ok: boolean; text: string };

async function ask(env: RuntimeEnv, identity: Identity, request: CommentsRequest): Promise<Response> {
  return postRuntimeRoute(env, identity, 'runtime-projects/comments', request, TIMEOUT_MS);
}

/** The answer's JSON text, bounded. */
async function answerText(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_ANSWER_BYTES) {
    throw new Error('The comments answer was too large.');
  }
  return text;
}

/** `cloudchef comments`, answered: the control plane's answer as the command's output. */
export async function runCommentsRequest(
  env: RuntimeEnv,
  identity: Identity,
  request: CommentsRequest,
): Promise<CommentsOutput> {
  let text: string;
  let response: Response;
  try {
    response = await ask(env, identity, request);
    text = await answerText(response);
  } catch {
    return { ok: false, text: 'CloudChef couldn’t be reached for the comments just now. Try again.\n' };
  }
  const answered = parsedJson(text);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(answered);
    return { ok: false, text: `${error.success ? error.data.error : 'The comments couldn’t be read.'}\n` };
  }
  if (request.op === 'list') {
    const list = commentsListAnswerSchema.safeParse(answered);
    return list.success ? { ok: true, text: formatCommentsList(list.data) } : unreadable();
  }
  if (request.op === 'show') {
    const thread = commentsShowAnswerSchema.safeParse(answered);
    return thread.success ? { ok: true, text: formatCommentsThread(thread.data) } : unreadable();
  }
  const closed = commentsCloseAnswerSchema.safeParse(answered);
  if (!closed.success) {
    return unreadable();
  }
  return {
    ok: true,
    text:
      closed.data.state === 'on_its_way'
        ? `Thread #${request.number} is on its way: it closes as changed once a publish puts this version live.\n`
        : `Thread #${request.number} is closed.\n`,
  };
}

function unreadable(): CommentsOutput {
  return { ok: false, text: 'CloudChef’s answer about the comments couldn’t be read.\n' };
}

/** The project's post and its open threads, for the agent's environment; null when it has none or can't be read. */
export async function openThreads(
  env: RuntimeEnv,
  identity: Identity,
  orgProjectId: string,
): Promise<{ post: string; open: number; onItsWay: number; runsInPost: boolean | null } | null> {
  try {
    const response = await ask(env, identity, { op: 'list', orgProjectId });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const list: CommentsListAnswer = commentsListAnswerSchema.parse(parsedJson(await answerText(response)));
    return {
      post: list.post,
      open: list.open,
      onItsWay: list.threads.filter((thread) => thread.state === 'on_its_way').length,
      runsInPost: list.runsInPost ?? null,
    };
  } catch {
    return null;
  }
}

/** Tells CloudChef how a mention turn ended, for it to post the answer in the thread. Whether it was told. */
export async function reportMentionAnswer(
  env: RuntimeEnv,
  identity: Identity,
  body: {
    threadId: string;
    commentId: string;
    chatId: string;
    outcome: 'answered' | 'failed' | 'stopped';
    text: string;
  },
): Promise<boolean> {
  try {
    const response = await postRuntimeRoute(env, identity, 'runtime-projects/comments/answered', body, TIMEOUT_MS);
    await response.body?.cancel();
    // A refusal (4xx) won't change when asked again: the run was no longer waiting for this answer.
    return response.ok || (response.status >= 400 && response.status < 500);
  } catch {
    return false;
  }
}

/** JSON text as parsed, for a schema to read; null when it isn't JSON. */
function parsedJson(text: string): ReturnType<typeof JSON.parse> {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
