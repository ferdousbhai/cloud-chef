import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { piAgentRunner, type PiAgentOptions } from '~/lib/.server/llm/pi-agent-runner';
import { ModelInputBudgetExceededError } from './llm/model-input';
import { logProviderFailure } from './llm/provider-error-logging';

const logger = createScopedLogger('api.chat');

/** Runs a builder turn and streams it, answering a failure with the status the browser shows. */
export async function createChatResponse(options: PiAgentOptions) {
  try {
    const stream = await piAgentRunner(options);
    // Keep the established AI SDK UI stream wire protocol while the model/tool loop runs on Pi.
    // SAFETY: `PiStreamChunk` enumerates exactly the AI SDK UI chunks CloudChef emits, so every chunk
    // on this stream is already a `UIMessageChunk`; only the declared element type has to be restated.
    return createUIMessageStreamResponse({ stream: stream as ReadableStream<UIMessageChunk> });
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
