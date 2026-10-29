import { describe, expect, test, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { recordModelResponse } from './workers-ai-telemetry';

describe('Workers AI prompt-cache telemetry', () => {
  test("records a response's usage, cache hits included, and nothing that links it to a chat", () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const message: AssistantMessage = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'cloudflare-workers-ai',
      model: '@cf/zai-org/glm-5.2',
      content: [{ type: 'text', text: 'Done.' }],
      usage: {
        input: 1_000,
        output: 20,
        cacheRead: 800,
        cacheWrite: 0,
        totalTokens: 1_020,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 1,
      durationMs: 1_500,
    };

    expect(recordModelResponse(message)).toEqual({ inputTokens: 1_000, outputTokens: 20, cachedTokens: 800 });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020 },
        durationMs: 1_500,
        promptCache: { attempted: true, status: 'hit', cachedInputTokens: 800 },
      }),
    );
    expect(info.mock.calls[0]?.[0]).not.toHaveProperty('chatInitialId');
    info.mockRestore();
  });
});
