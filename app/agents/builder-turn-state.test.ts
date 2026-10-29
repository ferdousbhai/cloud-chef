import { describe, expect, it } from 'vitest';
import { completeBuilderTurn, createBuilderTurn } from './builder-turn-state';

describe('builder turn state', () => {
  it('bounds turn identifiers', () => {
    expect(createBuilderTurn('r'.repeat(1_000)).requestId).toHaveLength(512);
  });

  it('ends a turn without carrying a handoff continuation past it', () => {
    const turn = { ...createBuilderTurn('request-1'), continueAfterHandoff: true };

    expect(completeBuilderTurn(turn, { status: 'aborted' })).toMatchObject({
      requestId: 'request-1',
      status: 'aborted',
      continueAfterHandoff: false,
    });
  });
});
