import { normalizeContext, type Usage } from '@earendil-works/pi-ai';
import type { ModelHandle } from './pi-ai-models';

/** One user prompt answered once as text, failing when the model's request did. */
export async function completeText(
  handle: ModelHandle,
  args: {
    prompt: string;
    maxTokens?: number;
    temperature: number;
    /** The call's token counts, once the model answered (for an organization's per-member usage). */
    onUsage?: (usage: Usage) => void;
  },
): Promise<string> {
  const context = normalizeContext({
    messages: [{ role: 'user', content: args.prompt, timestamp: Date.now() }],
  });
  const stream = await handle.stream(handle.model, context, {
    temperature: args.temperature,
    maxTokens: args.maxTokens,
  });
  const message = await stream.result();
  args.onUsage?.(message.usage);
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new Error(message.errorMessage ?? 'The model request failed.');
  }
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
}
