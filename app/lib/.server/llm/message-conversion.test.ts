import { describe, expect, it } from 'vitest';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import type { CloudChefMessage, CloudChefPart } from 'cloudchef-agent/ai-compat';
import { applyChunkToParts, sanitizeMessage } from 'agents/chat';
import { redactedThinkingMetadata, signedThinkingMetadata, toolStepMetadata } from 'cloudchef-agent/signed-thinking';
import type { PiStreamChunk } from './pi-stream';
import { transcriptToPiMessages } from './message-conversion';

describe('transcriptToPiMessages', () => {
  it('replays a tool success as a Pi tool call and its JSON result', () => {
    const messages = transcriptToPiMessages([
      assistantToolMessage({
        type: 'dynamic-tool',
        toolName: 'read',
        toolCallId: 'read-1',
        state: 'output-available',
        input: { path: '/home/project/src/app.ts' },
        output: toolSuccess('Read file', { content: 'const answer = 42;' }),
      }),
    ]);

    expect(messages).toMatchObject([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'read-1',
            name: 'read',
            arguments: { path: '/home/project/src/app.ts' },
          },
        ],
        model: 'pi-bridge',
        stopReason: 'stop',
      },
      {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read',
        content: [{ type: 'text', text: JSON.stringify(toolSuccess('Read file', { content: 'const answer = 42;' })) }],
        isError: false,
      },
    ]);
  });

  it('marks a failed tool result as an error carrying its error text', () => {
    const messages = transcriptToPiMessages([
      assistantToolMessage({
        type: 'dynamic-tool',
        toolName: 'exec',
        toolCallId: 'exec-1',
        state: 'output-error',
        input: { command: 'rm -rf /' },
        errorText: 'User denied execution',
      }),
    ]);

    expect(messages.at(-1)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'exec-1',
      toolName: 'exec',
      content: [{ type: 'text', text: 'User denied execution' }],
      isError: true,
    });
  });

  it('preserves tool-result ordering before later assistant text', () => {
    const messages = transcriptToPiMessages([
      {
        id: 'assistant-ordered',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'read',
            toolCallId: 'read-ordered',
            state: 'output-available',
            input: { path: '/home/project/package.json' },
            output: toolSuccess('Read package.json'),
          },
          { type: 'text', text: 'Now I can answer.' },
        ],
      },
    ]);

    expect(messages.map((message) => message.role)).toEqual(['assistant', 'toolResult', 'assistant']);
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Now I can answer.' }],
    });
  });

  it('removes every hidden reasoning block before the transcript returns to the model', () => {
    const messages = transcriptToPiMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: '<think>private one</think>Visible<think>private two</think> answer',
          },
        ],
      },
    ]);

    expect(messages).toMatchObject([{ role: 'assistant', content: [{ type: 'text', text: 'Visible answer' }] }]);
    expect(messages).toHaveLength(1);
  });
});

describe("transcriptToPiMessages with Claude's signed thinking", () => {
  const claude = { provider: 'cloudflare-ai-gateway', api: 'anthropic-messages', model: 'claude-opus-5-5' };

  /** The assistant message the agent stores from these stream chunks, as it persists it. */
  function storedFromStream(chunks: readonly PiStreamChunk[]): CloudChefMessage {
    const parts: Parameters<typeof applyChunkToParts>[0] = [];
    for (const chunk of chunks) {
      applyChunkToParts(parts, chunk);
    }
    const message = sanitizeMessage({ id: 'assistant-1', role: 'assistant', parts });
    // SAFETY: the parts are the UI message parts the agent stores, which a CloudChef part describes structurally.
    return { id: message.id, role: 'assistant', parts: message.parts as CloudChefPart[] };
  }

  /** The chunks of one tool call that the runner tagged with its model step, through to its result. */
  function toolCallChunks(step: string, id: string, input: { path: string }, output: string): PiStreamChunk[] {
    const providerMetadata = toolStepMetadata(step);
    return [
      { type: 'tool-input-start', toolCallId: id, toolName: 'read_file', dynamic: true, providerMetadata },
      { type: 'tool-input-available', toolCallId: id, toolName: 'read_file', input, dynamic: true, providerMetadata },
      { type: 'tool-output-available', toolCallId: id, output, dynamic: true },
    ];
  }

  it('keeps each response’s signed and redacted thinking with the tool calls it preceded, for the continuation', () => {
    const stored = storedFromStream([
      { type: 'start' },
      // Step one: thinking, a redacted block, a sentence, and two tool calls in one response.
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Read both files.' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: signedThinkingMetadata('s1', claude, 'sig-1') },
      { type: 'reasoning-start', id: 'r2', providerMetadata: redactedThinkingMetadata('s1', claude, 'opaque') },
      { type: 'reasoning-end', id: 'r2', providerMetadata: redactedThinkingMetadata('s1', claude, 'opaque') },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Reading.\n' },
      { type: 'text-end', id: 't1' },
      ...toolCallChunks('s1', 'toolu_a', { path: '/a.ts' }, 'A'),
      ...toolCallChunks('s1', 'toolu_b', { path: '/b.ts' }, 'B'),
      // Step two, after the results: interleaved thinking (empty, as Claude omits it by default) and the answer.
      { type: 'reasoning-start', id: 'r3' },
      { type: 'reasoning-end', id: 'r3', providerMetadata: signedThinkingMetadata('s2', claude, 'sig-2') },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'Both read.' },
      { type: 'text-end', id: 't2' },
    ]);

    expect(transcriptToPiMessages([stored])).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Read both files.', thinkingSignature: 'sig-1' },
          { type: 'thinking', thinking: '', thinkingSignature: 'opaque', redacted: true },
          { type: 'text', text: 'Reading.\n' },
          { type: 'toolCall', id: 'toolu_a', name: 'read_file', arguments: { path: '/a.ts' } },
          { type: 'toolCall', id: 'toolu_b', name: 'read_file', arguments: { path: '/b.ts' } },
        ],
        ...claude,
        timestamp: expect.any(Number),
        usage: expect.any(Object),
        stopReason: 'stop',
      },
      expect.objectContaining({ role: 'toolResult', toolCallId: 'toolu_a', content: [{ type: 'text', text: 'A' }] }),
      expect.objectContaining({ role: 'toolResult', toolCallId: 'toolu_b', content: [{ type: 'text', text: 'B' }] }),
      expect.objectContaining({
        role: 'assistant',
        ...claude,
        content: [
          { type: 'thinking', thinking: '', thinkingSignature: 'sig-2' },
          { type: 'text', text: 'Both read.' },
        ],
      }),
    ]);
  });

  it('keeps a response that thought nothing as its own turn, and an answer after tool calls as the last', () => {
    const stored = storedFromStream([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-end', id: 'r1', providerMetadata: signedThinkingMetadata('s1', claude, 'sig-1') },
      ...toolCallChunks('s1', 'toolu_a', { path: '/a.ts' }, 'A'),
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Next, b.' },
      { type: 'text-end', id: 't1' },
      ...toolCallChunks('s2', 'toolu_b', { path: '/b.ts' }, 'B'),
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'Done.' },
      { type: 'text-end', id: 't2' },
    ]);

    const messages = transcriptToPiMessages([stored]);

    expect(messages.map((message) => [message.role, message.content])).toEqual([
      [
        'assistant',
        [
          { type: 'thinking', thinking: '', thinkingSignature: 'sig-1' },
          expect.objectContaining({ type: 'toolCall', id: 'toolu_a' }),
        ],
      ],
      ['toolResult', [{ type: 'text', text: 'A' }]],
      ['assistant', [{ type: 'text', text: 'Next, b.' }, expect.objectContaining({ type: 'toolCall', id: 'toolu_b' })]],
      ['toolResult', [{ type: 'text', text: 'B' }]],
      ['assistant', [{ type: 'text', text: 'Done.' }]],
    ]);
    // Only the turn with thinking names its model; the others are replayed as any model's.
    expect(messages.flatMap((message) => (message.role === 'assistant' ? [message.model] : []))).toEqual([
      'claude-opus-5-5',
      'pi-bridge',
      'pi-bridge',
    ]);
  });

  it('replays other providers’ reasoning and untagged parts exactly as before', () => {
    const stored = storedFromStream([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'Workers AI thinking' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: '  Reading.  ' },
      { type: 'text-end', id: 't1' },
      {
        type: 'tool-input-available',
        toolCallId: 'call_a',
        toolName: 'read_file',
        input: { path: '/a' },
        dynamic: true,
      },
      { type: 'tool-output-available', toolCallId: 'call_a', output: 'A', dynamic: true },
      {
        type: 'tool-input-available',
        toolCallId: 'call_b',
        toolName: 'read_file',
        input: { path: '/b' },
        dynamic: true,
      },
      { type: 'tool-output-available', toolCallId: 'call_b', output: 'B', dynamic: true },
    ]);

    const messages = transcriptToPiMessages([stored]);

    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['assistant', [{ type: 'text', text: 'Reading.' }, expect.objectContaining({ id: 'call_a' })]],
      ['toolResult', [{ type: 'text', text: 'A' }]],
      ['assistant', [expect.objectContaining({ id: 'call_b' })]],
      ['toolResult', [{ type: 'text', text: 'B' }]],
    ]);
    expect(JSON.stringify(messages)).not.toContain('Workers AI thinking');
    expect(messages.every((message) => message.role !== 'assistant' || message.model === 'pi-bridge')).toBe(true);
  });
});

function assistantToolMessage(part: CloudChefMessage['parts'][number]): CloudChefMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [part],
  };
}
