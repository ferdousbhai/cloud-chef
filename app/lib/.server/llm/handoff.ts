import { DEFAULT_COMPACTION_POLICY } from '@earendil-works/pi-durable';
import {
  isContextOverflow,
  normalizeContext,
  type AssistantMessage,
  type Message,
  type ModelThinkingLevel,
  type Usage,
} from '@earendil-works/pi-ai';
import type { ModelHandle, ModelStreamOptions } from './pi-ai-models';

/**
 * Handoff and continue: when a conversation nears the model's context limit, the model writes a handoff note for
 * whoever continues, the conversation is reset to that note (`Conversation.reset`), and the person's latest request is
 * sent again, so the work goes on in a fresh context that starts from the system prompt, the note and that request.
 * Nothing is compacted or summarized by anything but the model, and the chat still shows everything.
 */

/** How far below the limit a turn starts by handing off, so the turn itself has room to work. */
const PROACTIVE_HANDOFF_MARGIN_TOKENS = 20_000;

/** A note longer than this is cut, so the fresh context always has room for the work. */
const MAX_HANDOFF_NOTE_CHARACTERS = 40_000;

/** What the model is asked, after the conversation so far, to write the note. */
export const HANDOFF_REQUEST = `This conversation is near the model's context limit, so it will continue in a fresh context. That context starts from the system prompt, a handoff note you write now, and the person's latest message; nothing else from this conversation is carried over.

Write the handoff note for whoever continues the work (you, without this conversation). Cover:
- what the person asked for, in their words where the details matter;
- what is done;
- what is in progress, and where it stopped;
- decisions made, and why;
- what to do next;
- where things are in the project: files, commands, previews, anything waiting for the person.

Be specific: whoever continues should not need to ask the person again. Reply with the note only, and do not call tools.`;

/** What a fresh context starts from when the model wrote no note, so the work can still go on. */
const MISSING_HANDOFF_NOTE =
  'No handoff note could be written. Read the project to see where things stand before you continue.';

/** The message a fresh context starts with: the handoff note, framed as what it is. */
export function handoffOpening(note: string): string {
  return `This conversation continues in a fresh context. Earlier, near the context limit, you wrote this handoff note for yourself; the messages before it are not shown here. The note is a summary: check the project's files and state before you rely on a detail. The person's latest message follows it.

<handoff_note>
${note}
</handoff_note>`;
}

/**
 * The context size past which the conversation hands off before its next request: pi-durable's own blocking point
 * (the window less the room it keeps for the answer), and, at the start of a turn, a margin below that so the turn has
 * room to work. A small window keeps proportionally less.
 */
export function handoffThresholdTokens(contextWindow: number, at: 'turn_start' | 'step'): number {
  const reserve = Math.min(DEFAULT_COMPACTION_POLICY.reserveTokens, Math.floor(contextWindow / 4));
  const margin = at === 'turn_start' ? Math.min(PROACTIVE_HANDOFF_MARGIN_TOKENS, Math.floor(contextWindow / 8)) : 0;
  return contextWindow - reserve - margin;
}

/**
 * How large the context is, by pi's accounting: the newest successful response's reported usage, which counts
 * everything sent before it, plus an estimate of what came after it. Without one, an estimate of it all.
 */
export function contextTokens(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted') {
      continue;
    }
    const used = usedTokens(message.usage);
    if (used > 0) {
      return used + messages.slice(index + 1).reduce((total, item) => total + estimateTokens(item), 0);
    }
  }
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/** Whether the conversation holds work to hand off: anything besides its system prompt and one message. */
export function hasWorkToHandOff(messages: readonly Message[]): boolean {
  return messages.filter((message) => message.role !== 'system').length > 1;
}

/** Whether a failed response says the context was too long for the model. */
export function isOverflow(message: AssistantMessage, contextWindow: number): boolean {
  return message.stopReason === 'error' && isContextOverflow(message, contextWindow);
}

/**
 * Asks the model for a handoff note about the conversation in `messages` (its system messages first), answering with
 * the note. A conversation larger than `budgetTokens` is sent without its oldest messages; if the provider still finds
 * it too large, once more with half that budget. The missing-note text when the model failed or wrote nothing.
 */
export async function writeHandoffNote(args: {
  handle: ModelHandle;
  messages: readonly Message[];
  budgetTokens: number;
  reasoning: ModelThinkingLevel;
  sessionId: string;
  signal?: AbortSignal;
  onUsage: (usage: Usage) => void;
}): Promise<string> {
  let budget = args.budgetTokens;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request = handoffRequestMessages(args.messages, budget);
    const options: ModelStreamOptions = { signal: args.signal, sessionId: args.sessionId };
    if (args.reasoning !== 'off') {
      options.reasoning = args.reasoning;
    }
    const stream = args.handle.stream(args.handle.model, normalizeContext({ messages: request }), options);
    const response = await stream.result();
    args.onUsage(response.usage);
    args.signal?.throwIfAborted();
    if (response.stopReason !== 'error' && response.stopReason !== 'aborted') {
      const note = responseText(response).trim();
      return note ? boundedNote(note) : MISSING_HANDOFF_NOTE;
    }
    if (!isContextOverflow(response, args.handle.model.contextWindow)) {
      break;
    }
    budget = Math.floor(budget / 2);
  }
  return MISSING_HANDOFF_NOTE;
}

/**
 * The conversation with the handoff request after it, within `budgetTokens`: the oldest messages after the first are
 * left out as needed, a tool call's results with it, and the request says so. A failed response at the end, such as
 * the overflow that started the handoff, is left out.
 */
export function handoffRequestMessages(messages: readonly Message[], budgetTokens: number): Message[] {
  const usable = messages.filter(
    (message) => message.role !== 'assistant' || (message.stopReason !== 'error' && message.stopReason !== 'aborted'),
  );
  const system = usable.filter((message) => message.role === 'system');
  const rest = usable.filter((message) => message.role !== 'system');
  const sizes = rest.map(estimateTokens);
  let total = sizes.reduce((sum, size) => sum + size, 0) + system.reduce((sum, item) => sum + estimateTokens(item), 0);
  let firstKept = 1;
  while (total > budgetTokens && firstKept < rest.length - 1) {
    total -= sizes[firstKept];
    firstKept += 1;
    while (rest[firstKept]?.role === 'toolResult' && firstKept < rest.length - 1) {
      total -= sizes[firstKept];
      firstKept += 1;
    }
  }
  const kept = firstKept > 1 ? [...rest.slice(0, 1), ...rest.slice(firstKept)] : rest;
  const request: Message = {
    role: 'user',
    content:
      firstKept > 1
        ? `${HANDOFF_REQUEST}\n\n(Some of the oldest messages were left out of this request to make room; the first message and the most recent ones are here.)`
        : HANDOFF_REQUEST,
    timestamp: Date.now(),
  };
  return [...system, ...kept, request];
}

function usedTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function responseText(message: AssistantMessage): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

function boundedNote(note: string): string {
  return note.length <= MAX_HANDOFF_NOTE_CHARACTERS
    ? note
    : `${note.slice(0, MAX_HANDOFF_NOTE_CHARACTERS)}\n[The rest of the note was cut to fit.]`;
}

/** About four characters per token: a cheap estimate; provider-reported usage stays authoritative. */
function estimateTokens(message: Message): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}
