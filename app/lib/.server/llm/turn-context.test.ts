import { describe, expect, test } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from 'cloudchef-agent/context-limits';
import { chatTurnContextSchema } from 'cloudchef-agent/turn-context';
import { injectTurnContext } from './turn-context';

describe('injectTurnContext', () => {
  test('prepends context to the latest user message without changing the transcript', () => {
    const messages: CloudChefMessage[] = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Working' }] },
    ];

    const result = injectTurnContext(messages, {
      version: 1,
      content: 'src/index.ts',
    });

    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('src/index.ts') });
    expect(result[1]).toBe(messages[1]);
    expect(messages[0].parts).toEqual([{ type: 'text', text: 'Build it' }]);
  });

  test('rejects an oversized client context payload', () => {
    expect(
      chatTurnContextSchema.safeParse({
        version: 1,
        content: 'x'.repeat(MAX_EPHEMERAL_CONTEXT_CHARACTERS + 1),
      }).success,
    ).toBe(false);
  });
});
