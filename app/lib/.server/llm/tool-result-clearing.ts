import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTextTokens } from './context-compaction';

/**
 * Old tool output is most of what a long build sends the model on every call: a file read many
 * edits ago, a build log already acted on. Clearing it, oldest first, keeps every message and tool
 * call in place and replaces only the output with a short note, so the model still sees what it did
 * and can run the tool again (or search history) for anything it still needs.
 *
 * Prompt caching is by prefix, so clearing is done rarely and in large steps: only once the context
 * passes {@link toolResultClearingTriggerTokens}, and only when it frees at least
 * {@link MIN_TOOL_RESULT_CLEARING_SAVINGS_TOKENS}. The note is identical every time, so a result
 * cleared once stays byte-identical, and the cached prefix up to the first newly cleared result holds.
 */

/** The most recent tool results stay verbatim: the model is still working from them. */
export const RECENT_TOOL_RESULTS_KEPT = 6;

/** A shorter result costs little more than the note that would replace it. */
const MIN_CLEARED_RESULT_CHARACTERS = 2_000;

/** A clearing pass that frees less than this is not worth invalidating the cached prefix for. */
export const MIN_TOOL_RESULT_CLEARING_SAVINGS_TOKENS = 12_000;

const MAX_CLEARING_TRIGGER_TOKENS = 64_000;

/** Clearing starts at 64k tokens, or at half the input budget of a model with a smaller window. */
export function toolResultClearingTriggerTokens(hardLimitTokens: number): number {
  return Math.min(MAX_CLEARING_TRIGGER_TOKENS, Math.floor(hardLimitTokens / 2));
}

export function clearedToolResultText(toolName: string): string {
  return `[Earlier ${toolName} output cleared to save context. Run the tool again if you still need it; history can also find it.]`;
}

/**
 * Copies of `messages` with every large tool result except the most recent {@link RECENT_TOOL_RESULTS_KEPT}
 * replaced by its note. The input messages are never changed, so history keeps the originals.
 */
export function clearOldToolResults(messages: readonly AgentMessage[]) {
  let remainingKept = RECENT_TOOL_RESULTS_KEPT;
  let savedTokens = 0;
  const cleared = new Set<AgentMessage>();
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message?.role !== 'toolResult') {
      continue;
    }
    if (remainingKept > 0) {
      remainingKept -= 1;
      continue;
    }
    const text = message.content.map((part) => (part.type === 'text' ? part.text : part.data)).join('');
    if (text.length < MIN_CLEARED_RESULT_CHARACTERS) {
      continue;
    }
    const note = clearedToolResultText(message.toolName);
    const replacement: AgentMessage = { ...message, content: [{ type: 'text', text: note }] };
    next[index] = replacement;
    cleared.add(replacement);
    savedTokens += estimateTextTokens(text) - estimateTextTokens(note);
  }
  return { messages: next, savedTokens, cleared };
}
