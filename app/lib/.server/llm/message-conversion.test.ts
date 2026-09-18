import { describe, expect, it } from 'vitest';
import { toolSuccess } from 'cloudchef-agent/tool-result';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { cleanupAssistantMessages } from './message-conversion';

describe('cleanupAssistantMessages', () => {
  it('converts native tool success without a compatibility message shape', async () => {
    const messages = await cleanupAssistantMessages([
      assistantToolMessage({
        type: 'tool-read',
        toolCallId: 'read-1',
        state: 'output-available',
        input: { path: '/home/project/src/app.ts' },
        output: toolSuccess('Read file', { content: 'const answer = 42;' }),
      }),
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'read-1',
            toolName: 'read',
            input: { path: '/home/project/src/app.ts' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'read',
            output: {
              type: 'json',
              value: toolSuccess('Read file', { content: 'const answer = 42;' }),
            },
          },
        ],
      },
    ]);
  });

  it('keeps failed tool output typed through model conversion', async () => {
    const messages = await cleanupAssistantMessages([
      assistantToolMessage({
        type: 'tool-read',
        toolCallId: 'read-error',
        state: 'output-error',
        input: { path: '/home/project/missing.ts' },
        errorText: 'File not found',
      }),
    ]);

    expect(messages).toContainEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'read-error',
          toolName: 'read',
          output: { type: 'error-text', value: 'File not found' },
        },
      ],
    });
  });

  it('preserves tool-result ordering before later assistant text', async () => {
    const messages = await cleanupAssistantMessages([
      {
        id: 'assistant-ordered',
        role: 'assistant',
        parts: [
          {
            type: 'tool-read',
            toolCallId: 'read-ordered',
            state: 'output-available',
            input: { path: '/home/project/package.json' },
            output: toolSuccess('Read package.json'),
          },
          { type: 'text', text: 'Now I can answer.' },
        ],
      },
    ]);

    expect(messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Now I can answer.' }] });
  });

  it('removes every hidden reasoning block before the transcript returns to the model', async () => {
    const messages = await cleanupAssistantMessages([
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: '<think>private one</think>Visible<div class="__cloudchefThought__">private two</div> answer',
          },
        ],
      },
    ]);

    expect(messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Visible answer' }] }]);
  });
});

function assistantToolMessage(part: CloudChefMessage['parts'][number]): CloudChefMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [part],
  };
}
