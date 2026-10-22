import { normalizeContext, type AssistantMessage, type Tool, type ToolCall, type Usage } from '@earendil-works/pi-ai';
import type { ModelHandle, ModelStreamOptions } from './pi-ai-models';

type CompletionArgs = {
  prompt: string;
  maxTokens?: number;
  /** The call's token counts, once the model answered (for an organization's per-member usage). */
  onUsage?: (usage: Usage) => void;
};

/** One user prompt answered once, failing when the model's request did. */
async function complete(
  handle: ModelHandle,
  args: CompletionArgs & { systemPrompt?: string; tools?: Tool[] },
  options: ModelStreamOptions,
): Promise<AssistantMessage> {
  const context = normalizeContext({
    systemPrompt: args.systemPrompt,
    messages: [{ role: 'user', content: args.prompt, timestamp: Date.now() }],
    tools: args.tools,
  });
  const stream = await handle.stream(handle.model, context, { ...options, maxTokens: args.maxTokens });
  const message = await stream.result();
  args.onUsage?.(message.usage);
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(message.errorMessage ?? 'The model request failed.');
  }
  return message;
}

export async function completeText(
  handle: ModelHandle,
  args: CompletionArgs & { temperature: number },
): Promise<string> {
  const message = await complete(handle, args, { temperature: args.temperature });
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}

export async function completeToolCall(
  handle: ModelHandle,
  args: CompletionArgs & { systemPrompt: string; tool: Tool },
): Promise<Record<string, unknown>> {
  const message = await complete(
    handle,
    { ...args, tools: [args.tool] },
    { toolChoice: { type: 'function', function: { name: args.tool.name } } },
  );
  const calls = message.content.filter(
    (block): block is ToolCall => block.type === 'toolCall' && block.name === args.tool.name,
  );
  if (calls.length !== 1) {
    throw new Error('The model returned an invalid structured response.');
  }
  return calls[0]!.arguments;
}
