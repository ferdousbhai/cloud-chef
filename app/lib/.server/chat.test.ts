import { beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ error: vi.fn() }));
const piAgentRunner = vi.hoisted(() => vi.fn());

vi.mock('cloudchef-agent/utils/logger', () => ({ createScopedLogger: () => logger }));
vi.mock('~/lib/.server/llm/pi-agent-runner', () => ({ piAgentRunner }));

import { createChatResponse } from './chat';
import { ModelInputBudgetExceededError } from './llm/model-input';
import { PiSteeringQueue } from './llm/pi-steering';
import { DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import type { WorkersAiGatewayLogging } from './llm/workers-ai-gateway';

describe('chat provider error boundary', () => {
  beforeEach(() => {
    logger.error.mockReset();
    piAgentRunner.mockReset();
  });

  it('does not log provider errors or request bodies', async () => {
    piAgentRunner.mockRejectedValueOnce(
      Object.assign(new Error('provider included private request values'), {
        requestBodyValues: { prompt: 'SECRET_PROVIDER_PROMPT' },
      }),
    );

    await expect(createResponse()).rejects.toMatchObject({ status: 500 });

    expect(logger.error).toHaveBeenCalledWith('Workers AI chat request failed', { kind: 'Error' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET_PROVIDER_PROMPT');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private request values');
  });

  it.each([[new ModelInputBudgetExceededError(10, 5), 413]])(
    'preserves actionable model-input failures with status %i',
    async (error, status) => {
      piAgentRunner.mockRejectedValueOnce(error);

      await expect(createResponse()).rejects.toMatchObject({ status });
    },
  );

  it('streams the turn in the AI SDK SSE wire protocol the chat client reads', async () => {
    piAgentRunner.mockResolvedValueOnce(
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start' });
          controller.enqueue({ type: 'finish', finishReason: 'stop' });
          controller.close();
        },
      }),
    );

    const response = await createResponse();

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    await expect(response.text()).resolves.toBe(
      'data: {"type":"start"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n',
    );
  });

  it("hands the runner the turn's gateway logging, so an opted-out person's turn stays unlogged", async () => {
    piAgentRunner.mockResolvedValueOnce(new ReadableStream({ start: (controller) => controller.close() }));

    await createResponse(DEFAULT_WORKERS_AI_MODEL, { collectLog: false });

    expect(piAgentRunner).toHaveBeenCalledWith(expect.objectContaining({ gatewayLogging: { collectLog: false } }));
  });
});

function createResponse(
  model = DEFAULT_WORKERS_AI_MODEL,
  gatewayLogging: WorkersAiGatewayLogging = { collectLog: true },
) {
  return createChatResponse({
    gatewayLogging,
    messages: [],
    model,
    firstUserMessage: true,
    compaction: { current: null, pending: false, save: vi.fn(), schedule: vi.fn(), requestDurableCompaction: vi.fn() },
    accountCredentials: { binding: {} as Ai },
    sessionAffinity: 'session',
    workspace: {} as never,
    runWithKeepAlive: (operation) => operation(),
    ...steering(),
  });
}

function steering() {
  return { steering: new PiSteeringQueue(), onSettled: vi.fn() };
}
