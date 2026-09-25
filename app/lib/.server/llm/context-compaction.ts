import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { getToolInvocation, messageText, type CloudChefMessage } from 'cloudchef-agent/ai-compat';

/** Best-effort checkpoint reminder distance from the automatic rollover line. */
export const CONTEXT_HANDOFF_REMINDER_TOKENS = 20_000;
export const MAX_HANDOFF_CHARACTERS = 20_000;
const AUTOMATIC_HANDOFF = 'Automatic context rollover recovery record.';
const HANDOFF_PREFIX = 'Earlier conversation is preserved in history. Continue from this checkpoint:\n\n<summary>\n';
const LEGACY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const HANDOFF_SUFFIX = '\n</summary>';

/** Storage fields stay compatible with checkpoints saved before handoff-based rollover. */
export type ContextCompaction = {
  summary: string;
  fromMessageId: string;
  toMessageId: string;
};

export type HistoryEntry = { id: string; role: string; text: string; retrieval?: boolean };

export function durableHistoryEntries(messages: CloudChefMessage[]): HistoryEntry[] {
  return messages.map((message) => ({ id: message.id, role: message.role, text: JSON.stringify(message.parts) }));
}

export function liveHistoryEntry(message: AgentMessage, id: string): HistoryEntry {
  return {
    id,
    role: message.role,
    text: JSON.stringify(message),
    retrieval: message.role === 'toolResult' && message.toolName === 'history',
  };
}

/** The original transcript is never changed or deleted by a context rollover. */
export function assembleCompactedContext(messages: CloudChefMessage[], compaction?: ContextCompaction | null) {
  if (!compaction) {
    return { messages, overlayApplied: false };
  }
  const start = messages.findIndex((message) => message.id === compaction.fromMessageId);
  const end = messages.findIndex((message) => message.id === compaction.toMessageId);
  if (start < 0 || end < start) {
    return { messages, overlayApplied: false };
  }
  const overlay: CloudChefMessage = {
    id: `compaction_cloudchef_${compaction.toMessageId}`,
    role: 'user',
    parts: [{ type: 'text', text: formatHandoff(compaction.summary) }],
  };
  return { messages: [...messages.slice(0, start), overlay, ...messages.slice(end + 1)], overlayApplied: true };
}

/** Retire completed turns, retaining a newly submitted user request verbatim. No model call. */
export function compactContext(args: {
  messages: CloudChefMessage[];
  current?: ContextCompaction | null;
  signal?: AbortSignal;
}): ContextCompaction | null {
  args.signal?.throwIfAborted();
  const end = args.messages.length - (args.messages.at(-1)?.role === 'user' ? 2 : 1);
  if (end < 0) {
    return null;
  }
  const currentStart = args.current
    ? args.messages.findIndex((message) => message.id === args.current?.fromMessageId)
    : -1;
  const storedEnd = args.current ? args.messages.findIndex((message) => message.id === args.current?.toMessageId) : -1;
  const currentEnd = currentStart >= 0 && storedEnd >= currentStart ? storedEnd : -1;
  if (currentEnd >= end) {
    return null;
  }
  const completed = args.messages.slice(0, end + 1);
  const fresh = completed.slice(currentEnd + 1);
  const manual = fresh
    .flatMap((message) => message.parts)
    .map(getToolInvocation)
    .findLast(
      (tool) =>
        tool?.toolName === 'new_context' && tool.state === 'output-available' && readHandoff(tool.input) !== undefined,
    );
  const handoff = manual ? readHandoff(manual.input) : undefined;
  const users = completed
    .filter((message) => message.role === 'user')
    .map((message) => ({ id: message.id, text: messageText(message) }));
  const recentTools = fresh
    .flatMap((message) => message.parts.map((part) => ({ id: message.id, tool: getToolInvocation(part) })))
    .filter(({ tool }) => tool && tool.toolName !== 'history' && tool.toolName !== 'new_context')
    .slice(-8);
  return {
    summary: recoveryRecord(
      users,
      handoff ?? (currentEnd >= 0 ? args.current?.summary : undefined),
      recentTools.map(({ id, tool }) => `[history ${id}] ${JSON.stringify(tool)}`),
    ),
    fromMessageId: args.messages[0].id,
    toMessageId: args.messages[end].id,
  };
}

/** Start a fresh live window after the complete tool batch, preserving its results in the record. */
export function compactPiContext(args: {
  messages: AgentMessage[];
  durableMessages?: CloudChefMessage[];
  previousInputs?: AgentMessage[];
  handoff?: string;
  signal?: AbortSignal;
}): { messages: AgentMessage[]; tokensBefore: number; tokensAfter: number } | null {
  args.signal?.throwIfAborted();
  // An initial prompt alone has no completed work to hand off. Keep the real provider error.
  if (
    args.messages.length <= 1 &&
    !args.messages.some((message) => message.role === 'assistant' || message.role === 'toolResult')
  ) {
    return null;
  }
  const users = (args.durableMessages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => ({ id: message.id, text: messageText(message) }));
  for (const message of args.previousInputs ?? args.messages) {
    if (message.role === 'user' && !readCheckpoint(message)) {
      users.push({ id: 'current turn; search history', text: contentText(message.content) });
    }
  }
  const previous = args.messages.map(readCheckpoint).find((value) => value !== undefined);
  const batch: string[] = [];
  for (let index = args.messages.length - 1; index >= 0; index -= 1) {
    const message = args.messages[index];
    if (message.role === 'toolResult') {
      batch.unshift(JSON.stringify(message));
    } else if (message.role === 'assistant') {
      if (batch.length) {
        batch.unshift(JSON.stringify(message.content.filter((part) => part.type === 'toolCall')));
      }
      break;
    }
  }
  const checkpoint: Message = {
    role: 'user',
    content: formatHandoff(recoveryRecord(users, args.handoff ?? previous, batch)),
    timestamp: Date.now(),
  };
  const messages = [checkpoint];
  return {
    messages,
    tokensBefore: estimatePiContextTokens(args.messages),
    tokensAfter: estimatePiContextTokens(messages),
  };
}

function recoveryRecord(
  users: Array<{ id: string; text: string }>,
  checkpoint: string | undefined,
  batch: string[],
): string {
  const selected = users.length > 1 ? [users[0], ...users.slice(-3).filter((user) => user !== users[0])] : users;
  const keptBatch = batch.slice(-16);
  const perResult = Math.floor(MAX_HANDOFF_CHARACTERS / 5 / Math.max(1, keptBatch.length));
  const record = {
    recovery:
      'This record preserves inputs and recent tool results, not a verified summary of progress. Use history search/read to recover omitted details. Read project files and verify live state before continuing; do not repeat a mutation merely because its result is absent here.',
    inputs: selected.map(({ id, text }) => ({ id: id.slice(0, 120), text: boundedText(text, 1_500) })),
    omittedInputs: users.length - selected.length,
    handoff: carryHandoff(checkpoint),
    toolActivity: keptBatch.map((item) => boundedText(item, perResult)),
    omittedToolRecords: batch.length - keptBatch.length,
  };
  return `${AUTOMATIC_HANDOFF}\n${JSON.stringify(record, null, 2)}`;
}

/** Bound serialized size too, so escaped tool output cannot crowd out the authored handoff. */
function boundedText(text: string, limit: number): string {
  let bounded = excerpt(text, limit);
  while (JSON.stringify(bounded).length > limit + 2) {
    bounded = excerpt(bounded, Math.floor(bounded.length * 0.8));
  }
  return bounded;
}

function carryHandoff(checkpoint?: string): string | undefined {
  if (!checkpoint) {
    return undefined;
  }
  if (!checkpoint.startsWith(`${AUTOMATIC_HANDOFF}\n`)) {
    return boundedText(checkpoint, 6_000);
  }
  try {
    const record: unknown = JSON.parse(checkpoint.slice(AUTOMATIC_HANDOFF.length + 1));
    return readHandoff(record);
  } catch {
    return undefined;
  }
}

function readHandoff(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('handoff' in input) || typeof input.handoff !== 'string') {
    return undefined;
  }
  return input.handoff.trim() || undefined;
}

function formatHandoff(handoff: string): string {
  return `${HANDOFF_PREFIX}${handoff}${HANDOFF_SUFFIX}`;
}
function readCheckpoint(message: AgentMessage): string | undefined {
  if (message.role !== 'user') {
    return undefined;
  }
  const text = contentText(message.content);
  const prefix = [HANDOFF_PREFIX, LEGACY_PREFIX].find((value) => text.startsWith(value));
  return prefix && text.endsWith(HANDOFF_SUFFIX) ? text.slice(prefix.length, -HANDOFF_SUFFIX.length) : undefined;
}
function contentText(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === 'string'
    ? content
    : content
        .map((part) => (part.type === 'text' ? (part.text ?? '') : '[Non-text content; recover from history]'))
        .join('\n');
}
function excerpt(text: string, maximum: number): string {
  const suffix = '\n[Truncated; use history to read the original.]';
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - suffix.length))}${suffix}`;
}

export function estimatePiContextTokens(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted') {
      continue;
    }
    const used =
      message.usage.totalTokens ||
      message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
    if (used > 0) {
      return (
        used + messages.slice(index + 1).reduce((total, item) => total + Math.ceil(JSON.stringify(item).length / 4), 0)
      );
    }
  }
  return messages.reduce((total, message) => total + Math.ceil(JSON.stringify(message).length / 4), 0);
}
