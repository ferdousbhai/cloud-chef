import type {
  AssistantMessage,
  JsonObject,
  Message,
  SystemMessage,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import type { ModelMessage, ModelTextPart, ModelToolCallPart, ModelToolOutput } from './message-conversion';

/**
 * Bridges the transcript protocol produced by `cleanupAssistantMessages` into Pi's `Message` union.
 * Pi requires provider/usage bookkeeping on assistant turns; replayed history carries none, so the
 * bridge reports a zero-cost `pi-bridge` origin.
 */

const BRIDGE_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function modelMessagesToPi(messages: ModelMessage[]): Message[] {
  return messages.map(toPiMessage);
}

function toPiMessage(message: ModelMessage): Message {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.map(toPiAssistantContent),
      timestamp: Date.now(),
      api: 'openai-completions',
      provider: 'cloudflare-workers-ai',
      model: 'pi-bridge',
      usage: BRIDGE_USAGE,
      stopReason: 'stop',
    };
  }

  if (message.role === 'tool') {
    const result = message.content.find((part) => part.type === 'tool-result');
    if (!result) {
      return userMessage(JSON.stringify(message.content));
    }
    return toPiToolResult(result.toolCallId, result.toolName, result.output);
  }

  if (message.role === 'user') {
    return userMessage(message.content);
  }

  const system: SystemMessage = { role: 'system', content: message.content, timestamp: Date.now() };
  return system;
}

function toPiAssistantContent(part: ModelTextPart | ModelToolCallPart): TextContent | ToolCall {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  return {
    type: 'toolCall',
    id: part.toolCallId,
    name: part.toolName,
    // SAFETY: replayed tool inputs were parsed from the persisted JSON transcript.
    arguments: part.input as JsonObject,
  };
}

function toPiToolResult(toolCallId: string, toolName: string, output: ModelToolOutput): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: typeof output.value === 'string' ? output.value : stringify(output.value) }],
    isError: output.type === 'error-text',
    timestamp: Date.now(),
  };
}

function userMessage(content: string): UserMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

function stringify(value: ModelToolOutput['value']): string {
  try {
    return JSON.stringify(value) ?? String(value ?? '');
  } catch {
    return String(value ?? '');
  }
}
