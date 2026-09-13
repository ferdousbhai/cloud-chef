import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { ChatTurnContext } from 'ghostbuild-agent/turn-context';
import { cleanupAssistantMessages } from './message-conversion';
import { modelMessagesToPi } from './pi-message-conversion';
import { injectTurnContext } from './turn-context';

type PiSteeringReservation = {
  commit(): void;
  reject(error: unknown): void;
};

/** Pi's one-at-a-time steering queue, with persistence committed before delivery. */
export class PiSteeringQueue {
  #pending: Promise<AgentMessage>[] = [];
  #closed = false;

  reserve(message: GhostbuildMessage, turnContext?: ChatTurnContext): PiSteeringReservation | null {
    if (this.#closed) {
      return null;
    }
    const piMessage = toPiSteeringMessage(message, turnContext);
    let resolve!: (message: AgentMessage) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<AgentMessage>((resolveMessage, rejectMessage) => {
      resolve = resolveMessage;
      reject = rejectMessage;
    });
    void promise.catch(() => undefined);
    this.#pending.push(promise);
    return {
      commit: () => resolve(piMessage),
      reject,
    };
  }

  async drain(): Promise<AgentMessage[]> {
    const next = this.#pending.shift();
    return next ? [await next] : [];
  }

  hasPending(): boolean {
    return this.#pending.length > 0;
  }

  close(): void {
    this.#closed = true;
  }
}

function toPiSteeringMessage(message: GhostbuildMessage, turnContext?: ChatTurnContext): AgentMessage {
  const [converted] = modelMessagesToPi(cleanupAssistantMessages(injectTurnContext([message], turnContext)));
  if (!converted || converted.role !== 'user') {
    throw new TypeError('Pi steering requires a user message.');
  }
  return converted;
}
