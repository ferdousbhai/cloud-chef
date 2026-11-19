import { z } from 'zod';

/**
 * `cloudchef comments` (docs/proposals/comment-threads.md): what the workspace runtime asks the control plane about
 * the threads on a project's public post (`runtime-projects/comments`), what it answers, and the command's output
 * as the agent or the person in their terminal reads it.
 */

/** The path `cloudchef comments` sends to on the runtime's `showcase.internal` (the same host as `cloudchef reel`). */
export const COMMENTS_PROXY_PATH = '/comments';
const COMMIT = z.string().regex(/^[0-9a-f]{40}$/);
const PROJECT = z.string().uuid();
const NUMBER = z.number().int().min(1).max(1_000_000);

/** What the container's command sends: list, show one, or close one. */
export const commentsCommandSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list') }),
  z.strictObject({ op: z.literal('show'), number: NUMBER }),
  z.strictObject({
    op: z.literal('close'),
    number: NUMBER,
    reason: z.enum(['changed', 'not_planned', 'duplicate']),
    sameAs: NUMBER.optional(),
  }),
]);
export type CommentsCommand = z.infer<typeof commentsCommandSchema>;

/** What the runtime asks the control plane: the command, for a project, and for close the chat and main's commit. */
export const commentsRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list'), orgProjectId: PROJECT }),
  z.strictObject({ op: z.literal('show'), orgProjectId: PROJECT, number: NUMBER }),
  z.strictObject({
    op: z.literal('close'),
    orgProjectId: PROJECT,
    number: NUMBER,
    reason: z.enum(['changed', 'not_planned', 'duplicate']),
    sameAs: NUMBER.optional(),
    /** The chat whose agent command asks: only a chat a mention in this thread started may close it. */
    chatId: z.string().min(1).max(512),
    /** main's commit now, for `changed`: the thread is on its way until a publish has it. */
    fixCommit: COMMIT.optional(),
  }),
]);
export type CommentsRequest = z.infer<typeof commentsRequestSchema>;

const threadSummarySchema = z.object({
  number: z.number(),
  kind: z.enum(['comment', 'suggestion']),
  state: z.enum(['open', 'on_its_way', 'closed']),
  by: z.string().nullable(),
  at: z.number(),
  body: z.string(),
  replies: z.number(),
  earlierVersion: z.boolean(),
});
export type CommentsThreadSummary = z.infer<typeof threadSummarySchema>;

export const commentsListAnswerSchema = z.object({
  post: z.string(),
  /** How many of the post's threads are open, all of them (`threads` holds the latest). */
  open: z.number(),
  threads: z.array(threadSummarySchema),
  /**
   * Whether the live site lets cloudchef.build show it running in the post, as last checked after a publish; null
   * until checked. Optional: a runtime may meet a control plane from before it was said.
   */
  runsInPost: z.boolean().nullable().optional(),
  /** The project is private: its post is seen only by the people who may view the project. */
  isPrivate: z.boolean().optional(),
});
export type CommentsListAnswer = z.infer<typeof commentsListAnswerSchema>;

export const commentsShowAnswerSchema = z.object({
  post: z.string(),
  thread: threadSummarySchema.extend({
    closeReason: z.enum(['changed', 'not_planned', 'duplicate']).nullable(),
    sameAs: z.number().nullable(),
    locked: z.boolean(),
    suggestion: z.object({ name: z.string(), path: z.string().nullable() }).nullable(),
  }),
  replies: z.array(z.object({ by: z.string().nullable(), at: z.number(), body: z.string(), byAgent: z.boolean() })),
});
export type CommentsShowAnswer = z.infer<typeof commentsShowAnswerSchema>;

export const commentsCloseAnswerSchema = z.object({ state: z.enum(['open', 'on_its_way', 'closed']) });

function when(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

function who(by: string | null): string {
  return by ? `@${by}` : 'someone no longer here';
}

function stateWords(thread: Pick<CommentsThreadSummary, 'state'>): string {
  return thread.state === 'on_its_way' ? 'on its way' : thread.state;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** `cloudchef comments`: the open and on-its-way threads, newest activity first, each with its first comment. */
export function formatCommentsList(answer: CommentsListAnswer): string {
  if (answer.threads.length === 0) {
    return `No open threads on ${answer.post}.\n`;
  }
  const lines = [`Open threads on ${answer.post}:`, ''];
  for (const thread of answer.threads) {
    const facts = [
      stateWords(thread),
      `${thread.replies} ${thread.replies === 1 ? 'reply' : 'replies'}`,
      ...(thread.kind === 'suggestion' ? ['a suggestion from a copy'] : []),
      ...(thread.earlierVersion ? ['on an earlier version'] : []),
    ];
    lines.push(
      `#${thread.number} ${who(thread.by)}, ${when(thread.at)} (${facts.join(', ')})`,
      indent(thread.body),
      '',
    );
  }
  lines.push('Read one whole with: cloudchef comments show <n>');
  return `${lines.join('\n')}\n`;
}

/** `cloudchef comments show <n>`: the thread's first comment and every reply, oldest first. */
export function formatCommentsThread(answer: CommentsShowAnswer): string {
  const { thread } = answer;
  const closed =
    thread.state === 'closed'
      ? thread.closeReason === 'duplicate'
        ? `closed as the same as #${thread.sameAs ?? '?'}`
        : thread.closeReason === 'not_planned'
          ? 'closed as not planned'
          : 'closed as changed'
      : stateWords(thread);
  const facts = [
    closed,
    ...(thread.locked ? ['locked'] : []),
    ...(thread.earlierVersion ? ['written on an earlier version'] : []),
  ];
  const lines = [
    `#${thread.number} on ${answer.post} (${facts.join(', ')})`,
    ...(thread.suggestion
      ? [
          `A suggestion from the copy ${thread.suggestion.name}${thread.suggestion.path ? ` (${thread.suggestion.path})` : ''}`,
        ]
      : []),
    '',
    `${who(thread.by)}, ${when(thread.at)}:`,
    indent(thread.body),
  ];
  for (const reply of answer.replies) {
    lines.push(
      '',
      reply.byAgent
        ? `CloudChef, asked by ${who(reply.by)}, ${when(reply.at)}:`
        : `${who(reply.by)}, ${when(reply.at)}:`,
      indent(reply.body),
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The arguments `cloudchef comments` was run with, as a command; or the usage, for anything else. */
export function parseCommentsArguments(args: readonly string[]): CommentsCommand | { usage: string } {
  const usage =
    'Usage: cloudchef comments | cloudchef comments show <n> | cloudchef comments close <n> --changed | --not-planned | --same-as <m>';
  const number = (value: string | undefined) =>
    value && /^#?[1-9][0-9]{0,6}$/.test(value) ? Number(value.replace('#', '')) : null;
  if (args.length === 0) {
    return { op: 'list' };
  }
  const [op, target, flag, other] = args;
  const n = number(target);
  if (op === 'show' && n !== null && args.length === 2) {
    return { op: 'show', number: n };
  }
  if (op === 'close' && n !== null) {
    if (flag === '--changed' && args.length === 3) {
      return { op: 'close', number: n, reason: 'changed' };
    }
    if (flag === '--not-planned' && args.length === 3) {
      return { op: 'close', number: n, reason: 'not_planned' };
    }
    const same = number(other);
    if (flag === '--same-as' && same !== null && args.length === 4) {
      return { op: 'close', number: n, reason: 'duplicate', sameAs: same };
    }
  }
  return { usage };
}

/**
 * What a failed mention turn posts in the thread. Why it failed is said only to the person who asked (in their chat,
 * or on the post page when it couldn't start): it can be a model provider's or their account's own words.
 */
export const COULD_NOT_FINISH =
  'CloudChef couldn’t finish this. The person who asked can see why in their chat, and ask again.';
