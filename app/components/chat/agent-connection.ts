const AGENT_SOCKET_OPEN_TIMEOUT_MS = 30_000;
const AGENT_CONNECT_ERROR_MESSAGE = 'Ghostbuild could not connect to the builder. Please try again.';
const AGENT_CONNECTION_LOST_MESSAGE = 'Ghostbuild lost its builder connection. Please try again.';

export type AgentSocketLike = {
  OPEN?: number;
  readyState?: number;
  connectionError?: Error | null;
  addEventListener?(type: 'open' | 'close' | 'error', listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener?(type: 'open' | 'close' | 'error', listener: EventListener): void;
};

export async function waitForAgentSocketOpen(
  agent: AgentSocketLike,
  timeoutMs = AGENT_SOCKET_OPEN_TIMEOUT_MS,
): Promise<void> {
  if (agent.connectionError) {
    throw agent.connectionError;
  }

  // A transport that exposes no socket state, or no listeners to wait on, is the chat transport
  // rather than a socket: there is nothing to wait for and nothing to report.
  if (agent.readyState === undefined) {
    return;
  }

  const openReadyState = agent.OPEN ?? 1;
  if (agent.readyState !== openReadyState) {
    if (!agent.addEventListener || !agent.removeEventListener) {
      return;
    }

    await waitForSocketOpen(agent, timeoutMs);
  }

  if (agent.connectionError) {
    throw agent.connectionError;
  }
}

function waitForSocketOpen(agent: AgentSocketLike, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      agent.removeEventListener?.('open', onOpen);
      agent.removeEventListener?.('close', onClose);
      agent.removeEventListener?.('error', onError);
    };
    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };
    const onOpen = () => finish(resolve);
    const onClose = () => finish(() => reject(new Error(AGENT_CONNECTION_LOST_MESSAGE)));
    const onError = () => finish(() => reject(new Error(AGENT_CONNECT_ERROR_MESSAGE)));

    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error(AGENT_CONNECT_ERROR_MESSAGE)));
    }, timeoutMs);
    agent.addEventListener?.('open', onOpen);
    agent.addEventListener?.('close', onClose);
    agent.addEventListener?.('error', onError);
    const openReadyState = agent.OPEN ?? 1;
    if (agent.readyState === openReadyState) {
      onOpen();
    }
  });
}
