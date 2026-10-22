import { normalizeContext, type Message, type Tool, type ToolCall, type Usage } from '@earendil-works/pi-ai';
import type { ModelHandle } from './pi-ai-models';

export async function completeText(
  handle: ModelHandle,
  args: {
    systemPrompt?: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    /** The call's token counts, once the model answered (for an organization's per-member usage). */
    onUsage?: (usage: Usage) => void;
  },
): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: args.prompt, timestamp: Date.now() }];
  const stream = await handle.stream(handle.model, normalizeContext({ systemPrompt: args.systemPrompt, messages }), {
    maxTokens: args.maxTokens,
    temperature: args.temperature,
    signal: args.signal,
  });
  const message = await stream.result();
  args.onUsage?.(message.usage);
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? 'The model request failed.';
    throw new Error(errorMessage);
  }
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

export async function completeToolCall(
  handle: ModelHandle,
  args: {
    systemPrompt: string;
    prompt: string;
    tool: Tool;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
    /** The call's token counts, once the model answered (for an organization's per-member usage). */
    onUsage?: (usage: Usage) => void;
  },
): Promise<Record<string, unknown>> {
  const stream = await handle.stream(
    handle.model,
    normalizeContext({
      systemPrompt: args.systemPrompt,
      messages: [{ role: 'user', content: args.prompt, timestamp: Date.now() }],
      tools: [args.tool],
    }),
    {
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      signal: args.signal,
      toolChoice: { type: 'function', function: { name: args.tool.name } },
    },
  );
  const message = await stream.result();
  args.onUsage?.(message.usage);
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    args.signal?.throwIfAborted();
    const errorMessage = message.errorMessage ?? 'The model request failed.';
    throw new Error(errorMessage);
  }
  const calls = message.content.filter(
    (block): block is ToolCall => block.type === 'toolCall' && block.name === args.tool.name,
  );
  if (calls.length !== 1) {
    throw new Error('The model returned an invalid structured response.');
  }
  return calls[0]!.arguments;
}
