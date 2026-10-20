/** What a request's AI Gateway log is filed under, to find a conversation's requests: at most five keys. */
export type WorkersAiGatewayMetadata = Partial<Record<'chat' | 'user' | 'agent', string>>;

/**
 * Whether a request is logged with its content (prompts, conversation context, project files sent,
 * the model's reply) in the account's AI Gateway: the person's own choice, made in Settings. A logged
 * request may say what its log is filed under; an unlogged one sends nothing that identifies it.
 */
export type WorkersAiGatewayLogging = { collectLog: false } | { collectLog: true; metadata?: WorkersAiGatewayMetadata };

export const WORKERS_AI_GATEWAY_UNLOGGED: WorkersAiGatewayLogging = { collectLog: false };

/** The logging a request gets from the person's choice, filed under `metadata` when it is logged. */
export function workersAiGatewayLogging(
  contentLogging: boolean,
  metadata?: WorkersAiGatewayMetadata,
): WorkersAiGatewayLogging {
  if (!contentLogging) {
    return WORKERS_AI_GATEWAY_UNLOGGED;
  }
  return metadata ? { collectLog: true, metadata } : { collectLog: true };
}

export type WorkersAiGatewayOptions = {
  id: string;
  collectLog: boolean;
  skipCache: boolean;
  metadata?: WorkersAiGatewayMetadata;
};

/**
 * Every model request goes through the account's default AI Gateway, and paid models need it, for
 * Unified Billing credits. A request the person lets be logged is logged there: requests and responses
 * stay in the connected account, beside its transcripts, so the account can review what a conversation
 * sent and got back. Caching stays off: a builder turn is never a repeat.
 */
export function workersAiGatewayOptions(logging: WorkersAiGatewayLogging): WorkersAiGatewayOptions {
  if (!logging.collectLog) {
    return { id: 'default', collectLog: false, skipCache: true };
  }
  const options: WorkersAiGatewayOptions = { id: 'default', collectLog: true, skipCache: true };
  if (logging.metadata) {
    options.metadata = logging.metadata;
  }
  return options;
}
