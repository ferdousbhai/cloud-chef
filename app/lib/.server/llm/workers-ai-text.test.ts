import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class AgentTurnError extends Error {
    constructor(
      message: string,
      readonly statusCode?: number,
    ) {
      super(message);
    }
  }
  return {
    AgentTurnError,
    completeText: vi.fn(),
    getPiModel: vi.fn(() => ({ model: { id: 'workers-ai-model' }, stream: vi.fn() })),
  };
});
vi.mock('./pi-ai-invoke', () => ({ AgentTurnError: mocks.AgentTurnError, completeText: mocks.completeText }));
vi.mock('./pi-ai-models', () => ({ getPiModel: mocks.getPiModel }));

import { CLOUDFLARE_CONTEXT_SUMMARY_MODEL } from '~/lib/workers-ai-model';
import { summarizeBuilderContext } from './workers-ai-text';

/**
 * Only the failure path reads the catalog, so this is the one binding member these tests exercise.
 */
function cataloguingBinding(models: Ai['models']): Ai {
  // SAFETY: the pi provider is mocked, so nothing in this module reaches any other member of `Ai`.
  return { models } as Ai;
}

describe('summarizeBuilderContext', () => {
  const credentials = { binding: {} as Ai };

  beforeEach(() => vi.clearAllMocks());

  test('returns a trimmed readable summary using the connected account and cancellation signal', async () => {
    mocks.completeText.mockResolvedValue('  current state  ');
    const signal = new AbortController().signal;
    await expect(summarizeBuilderContext('conversation', credentials, signal)).resolves.toBe('current state');
    expect(mocks.getPiModel).toHaveBeenCalled();
    expect(mocks.completeText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal, temperature: 0.1 }),
    );
  });

  test('retries one transient provider failure', async () => {
    mocks.completeText
      .mockRejectedValueOnce(new mocks.AgentTurnError('temporarily unavailable', 503))
      .mockResolvedValueOnce('recovered state');

    await expect(summarizeBuilderContext('conversation', credentials)).resolves.toBe('recovered state');
    expect(mocks.completeText).toHaveBeenCalledTimes(2);
  });

  test('does not retry a deterministic provider failure', async () => {
    mocks.completeText.mockRejectedValue(new mocks.AgentTurnError('invalid request', 400));

    await expect(summarizeBuilderContext('conversation', credentials)).rejects.toThrow(
      'Context compaction generation failed.',
    );
    expect(mocks.completeText).toHaveBeenCalledOnce();
  });

  test('uses a fixed safe error when generation fails', async () => {
    mocks.completeText.mockRejectedValue(new Error('provider detail'));
    await expect(summarizeBuilderContext('conversation', credentials)).rejects.toThrow(
      'Context compaction generation failed.',
    );
  });

  test('names the pinned summary model when the account no longer lists it', async () => {
    mocks.completeText.mockRejectedValue(new Error('provider detail'));

    await expect(
      summarizeBuilderContext('conversation', { binding: cataloguingBinding(async () => []) }),
    ).rejects.toThrow(`The pinned summary model ${CLOUDFLARE_CONTEXT_SUMMARY_MODEL} is no longer listed`);
  });

  test('keeps the generic failure when the diagnostic read itself fails', async () => {
    mocks.completeText.mockRejectedValue(new Error('provider detail'));
    const binding = cataloguingBinding(async () => Promise.reject(new Error('catalog down')));

    // A diagnostic that cannot reach the catalog knows nothing about the pin, so the real failure
    // must not be relabelled as a retirement.
    await expect(summarizeBuilderContext('conversation', { binding })).rejects.toThrow(
      /^Context compaction generation failed\.$/,
    );
  });
});
