import { createScopedLogger } from 'cloudchef-agent/utils/logger';

const logger = createScopedLogger('ConversationAgent');

/**
 * A call the agent refuses, with an HTTP-like status and a message the person can read. It is an `Error`, since
 * the Agents SDK replaces anything else thrown from a callable method with "Unknown error occurred", and
 * Workers RPC carries an Error's message to the caller.
 */
export class AgentRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentRefusal';
  }
}

/**
 * Refusals are the agent's expected rejections: log only the status and rethrow unchanged; any other value is
 * left to the caller.
 */
export function rethrowAgentRejection(cause: unknown): void {
  if (cause instanceof AgentRefusal) {
    logger.warn('ConversationAgent refused a call', { status: cause.status });
    throw cause;
  }
}
