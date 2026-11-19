import { z } from 'zod';
import { mentionThreadSchema, questionSourceSchema } from '../../app/agents/builder-mentions';
import { readJsonBodyWithLimit } from '../../app/lib/bounded-body';
import { requireConversation, transcriptIdentity } from '../../app/lib/cloudflare/data/conversation-repository.server';
import {
  ensureInitialWorkspace,
  findWorkspace,
  openLinkedWorkspace,
} from '../../app/lib/cloudflare/data/workspace-repository.server';
import { setDescription } from '../../app/lib/cloudflare/data/workspace-service.server';
import { MAX_USER_MESSAGE_CHARACTERS } from '../../cloudchef-agent/context-limits';

const MAX_REQUEST_BYTES = 64 * 1024;

const mentionRequestSchema = z.discriminatedUnion('access', [
  z.strictObject({
    access: z.literal('edit'),
    /** The project the chat is on; its chat is the one the person already has for it, made the first time. */
    orgProjectId: z.string().uuid(),
    chatId: z.string().uuid(),
    commentId: z.string().uuid(),
    title: z.string().min(1).max(200),
    text: z.string().min(1).max(MAX_USER_MESSAGE_CHARACTERS),
    thread: mentionThreadSchema,
  }),
  z.strictObject({
    access: z.literal('read'),
    /** The read-only chat for this thread, made with this id the first time. */
    chatId: z.string().uuid(),
    commentId: z.string().uuid(),
    title: z.string().min(1).max(200),
    text: z.string().min(1).max(MAX_USER_MESSAGE_CHARACTERS),
    thread: mentionThreadSchema,
    question: questionSourceSchema,
  }),
]);

/**
 * `POST /v1/mentions/start` (docs/proposals/comment-threads.md): CloudChef starts the turn a `@cloudchef` mention asks
 * for, in this person's own runtime, as the browser opens a chat and sends a first message. With edit access it is the
 * project's chat; otherwise a read-only chat named after the thread, seeded from the post's project at its live
 * commit and tied to no project. The turn goes to the chat's newest conversation. Answers the chat it went to, and
 * whether it started or waits its turn behind what the chat is doing now.
 */
export async function userRuntimeMentionStartAction(args: {
  request: Request;
  env: Env;
  userId: string;
}): Promise<Response> {
  const { env, userId } = args;
  const parsed = mentionRequestSchema.safeParse(
    await readJsonBodyWithLimit(args.request, MAX_REQUEST_BYTES, 'Mention').catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: 'Invalid mention.' }, { status: 400 });
  }
  const body = parsed.data;
  let chatId: string;
  if (body.access === 'edit') {
    chatId = (
      await openLinkedWorkspace(env.DB, { sessionId: userId, id: body.chatId, orgProjectId: body.orgProjectId })
    ).initialId;
  } else {
    chatId = body.chatId;
    if (!(await findWorkspace(env.DB, { id: chatId, sessionId: userId }))) {
      await ensureInitialWorkspace(env.DB, { id: crypto.randomUUID(), creatorId: userId, initialId: chatId });
      await setDescription(env.DB, { sessionId: userId, id: chatId, description: body.title });
    }
  }
  const workspace = await findWorkspace(env.DB, { id: chatId, sessionId: userId });
  if (!workspace) {
    return Response.json({ error: 'The chat could not be opened.' }, { status: 409 });
  }
  const conversation = transcriptIdentity(
    await requireConversation(env.DB, {
      workspaceId: workspace.id,
      conversationIndex: workspace.last_conversation_index,
    }),
  );
  try {
    const started = await env.ConversationAgent.getByName(conversation.agentName).startMentionTurn({
      ownerId: userId,
      text: body.text,
      commentId: body.commentId,
      thread: body.thread,
      question: body.access === 'read' ? body.question : undefined,
    });
    return Response.json({ status: started.status, chatId });
  } catch (error) {
    // Why it couldn't start, in the words the agent gave the person.
    const said = error instanceof Error ? error.message.slice(0, 500) : '';
    return Response.json({ error: said || 'The turn couldn’t start.', chatId }, { status: 409 });
  }
}
