import { afterEach, describe, expect, it, vi } from 'vitest';
import { rethrowAgentRejection } from './builder-agent-rejection';

afterEach(() => vi.restoreAllMocks());

describe('rethrowAgentRejection', () => {
  it('logs a thrown Response by status and rethrows it unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rejection = new Response('Agent not found.', { status: 404 });

    expect(() => rethrowAgentRejection(rejection)).toThrow(rejection);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[BuilderAgent]'), 'BuilderAgent rejected a call', {
      status: 404,
    });
  });

  it('leaves other failures to the default handler', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => rethrowAgentRejection(new Error('boom'))).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
