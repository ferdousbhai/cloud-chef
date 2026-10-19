import { describe, expect, test, vi } from 'vitest';
import type { Usage } from '@earendil-works/pi-ai';
import { recordFirstWorkersAiResponse, recordWorkersAiFinish } from './workers-ai-telemetry';

describe('Workers AI prompt-cache telemetry', () => {
  test('records the native Pi usage produced by the agent loop', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    recordWorkersAiFinish({
      usage: usage({ input: 1_000, output: 20, cacheRead: 800, totalTokens: 1_020 }),
      finishReason: 'stop',
      firstUserMessage: false,
      contextReduced: false,
      estimatedContextTokens: 900,
      promptCharacterCounts: { messageHistoryChars: 30, currentTurnChars: 20, totalPromptChars: 60 },
      providerModel: '@cf/zai-org/glm-5.2',
      startedAt: Date.now(),
    });

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020 },
        durationMs: expect.any(Number),
        promptCache: { attempted: true, status: 'hit', cachedInputTokens: 800 },
      }),
    );
    const loggedEvent = info.mock.calls[0]?.[0];
    expect(loggedEvent).not.toHaveProperty('chatInitialId');
    expect(loggedEvent).not.toHaveProperty('modelInputFingerprint');
    info.mockRestore();
  });

  test('records first-response latency without a chat-linkable identifier', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    recordFirstWorkersAiResponse(Date.now());

    expect(info).toHaveBeenCalledWith({
      event: 'workers_ai_first_response',
      timeToFirstResponseMs: expect.any(Number),
      platform: 'Cloudflare AI',
    });
    expect(info.mock.calls[0]?.[0]).not.toHaveProperty('chatInitialId');
    info.mockRestore();
  });
});

function usage(overrides: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}
