import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAgentSocketOpen, type AgentSocketLike } from './agent-connection';

class FakeAgentSocket extends EventTarget implements AgentSocketLike {
  OPEN = 1;
  readyState = 0;
  connectionError = null;
}

describe('waitForAgentSocketOpen', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the socket to open', async () => {
    const agent = new FakeAgentSocket();
    const ready = waitForAgentSocketOpen(agent, 100);
    let resolved = false;
    ready.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    agent.readyState = agent.OPEN;
    agent.dispatchEvent(new Event('open'));

    await expect(ready).resolves.toBeUndefined();
  });

  it('rejects if a known socket never opens', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentSocket();
    const ready = waitForAgentSocketOpen(agent, 100);
    const rejection = expect(ready).rejects.toThrow('CloudChef could not connect to the builder');

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });
});
