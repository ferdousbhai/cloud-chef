import { getToolInvocation, type CloudChefMessage, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';

export type ModelTextPart = { type: 'text'; text: string };

export type ModelToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ModelToolOutput = { type: 'json'; value: unknown } | { type: 'error-text'; value: string };

export type ModelToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ModelToolOutput;
};

export type ModelMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'assistant'; content: (ModelTextPart | ModelToolCallPart)[] }
  | { role: 'tool'; content: ModelToolResultPart[] };

/** Convert the authoritative UI transcript into the text/tool protocol consumed by Pi. */
export function cleanupAssistantMessages(messages: CloudChefMessage[]): ModelMessage[] {
  return messages.flatMap(toModelMessages);
}

function toModelMessages(message: CloudChefMessage): ModelMessage[] {
  if (message.role !== 'assistant') {
    const text = message.parts.map(partText).join('');
    return text || message.role === 'user' ? [{ role: message.role, content: text }] : [];
  }

  const result: ModelMessage[] = [];
  let pendingText = '';
  const flushText = (): ModelTextPart[] => {
    const text = pendingText.trim();
    pendingText = '';
    return text ? [{ type: 'text', text }] : [];
  };

  for (const part of message.parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      pendingText += stripHiddenReasoning(part.text);
      continue;
    }
    const invocation = getToolInvocation(part);
    if (!invocation || !isTerminalToolState(invocation.state) || !invocation.toolCallId || !invocation.toolName) {
      continue;
    }
    result.push({
      role: 'assistant',
      content: [
        ...flushText(),
        {
          type: 'tool-call',
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          input: toolCallInput(invocation.input),
        },
      ],
    });
    result.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          output:
            invocation.state === 'output-available'
              ? { type: 'json', value: invocation.output }
              : { type: 'error-text', value: invocation.errorText ?? 'Tool execution failed.' },
        },
      ],
    });
  }

  const finalText = flushText();
  if (finalText.length > 0) {
    result.push({ role: 'assistant', content: finalText });
  }
  return result;
}

/** Tool-call inputs arrive as decoded JSON from the transcript; anything but an object carries no arguments. */
function toolCallInput(input: CloudChefToolInvocation['input']): Record<string, unknown> {
  return isArgumentObject(input) ? input : {};
}

function isArgumentObject(value: CloudChefToolInvocation['input']): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function partText(part: CloudChefMessage['parts'][number]): string {
  return part.type === 'text' && typeof part.text === 'string' ? stripHiddenReasoning(part.text) : '';
}

function isTerminalToolState(state: string): boolean {
  return state === 'output-available' || state === 'output-error' || state === 'output-denied';
}

function stripHiddenReasoning(message: string): string {
  return message
    .replace(/<div\s+class=["']__cloudchefThought__["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<think(?:\s[^>]*)?>[\s\S]*?<\/think>/gi, '');
}
