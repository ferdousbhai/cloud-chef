import { describe, expect, it } from 'vitest';
import {
  advanceTranscriptCheckpoint,
  CURRENT_TRANSCRIPT_GENERATION,
  digestTranscriptMessages,
  stripTranscriptBaseMetadata,
  transcriptAgentName,
  transcriptCheckpointMatchesMessages,
  transcriptCheckpointsEqual,
  transcriptIdentitiesEqual,
} from './transcript.js';

describe('transcript identity', () => {
  it('preserves the legacy initial agent name only for the original transcript', () => {
    expect(transcriptAgentName('chat', 0, CURRENT_TRANSCRIPT_GENERATION)).toBe('chat');
    expect(transcriptAgentName('chat', 1, CURRENT_TRANSCRIPT_GENERATION)).toBe('chat--transcript-1-0');
    expect(transcriptAgentName('chat', 0, 2)).toBe('chat--transcript-0-2');
  });

  it('compares every identity field and removes only transport metadata', () => {
    const identity = { agentName: 'chat', generation: 1, subchatIndex: 2 };
    expect(transcriptIdentitiesEqual(identity, { ...identity })).toBe(true);
    expect(transcriptIdentitiesEqual(identity, { ...identity, subchatIndex: 3 })).toBe(false);
    expect(
      stripTranscriptBaseMetadata({
        id: 'message',
        metadata: { cloudchefTranscriptBase: identity, retained: true },
      }),
    ).toEqual({ id: 'message', metadata: { retained: true } });
  });
});

describe('digestTranscriptMessages', () => {
  it('ignores browser-only metadata while detecting transcript changes', async () => {
    const base = [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }];
    const withMetadata = [{ ...base[0], content: 'Hello', createdAt: new Date('2026-01-01T00:00:00Z') }];
    const changed = [{ ...base[0], parts: [{ type: 'text', text: 'Goodbye' }] }];

    await expect(digestTranscriptMessages(withMetadata)).resolves.toBe(await digestTranscriptMessages(base));
    await expect(digestTranscriptMessages(changed)).resolves.not.toBe(await digestTranscriptMessages(base));
  });

  it('advances once for recovered partial output and is idempotent after replay', async () => {
    const identity = { agentName: 'chat', generation: 0, subchatIndex: 0 };
    const initial = await advanceTranscriptCheckpoint(null, identity, [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] },
    ]);
    const recovered = await advanceTranscriptCheckpoint(initial, identity, [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Partial' }] },
    ]);
    const replayed = await advanceTranscriptCheckpoint(recovered, identity, [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build' }] },
      { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Partial' }] },
    ]);

    expect(recovered.revision).toBe(initial.revision + 1);
    expect(replayed).toBe(recovered);
    expect(transcriptCheckpointsEqual(recovered, replayed)).toBe(true);
    await expect(
      transcriptCheckpointMatchesMessages(initial, [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Changed' }] },
      ]),
    ).resolves.toBe(false);
  });
});
