import { z } from 'zod';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';

/**
 * `@cloudchef` in a comment thread (docs/proposals/comment-threads.md), as the asker's conversation keeps it. The
 * control plane starts a turn here without the browser (`startMentionTurn`), through the runtime's
 * `/v1/mentions/start`; when that turn ends, its final message is the reply posted in the thread. Turns the person
 * types in the chat themselves post nothing.
 */

const COMMIT = z.string().regex(/^[0-9a-f]{40}$/);
const POST_PATH = z.string().regex(/^\/[a-z0-9-]{1,39}\/[a-z0-9-]{1,64}$/);

/** The thread a chat answers mentions in: kept for the chat's environment, and to report each mention's answer. */
export const mentionThreadSchema = z.strictObject({
  threadId: z.string().uuid(),
  number: z.number().int().min(1),
  /** The post's path, `/<owner>/<slug>`. */
  post: POST_PATH,
  /** `edit`: a full run on the project; `read`: a read-only run. */
  access: z.enum(['edit', 'read']),
});
export type MentionThread = z.infer<typeof mentionThreadSchema>;

/** What a read-only chat's workspace is seeded from: a public project's post, at the commit live then. */
export const questionSourceSchema = z.strictObject({
  projectId: z.string().uuid(),
  commit: COMMIT,
  post: POST_PATH,
});
export type QuestionSource = z.infer<typeof questionSourceSchema>;

/** What the runtime's `/v1/mentions/start` hands the conversation: who asks, the message, the thread. */
export const mentionStartSchema = z.strictObject({
  ownerId: z.string().min(1).max(128),
  text: z.string().min(1).max(MAX_USER_MESSAGE_CHARACTERS),
  commentId: z.string().uuid(),
  thread: mentionThreadSchema,
  question: questionSourceSchema.optional(),
});
export type MentionStart = z.infer<typeof mentionStartSchema>;

/** The turn a mention started, until its answer is reported. */
const pendingMentionSchema = z.strictObject({
  threadId: z.string().uuid(),
  commentId: z.string().uuid(),
  chatId: z.string().min(1),
  /** Once the turn ended: what to post (`answered` its final message, `failed` why), kept until CloudChef has it. */
  outcome: z.enum(['answered', 'failed', 'stopped']).optional(),
  text: z.string().optional(),
});
export type PendingMention = z.infer<typeof pendingMentionSchema>;

/** A mention turn's request id, so its end is known as that mention's. */
export function mentionRequestId(commentId: string): string {
  return `mention:${commentId}`;
}

const KEYS = {
  thread: 'cloudchef.mention.thread',
  question: 'cloudchef.mention.question',
  pending: 'cloudchef.mention.pending',
};

/** What the store keeps; each is parsed again when read. */
type Stored = MentionThread | QuestionSource | PendingMention;
/** The agent's `ctx.storage.kv`, as much of it as the store uses. */
type Kv = {
  get(key: string): Stored | undefined;
  put(key: string, value: Stored): void;
  delete(key: string): boolean;
};

/** The conversation's mention facts, in the agent's own storage. */
export class BuilderMentionStore {
  constructor(private readonly kv: Kv) {}

  thread(): MentionThread | null {
    return mentionThreadSchema.safeParse(this.kv.get(KEYS.thread)).data ?? null;
  }

  setThread(thread: MentionThread): void {
    this.kv.put(KEYS.thread, thread);
  }

  /** A read-only chat's source; null in a chat on a project. */
  question(): QuestionSource | null {
    return questionSourceSchema.safeParse(this.kv.get(KEYS.question)).data ?? null;
  }

  setQuestion(question: QuestionSource): void {
    this.kv.put(KEYS.question, question);
  }

  pending(): PendingMention | null {
    return pendingMentionSchema.safeParse(this.kv.get(KEYS.pending)).data ?? null;
  }

  setPending(pending: PendingMention): void {
    this.kv.put(KEYS.pending, pending);
  }

  clearPending(commentId: string): void {
    if (this.pending()?.commentId === commentId) {
      this.kv.delete(KEYS.pending);
    }
  }
}

/**
 * The final message of a turn, as the reply in the thread: the text the newest assistant message ends with, after
 * its last tool call; the whole message's text when it ends with a tool call.
 */
export function finalAssistantText(messages: readonly CloudChefMessage[]): string {
  const last = messages.findLast((message) => message.role === 'assistant');
  if (!last) {
    return '';
  }
  const texts: string[] = [];
  for (const part of last.parts) {
    if (part.type === 'text' && part.text !== undefined) {
      texts.push(part.text);
    } else if (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) {
      // A tool call: what came before it was said on the way.
      texts.length = 0;
    }
  }
  const tail = texts.join('').trim();
  if (tail) {
    return tail;
  }
  return last.parts
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('')
    .trim();
}
