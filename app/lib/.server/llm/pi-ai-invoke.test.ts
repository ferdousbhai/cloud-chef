import { describe, expect, it, vi } from 'vitest';
import { completeToolCall } from './pi-ai-invoke';

const tool = {
  name: 'submit_result',
  description: 'Submit a result.',
  parameters: { type: 'object', properties: {} },
} as never;

function handleWithContent(content: unknown[]) {
  const stream = vi.fn(() => ({
    result: vi.fn(async () => ({
      stopReason: 'toolUse',
      content,
    })),
  }));
  return {
    handle: { model: { id: 'test' }, stream } as never,
    stream,
  };
}

describe('completeToolCall', () => {
  it('forces the named tool and returns its structured arguments', async () => {
    const { handle, stream } = handleWithContent([
      { type: 'toolCall', id: 'call-1', name: 'submit_result', arguments: { kind: 'complete' } },
    ]);

    await expect(completeToolCall(handle, { systemPrompt: 'System', prompt: 'User', tool })).resolves.toEqual({
      kind: 'complete',
    });
    expect(stream).toHaveBeenCalledWith(
      expect.anything(),
      {
        messages: [
          { role: 'system', content: 'System', toolsAdded: [tool], timestamp: 0 },
          { role: 'user', content: 'User', timestamp: expect.any(Number) },
        ],
      },
      expect.objectContaining({
        toolChoice: { type: 'function', function: { name: 'submit_result' } },
      }),
    );
  });

  it('fails closed when the model omits or duplicates the required tool call', async () => {
    const missing = handleWithContent([{ type: 'text', text: 'not structured' }]);
    const duplicate = handleWithContent([
      { type: 'toolCall', id: 'call-1', name: 'submit_result', arguments: {} },
      { type: 'toolCall', id: 'call-2', name: 'submit_result', arguments: {} },
    ]);

    await expect(completeToolCall(missing.handle, { systemPrompt: 'System', prompt: 'User', tool })).rejects.toThrow(
      'invalid structured response',
    );
    await expect(completeToolCall(duplicate.handle, { systemPrompt: 'System', prompt: 'User', tool })).rejects.toThrow(
      'invalid structured response',
    );
  });
});
