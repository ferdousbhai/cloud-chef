import { describe, expect, it } from 'vitest';
import { applyLiveSubchatTitle } from './subchat-model';

describe('subchat model', () => {
  it('keeps a persisted manual title when a stale generated title is replayed', () => {
    const persisted = [
      {
        subchatIndex: 0,
        updatedAt: 1,
        description: 'Team Voting',
        transcript: transcript(0),
      },
    ];

    expect(applyLiveSubchatTitle(persisted, { subchatIndex: 0, title: 'Pocket Poll' }, transcript(0))).toBe(persisted);
  });

  it('uses a live title while the persisted title is still empty', () => {
    const subchats = [{ subchatIndex: 0, updatedAt: 1, transcript: transcript(0) }];

    expect(
      applyLiveSubchatTitle(subchats, { subchatIndex: 0, title: 'Pocket Poll' }, transcript(0))?.[0]?.description,
    ).toBe('Pocket Poll');
  });
});

function transcript(subchatIndex: number) {
  return { agentName: `chat-${subchatIndex}`, subchatIndex };
}
