import { createScopedLogger } from 'cloudchef-agent/utils/logger';

const logger = createScopedLogger('BuilderAgent');

/**
 * Thrown `Response`s are the agent's expected rejections, which the SDK's
 * default error handler logs as `[object Response]`. Log only the status and
 * rethrow the Response unchanged; any other value is left to the caller.
 */
export function rethrowAgentRejection(cause: unknown): void {
  if (cause instanceof Response) {
    logger.warn('BuilderAgent rejected a call', { status: cause.status });
    throw cause;
  }
}
