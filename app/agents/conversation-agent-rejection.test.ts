import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRefusal, rethrowAgentRejection } from './conversation-agent-rejection';

afterEach(() => vi.restoreAllMocks());

describe('rethrowAgentRejection', () => {
  it('logs a refusal by status and rethrows it unchanged, an Error the SDK passes on with its message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rejection = new AgentRefusal('Agent not found.', 404);
    expect(rejection).toBeInstanceOf(Error);

    expect(() => rethrowAgentRejection(rejection)).toThrow(rejection);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[ConversationAgent]'),
      'ConversationAgent refused a call',
      {
        status: 404,
      },
    );
  });

  it('leaves other failures to the default handler', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => rethrowAgentRejection(new Error('boom'))).not.toThrow();
    expect(() => rethrowAgentRejection(new Response('boom', { status: 500 }))).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
