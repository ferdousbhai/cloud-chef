const MAX_TURN_IDENTIFIER_LENGTH = 512;

export type BuilderTurnStatus = 'accepted' | 'completed' | 'error' | 'aborted';

/**
 * A turn as the agent records it, from the person's message until the run it started settles: what it ends (its
 * publication, its title), and which pi-durable operation it waits for, kept so a restarted agent waits for it again.
 */
export type BuilderTurnState = {
  id: string;
  requestId: string;
  status: BuilderTurnStatus;
  /** The pi-durable operation the turn waits for: the person's message, or the request sent again after a handoff. */
  operationId?: string;
  /** A handoff ended the running work: the person's latest request is sent again in the fresh context. */
  continueAfterHandoff?: boolean;
  /** The turn already handed off once after the provider said its context was too long. */
  overflowHandedOff?: boolean;
  startedAt?: number;
};

export function createBuilderTurn(requestId: string | undefined): BuilderTurnState {
  return {
    id: crypto.randomUUID(),
    requestId: boundedIdentifier(requestId, crypto.randomUUID()),
    status: 'accepted',
    startedAt: Date.now(),
  };
}

export function completeBuilderTurn(turn: BuilderTurnState, result: { status: BuilderTurnStatus }): BuilderTurnState {
  return { ...turn, status: result.status, continueAfterHandoff: false };
}

function boundedIdentifier(value: string | undefined, fallback: string): string {
  return value ? value.slice(0, MAX_TURN_IDENTIFIER_LENGTH) : fallback;
}
