import type { JsonValue } from '@earendil-works/chord';
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { EntryRecord, LiveState } from '@earendil-works/pi-durable';
import { z } from 'zod';
import type { CloudChefMessage, CloudChefPart } from 'cloudchef-agent/ai-compat';
import { handoffPart } from 'cloudchef-agent/handoff';

/**
 * What the chat shows of a conversation, derived from its pi-durable transcript, the only authoritative one: every
 * entry from the first (not only the model's current context, so the chat still shows what came before a handoff),
 * and what is running now (`pi.live`). The browser receives these messages and renders them as it always has.
 */

/** The entry kinds CloudChef writes into a conversation besides pi's own. */
export const CHAT_ENTRY = {
  /** A message the person sent; the model saw it with the turn's workspace context after it. */
  user: 'cloudchef.user',
  /** The person's latest request, sent again after a handoff: the chat already shows it. */
  continued: 'cloudchef.continue',
  /** A handoff note, written just before the reset it starts. Shown only. */
  handoff: 'cloudchef.handoff',
  /** A message of a chat from before pi-durable, kept to show. */
  legacy: 'cloudchef.legacy',
  /** A finished command's output as it is now: a team build's result, or what an admin decided. Shown only. */
  toolOutput: 'cloudchef.tool-output',
} as const;

const userDataSchema = z.object({ text: z.string() });
const handoffDataSchema = z.object({ note: z.string().min(1) });
const toolOutputDataSchema = z.object({ toolCallId: z.string().min(1), output: z.json() });
const legacyPartSchema = z.looseObject({ type: z.string().min(1) });
const legacyDataSchema = z.object({
  message: z.object({
    id: z.string().min(1),
    role: z.enum(['user', 'assistant', 'system']),
    parts: z.array(legacyPartSchema),
  }),
});
/** Claude's redacted thinking, as the old transcript kept it: nothing in it to read. */
const redactedReasoningSchema = z.object({
  type: z.literal('reasoning'),
  providerMetadata: z.object({ anthropic: z.object({ redactedData: z.string() }) }),
});

export const STOPPED_TOOL_TEXT = 'Stopped before this tool returned a result.';

/** The data of a person's message, for `submit({ entry })`. */
export function userEntryData(text: string) {
  return { text };
}

/** A finished call's newer output, for a display-only write. */
export function toolOutputEntryData(toolCallId: string, output: JsonValue) {
  return { toolCallId, output };
}

/** The newest output each finished call was given after it ended, by call. */
function toolOutputOverrides(entries: readonly EntryRecord[]): Map<string, JsonValue> {
  const overrides = new Map<string, JsonValue>();
  for (const entry of entries) {
    if (entry.kind === CHAT_ENTRY.toolOutput) {
      const data = toolOutputDataSchema.safeParse(entry.data).data;
      if (data) {
        overrides.set(data.toolCallId, data.output);
      }
    }
  }
  return overrides;
}

/**
 * The chat's messages: the person's messages, and between them one assistant message per stretch of the model's
 * work, with its reasoning, text, tool calls and their results, and any handoff it went on from. `live` adds what is
 * streaming and which calls are running.
 */
export function chatMessages(
  entries: readonly EntryRecord[],
  live: Readonly<LiveState> | undefined,
): CloudChefMessage[] {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    const result = entry.kind === 'pi.tool-result' ? entry.model?.find(isToolResult) : undefined;
    if (result) {
      results.set(result.toolCallId, result);
    }
  }
  const overrides = toolOutputOverrides(entries);
  const running = new Set((live?.tools ?? []).filter((slot) => slot.status !== 'done').map((slot) => slot.callId));
  const messages: CloudChefMessage[] = [];
  let assistant: CloudChefMessage | null = null;
  /** The id the next assistant message takes: after the message that precedes it, so it keeps it while it grows. */
  let nextAssistantId = 'start-a';
  const openAssistant = (): CloudChefMessage => {
    if (!assistant) {
      assistant = { id: nextAssistantId, role: 'assistant', parts: [] };
      messages.push(assistant);
    }
    return assistant;
  };
  for (const entry of entries) {
    switch (entry.kind) {
      case CHAT_ENTRY.user:
      case 'pi.user': {
        assistant = null;
        messages.push({ id: String(entry.id), role: 'user', parts: [{ type: 'text', text: userText(entry) }] });
        nextAssistantId = `${entry.id}-a`;
        break;
      }
      case CHAT_ENTRY.legacy: {
        const legacy = legacyDataSchema.safeParse(entry.data).data;
        if (legacy) {
          assistant = null;
          messages.push({
            ...legacy.message,
            parts: legacy.message.parts.filter((part) => !redactedReasoningSchema.safeParse(part).success),
          });
          nextAssistantId = `${legacy.message.id}-a`;
        }
        break;
      }
      case CHAT_ENTRY.handoff: {
        const handoff = handoffDataSchema.safeParse(entry.data).data;
        if (handoff) {
          openAssistant().parts.push(handoffPart(handoff.note));
        }
        break;
      }
      case 'pi.assistant': {
        const message = entry.model?.find(isAssistant);
        if (message) {
          const target = openAssistant();
          for (const block of message.content) {
            const part = assistantPart(block, 'done');
            if (part) {
              target.parts.push(part);
            } else if (block.type === 'toolCall') {
              target.parts.push(toolPart(block, results.get(block.id), overrides.get(block.id), running.has(block.id)));
            }
          }
        }
        break;
      }
      default:
        // System prompt changes, resets, the request sent again after a handoff, tool results (shown with their
        // calls) and newer outputs (applied to them) show nothing of their own.
        break;
    }
  }
  const partial = live?.generation?.message;
  if (partial) {
    const target = openAssistant();
    for (const block of partial.content) {
      const part = assistantPart(block, 'streaming');
      if (part) {
        target.parts.push(part);
      } else if (block.type === 'toolCall') {
        target.parts.push({
          type: 'dynamic-tool',
          toolName: block.name,
          toolCallId: block.id,
          state: 'input-streaming',
          input: block.arguments,
        });
      }
    }
  }
  return messages;
}

/** The running details of each call still running, for the chat's live tool progress. */
export function liveToolProgress(
  live: Readonly<LiveState> | undefined,
): { toolCallId: string; toolName: string; result: JsonValue }[] {
  return (live?.tools ?? []).flatMap((slot) =>
    slot.status !== 'done' && slot.details !== undefined
      ? [{ toolCallId: slot.callId, toolName: slot.name, result: slot.details }]
      : [],
  );
}

function userText(entry: EntryRecord): string {
  const data = userDataSchema.safeParse(entry.data).data;
  if (data) {
    return data.text;
  }
  const message = entry.model?.find((item) => item.role === 'user');
  if (!message || message.role !== 'user') {
    return '';
  }
  return Array.isArray(message.content)
    ? message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    : message.content;
}

function assistantPart(block: AssistantMessage['content'][number], state: 'done' | 'streaming'): CloudChefPart | null {
  if (block.type === 'text') {
    return block.text ? { type: 'text', text: block.text, state } : null;
  }
  if (block.type === 'thinking') {
    // Redacted thinking is kept only for the model; there is nothing in it to read.
    return block.redacted || !block.thinking ? null : { type: 'reasoning', text: block.thinking, state };
  }
  return null;
}

function toolPart(
  call: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>,
  result: ToolResultMessage | undefined,
  override: JsonValue | undefined,
  pending: boolean,
): CloudChefPart {
  const base = { type: 'dynamic-tool', toolName: call.name, toolCallId: call.id, input: call.arguments };
  if (override !== undefined) {
    return { ...base, state: 'output-available', output: override };
  }
  if (result) {
    return result.details === undefined
      ? { ...base, state: 'output-error', errorText: resultText(result) || STOPPED_TOOL_TEXT }
      : { ...base, state: 'output-available', output: result.details };
  }
  return pending
    ? { ...base, state: 'input-available' }
    : { ...base, state: 'output-error', errorText: STOPPED_TOOL_TEXT };
}

function resultText(result: ToolResultMessage): string {
  return result.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

function isAssistant(message: Message): message is AssistantMessage {
  return message.role === 'assistant';
}

function isToolResult(message: Message): message is ToolResultMessage {
  return message.role === 'toolResult';
}
