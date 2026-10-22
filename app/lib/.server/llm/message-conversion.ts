import type { AssistantMessage, JsonObject, Message, TextContent, ToolCall } from '@earendil-works/pi-ai';
import { getToolInvocation, type CloudChefMessage, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
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

  const result: Message[] = [];
  let pendingText = '';
  const flushText = (): TextContent[] => {
    const text = pendingText.trim();
    pendingText = '';
    return text ? [{ type: 'text', text }] : [];
  };

  for (const part of message.parts) {
    if (part.type === 'text') {
      pendingText += partText(part);
      continue;
    }
    const invocation = getToolInvocation(part);
    if (!invocation || !isTerminalToolState(invocation.state) || !invocation.toolCallId || !invocation.toolName) {
      continue;
    }
    result.push(
      assistantMessage([
        ...flushText(),
        {
          type: 'toolCall',
          id: invocation.toolCallId,
          name: invocation.toolName,
          arguments: toolCallArguments(invocation.input),
        },
      ]),
    );
    const failed = invocation.state === 'output-error';
    result.push({
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
    });
  }

  const finalText = flushText();
  if (finalText.length > 0) {
    result.push(assistantMessage(finalText));
  }
  return result;
}

function assistantMessage(content: (TextContent | ToolCall)[]): AssistantMessage {
  return {
    role: 'assistant',
    content,
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    model: 'pi-bridge',
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
