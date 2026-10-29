import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai';
import {
  contextTokens,
  HANDOFF_REQUEST,
  handoffOpening,
  handoffRequestMessages,
  handoffThresholdTokens,
  hasWorkToHandOff,
  isOverflow,
} from './handoff';

function usage(input: number): Usage {
  return {
    input,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function answer(
  input: number,
  stopReason: AssistantMessage['stopReason'] = 'stop',
  errorMessage?: string,
): AssistantMessage {
  const message: AssistantMessage = {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'cloudflare-ai-gateway',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'ok' }],
    usage: usage(input),
    stopReason,
    timestamp: 1,
  };
  if (errorMessage) {
    message.errorMessage = errorMessage;
  }
  return message;
}

const ask = (content: string): Message => ({ role: 'user', content, timestamp: 1 });

describe('handoff', () => {
  it("measures the context by the newest response's reported usage, plus what came after it", () => {
    const after = ask('x'.repeat(400));
    expect(contextTokens([ask('hi'), answer(10_000), after])).toBe(
      10_100 + Math.ceil(JSON.stringify(after).length / 4),
    );
    // A failed response reports nothing to count on.
    expect(contextTokens([ask('hi'), answer(50_000), answer(0, 'error')])).toBeGreaterThan(50_000);
  });

  it("hands off at pi's own blocking point, and at the start of a turn with room to work", () => {
    expect(handoffThresholdTokens(200_000, 'step')).toBe(200_000 - 16_384);
    expect(handoffThresholdTokens(200_000, 'turn_start')).toBe(200_000 - 16_384 - 20_000);
    // A small window keeps proportionally less for itself.
    expect(handoffThresholdTokens(32_000, 'turn_start')).toBe(32_000 - 8_000 - 4_000);
  });

  it('asks for the note after the conversation, without the failed response that started it', () => {
    const system: Message = { role: 'system', content: 'You are CloudChef.', timestamp: 1 };
    const overflow = answer(0, 'error', 'prompt is too long: 210000 tokens > 200000 maximum');
    const request = handoffRequestMessages([system, ask('Build it'), answer(1_000), overflow], 1_000_000);

    expect(request.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(request.at(-1)).toMatchObject({ content: HANDOFF_REQUEST });
  });

  it('leaves out the oldest messages after the first when the conversation is over the budget, and says so', () => {
    const big = (index: number) => ask(`${index} ${'x'.repeat(4_000)}`);
    const request = handoffRequestMessages([big(1), big(2), big(3), big(4), big(5)], 3_000);

    expect(request[0]).toEqual(big(1));
    expect(request.at(-2)).toEqual(big(5));
    expect(request.length).toBeLessThan(6);
    expect(request.at(-1)).toMatchObject({
      content: expect.stringContaining('Some of the oldest messages were left out'),
    });
  });

  it('frames the note as what it is, and knows an overflow from another failure', () => {
    expect(handoffOpening('## Done\n- the form')).toContain('<handoff_note>\n## Done\n- the form\n</handoff_note>');
    const overflow = answer(0, 'error', 'prompt is too long: 210000 tokens > 200000 maximum');
    expect(isOverflow(overflow, 200_000)).toBe(true);
    expect(isOverflow(answer(0, 'error', 'rate limited'), 200_000)).toBe(false);
    expect(hasWorkToHandOff([ask('only the question')])).toBe(false);
    expect(hasWorkToHandOff([ask('question'), answer(10)])).toBe(true);
  });
});
