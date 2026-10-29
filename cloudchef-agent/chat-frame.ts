import { z } from 'zod';
import type { CloudChefMessage, CloudChefPart } from './ai-compat.js';

/**
 * How the chat reaches the browser: the agent derives the chat's messages from its pi-durable transcript after each
 * commit and sends what changed. A frame keeps the browser's first `from` messages, and of the message at `from` its
 * first `keepParts` parts, and puts `messages` after them. A frame with `from` 0 and `keepParts` 0 is the whole chat.
 */
export const CHAT_FRAME_TYPE = 'cloudchef_chat';

const partSchema = z.looseObject({ type: z.string().min(1) });
const messageFieldsSchema = z.looseObject({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(partSchema),
});
/** Checked for the fields the chat reads; the parts' own shapes are read where they are shown. */
const messageSchema = z.custom<CloudChefMessage>(
  (value) => messageFieldsSchema.safeParse(value).success,
  'Invalid chat message.',
);

export const chatFrameSchema = z.object({
  type: z.literal(CHAT_FRAME_TYPE),
  from: z.number().int().min(0),
  keepParts: z.number().int().min(0),
  messages: z.array(messageSchema),
  /** A run is going: the chat shows it as working, and a message sent now joins it. */
  busy: z.boolean(),
  /** What each running call reports so far, for the chat's live tool progress. */
  progress: z.array(z.object({ toolCallId: z.string(), toolName: z.string(), result: z.unknown() })),
});
export type ChatFrame = z.infer<typeof chatFrameSchema>;

/** What changed from `previous` to `next`, comparing messages from `compareFrom` on; earlier ones are taken as equal. */
export function chatFrameChange(
  previous: readonly CloudChefMessage[],
  next: readonly CloudChefMessage[],
  compareFrom = 0,
): { from: number; keepParts: number; messages: CloudChefMessage[] } | null {
  let from = Math.min(compareFrom, previous.length, next.length);
  while (from < previous.length && from < next.length && messagesEqual(previous[from], next[from])) {
    from += 1;
  }
  if (from === previous.length && from === next.length) {
    return null;
  }
  const before = previous[from];
  const after = next[from];
  let keepParts = 0;
  if (before && after && before.id === after.id && before.role === after.role) {
    while (
      keepParts < before.parts.length &&
      keepParts < after.parts.length &&
      partsEqual(before.parts[keepParts], after.parts[keepParts])
    ) {
      keepParts += 1;
    }
  }
  const messages = next.slice(from);
  if (keepParts > 0 && after) {
    messages[0] = { ...after, parts: after.parts.slice(keepParts) };
  }
  return { from, keepParts, messages };
}

/** The browser's messages after a frame. */
export function applyChatFrame(
  previous: readonly CloudChefMessage[],
  frame: Pick<ChatFrame, 'from' | 'keepParts' | 'messages'>,
): CloudChefMessage[] {
  const kept = previous.slice(0, frame.from);
  const [first, ...rest] = frame.messages;
  if (!first) {
    return kept;
  }
  const keptParts: CloudChefPart[] =
    frame.keepParts > 0 ? (previous[frame.from]?.parts.slice(0, frame.keepParts) ?? []) : [];
  return [...kept, { ...first, parts: [...keptParts, ...first.parts] }, ...rest];
}

function messagesEqual(left: CloudChefMessage | undefined, right: CloudChefMessage | undefined): boolean {
  if (!left || !right || left.id !== right.id || left.role !== right.role || left.parts.length !== right.parts.length) {
    return false;
  }
  return left.parts.every((part, index) => partsEqual(part, right.parts[index]));
}

function partsEqual(left: CloudChefPart | undefined, right: CloudChefPart | undefined): boolean {
  return (
    left === right || (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right))
  );
}
