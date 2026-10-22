import { describe, expect, it } from 'vitest';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
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

function assistantToolMessage(part: CloudChefMessage['parts'][number]): CloudChefMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [part],
  };
}
