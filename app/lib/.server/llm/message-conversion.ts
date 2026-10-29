import type {
  AssistantMessage,
  JsonObject,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import {
  getToolInvocation,
  type CloudChefMessage,
  type CloudChefPart,
  type CloudChefToolInvocation,
} from 'cloudchef-agent/ai-compat';
import { partStep, storedThinking, type StoredThinking, type ThinkingModel } from 'cloudchef-agent/signed-thinking';
import { isRecord } from 'cloudchef-agent/utils/isRecord';

/**
 * Pi requires provider/usage bookkeeping on assistant turns; replayed history carries none, so the
 * conversion reports a zero-cost `pi-bridge` origin.
 */
const BRIDGE_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Convert the authoritative UI transcript into the Pi messages a model turn replays. */
export function transcriptToPiMessages(messages: CloudChefMessage[]): Message[] {
  return messages.flatMap(toPiMessages);
}

function toPiMessages(message: CloudChefMessage): Message[] {
  if (message.role !== 'assistant') {
    const content = message.parts.map(partText).join('');
    if (message.role === 'user') {
      return [{ role: 'user', content, timestamp: Date.now() }];
    }
    return content ? [{ role: 'system', content, timestamp: Date.now() }] : [];
  }

  return groupModelSteps(message.parts).flatMap((group) =>
    group.step === null ? unsteppedPiMessages(group.parts) : modelStepPiMessages(group.parts),
  );
}

type PartGroup = { step: string | null; parts: CloudChefPart[] };

/**
 * The assistant message's parts, grouped by the model response (step) that wrote them where the stream
 * recorded one (`cloudchef-agent/signed-thinking`). Text carries no step of its own: it belongs to the
 * step of the reasoning or tool call that follows it, since a model writes its text before its tool
 * calls, or closes the step it follows when no tool call came before it (a final answer after its
 * thinking). Parts without a step are grouped as they always were.
 */
function groupModelSteps(parts: CloudChefPart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  let current: PartGroup | null = null;
  let pendingText: CloudChefPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      pendingText.push(part);
      continue;
    }
    const step = partStep(part);
    if (step === null && part.type === 'reasoning') {
      // Reasoning with nothing to send back (another provider's, or cut off before its signature) is
      // never replayed, so it neither starts nor splits a step.
      continue;
    }
    if (current !== null && current.step === step) {
      current.parts.push(...pendingText, part);
    } else {
      current = { step, parts: [...pendingText, part] };
      groups.push(current);
    }
    pendingText = [];
  }
  if (pendingText.length > 0) {
    const closesCurrent = current !== null && (current.step === null || !current.parts.some(isToolPart));
    if (current !== null && closesCurrent) {
      current.parts.push(...pendingText);
    } else {
      groups.push({ step: null, parts: pendingText });
    }
  }
  return groups;
}

function isToolPart(part: CloudChefPart): boolean {
  return getToolInvocation(part) !== null;
}

/**
 * One model response replayed as the model wrote it: its signed and redacted thinking, its text and its
 * finished tool calls in one assistant turn, in their order, followed by their results. A turn that
 * carries thinking names the model that wrote it, so Pi sends the blocks back only to that same model
 * and drops them for any other (`transformMessages`); text is kept exactly as written, since Claude
 * checks that the conversation before a replayed block is unchanged.
 */
function modelStepPiMessages(parts: CloudChefPart[]): Message[] {
  const content: AssistantMessage['content'] = [];
  const results: ToolResultMessage[] = [];
  let thinkingModel: ThinkingModel | null = null;
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        content.push({ type: 'text', text: part.text });
      }
      continue;
    }
    if (part.type === 'reasoning') {
      const thinking = storedThinking(part);
      if (thinking) {
        thinkingModel ??= thinking.model;
        content.push(thinkingContent(part, thinking));
      }
      continue;
    }
    const invocation = terminalInvocation(part);
    if (invocation) {
      content.push(toolCall(invocation));
      results.push(toolResult(invocation));
    }
  }
  if (content.length === 0) {
    return [];
  }
  return [assistantMessage(content, thinkingModel ?? undefined), ...results];
}

function thinkingContent(part: CloudChefPart, thinking: StoredThinking): ThinkingContent {
  if (thinking.redactedData !== undefined) {
    return { type: 'thinking', thinking: '', thinkingSignature: thinking.redactedData, redacted: true };
  }
  return {
    type: 'thinking',
    thinking: part.text ?? '',
    thinkingSignature: thinking.signature,
  };
}

/** Parts no model step was recorded for: each finished tool call is its own turn, as it always was. */
function unsteppedPiMessages(parts: CloudChefPart[]): Message[] {
  const result: Message[] = [];
  let pendingText = '';
  const flushText = (): TextContent[] => {
    const text = pendingText.trim();
    pendingText = '';
    return text ? [{ type: 'text', text }] : [];
  };

  for (const part of parts) {
    if (part.type === 'text') {
      pendingText += partText(part);
      continue;
    }
    const invocation = terminalInvocation(part);
    if (!invocation) {
      continue;
    }
    result.push(assistantMessage([...flushText(), toolCall(invocation)]), toolResult(invocation));
  }

  const finalText = flushText();
  if (finalText.length > 0) {
    result.push(assistantMessage(finalText));
  }
  return result;
}

/** A finished tool call, the only kind a replay sends: one still running has no result to pair with it. */
function terminalInvocation(part: CloudChefPart): CloudChefToolInvocation | null {
  const invocation = getToolInvocation(part);
  return invocation && isTerminalToolState(invocation.state) && invocation.toolCallId && invocation.toolName
    ? invocation
    : null;
}

function toolCall(invocation: CloudChefToolInvocation): ToolCall {
  return {
    type: 'toolCall',
    id: invocation.toolCallId,
    name: invocation.toolName,
    arguments: toolCallArguments(invocation.input),
  };
}

function toolResult(invocation: CloudChefToolInvocation): ToolResultMessage {
  const failed = invocation.state === 'output-error';
  return {
    role: 'toolResult',
    toolCallId: invocation.toolCallId,
    toolName: invocation.toolName,
    content: [
      {
        type: 'text',
        text: failed ? (invocation.errorText ?? 'Tool execution failed.') : toolOutputText(invocation.output),
      },
    ],
    isError: failed,
    timestamp: Date.now(),
  };
}

/**
 * A replayed assistant turn. One carrying thinking names the model that wrote it, as Pi compares it with
 * the model it is sending to; any other reports a zero-cost `pi-bridge` origin.
 */
function assistantMessage(
  content: (TextContent | ThinkingContent | ToolCall)[],
  thinkingModel?: ThinkingModel,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    timestamp: Date.now(),
    api: thinkingModel?.api ?? 'openai-completions',
    provider: thinkingModel?.provider ?? 'cloudflare-workers-ai',
    model: thinkingModel?.model ?? 'pi-bridge',
    usage: BRIDGE_USAGE,
    stopReason: 'stop',
  };
}

/** Tool-call inputs arrive as decoded JSON from the transcript; anything but an object carries no arguments. */
function toolCallArguments(input: CloudChefToolInvocation['input']): JsonObject {
  // SAFETY: replayed tool inputs were parsed from the persisted JSON transcript.
  return isRecord(input) ? (input as JsonObject) : {};
}

function toolOutputText(output: CloudChefToolInvocation['output']): string {
  if (typeof output === 'string') {
    return output;
  }
  try {
    return JSON.stringify(output) ?? String(output ?? '');
  } catch {
    return String(output ?? '');
  }
}

function partText(part: CloudChefMessage['parts'][number]): string {
  return part.type === 'text' && part.text ? stripHiddenReasoning(part.text) : '';
}

function isTerminalToolState(state: string): boolean {
  return state === 'output-available' || state === 'output-error';
}

function stripHiddenReasoning(message: string): string {
  return message.replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, '');
}
