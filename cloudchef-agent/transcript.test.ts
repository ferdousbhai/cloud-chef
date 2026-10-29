import { describe, expect, it } from 'vitest';
import {
  advanceTranscriptCheckpoint,
  transcriptAgentName,
  transcriptChatInitialId,
  transcriptCheckpointsEqual,
  transcriptIdentitiesEqual,
} from './transcript.js';

describe('transcript identity', () => {
  it('names the first subchat by the chat and every other by its index', () => {
    expect(transcriptAgentName('chat', 0)).toBe('chat');
    expect(transcriptAgentName('chat', 1)).toBe('chat--transcript-1-0');
    expect(transcriptChatInitialId(transcriptAgentName('chat', 0))).toBe('chat');
    expect(transcriptChatInitialId(transcriptAgentName('chat', 12))).toBe('chat');
  });

  it('compares every identity field', () => {
    const identity = { agentName: 'chat', subchatIndex: 2 };
    expect(transcriptIdentitiesEqual(identity, { ...identity })).toBe(true);
    expect(transcriptIdentitiesEqual(identity, { ...identity, subchatIndex: 3 })).toBe(false);
  });
});

describe('transcript checkpoints', () => {
  it('ignores browser-only metadata while detecting transcript changes', async () => {
    const identity = { agentName: 'chat', subchatIndex: 0 };
    const digest = async (messages: Parameters<typeof advanceTranscriptCheckpoint>[2]) =>
      (await advanceTranscriptCheckpoint(null, identity, messages)).digest;
    const base = [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }];
    const withMetadata = [{ ...base[0], content: 'Hello', createdAt: new Date('2026-01-01T00:00:00Z') }];
    const changed = [{ ...base[0], parts: [{ type: 'text', text: 'Goodbye' }] }];

    await expect(digest(withMetadata)).resolves.toBe(await digest(base));
    await expect(digest(changed)).resolves.not.toBe(await digest(base));
  });

  it('advances once for recovered partial output and is idempotent after replay', async () => {
    const identity = { agentName: 'chat', subchatIndex: 0 };
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
  });
});
