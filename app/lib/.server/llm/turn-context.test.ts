import { describe, expect, test } from 'vitest';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from 'cloudchef-agent/context-limits';
import { chatTurnContextSchema } from 'cloudchef-agent/turn-context';
import { withTurnContext } from './turn-context';

describe('withTurnContext', () => {
  test('puts the workspace context ahead of the text, marked as data', () => {
    const content = withTurnContext('Build it', { version: 1, content: 'src/index.ts' });

    expect(content).toContain('<cloudchef_ephemeral_context>\nsrc/index.ts\n</cloudchef_ephemeral_context>');
    expect(content.endsWith('\n\nBuild it')).toBe(true);
  });

  test('sends the text alone without context', () => {
    expect(withTurnContext('Build it', undefined)).toBe('Build it');
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
