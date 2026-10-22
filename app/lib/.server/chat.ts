import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { piAgentRunner, type PiAgentOptions } from '~/lib/.server/llm/pi-agent-runner';
import { createPiStreamResponse } from './llm/pi-stream';
import { ModelInputBudgetExceededError } from './llm/model-input';
import { logProviderFailure } from './llm/provider-error-logging';

const logger = createScopedLogger('api.chat');

/** Runs a builder turn and streams it, answering a failure with the status the browser shows. */
export async function createChatResponse(options: PiAgentOptions) {
  try {
    return createPiStreamResponse(await piAgentRunner(options));
  } catch (error: unknown) {
    logProviderFailure(logger, 'Workers AI chat request failed', error);

    if (error instanceof ModelInputBudgetExceededError) {
      throw new Response(error.message, {
        status: 413,
        statusText: 'Current request is too large',
      });
    }

    throw new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });
  }
}
