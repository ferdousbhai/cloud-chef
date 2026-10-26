import { describe, expect, it } from 'vitest';
import { WORKERS_AI_GATEWAY_UNLOGGED, workersAiGatewayLogging, workersAiGatewayOptions } from './workers-ai-gateway';

const conversation = { chat: 'chat-1', user: 'user-1', agent: 'chat-1' };

describe('AI Gateway routing', () => {
  it("logs a request in the account's default gateway, filed under its conversation, when the person allows it", () => {
    expect(workersAiGatewayOptions(workersAiGatewayLogging(true, conversation))).toEqual({
      id: 'default',
      collectLog: true,
      skipCache: true,
      metadata: conversation,
    });
    // Title requests have no conversation to file under, and are logged all the same.
    expect(workersAiGatewayOptions(workersAiGatewayLogging(true))).toEqual({
      id: 'default',
      collectLog: true,
      skipCache: true,
    });
  });

  it('still routes an opted-out request through the gateway, unlogged and carrying nothing that identifies it', () => {
    // Paid models need the gateway for Unified Billing, so it is never skipped.
    expect(workersAiGatewayOptions(workersAiGatewayLogging(false, conversation))).toEqual({
      id: 'default',
      collectLog: false,
      skipCache: true,
    });
    expect(workersAiGatewayLogging(false, conversation)).toEqual(WORKERS_AI_GATEWAY_UNLOGGED);
  });
});
