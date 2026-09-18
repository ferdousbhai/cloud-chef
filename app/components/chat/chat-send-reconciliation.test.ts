import { describe, expect, it } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { advanceTranscriptCheckpoint } from 'cloudchef-agent/transcript';
import { loadAuthoritativeTranscriptSnapshot, reconcileMessagesForSend } from './chat-send-reconciliation';

describe('reconcileMessagesForSend', () => {
  it('keeps local messages that match the durable checkpoint', async () => {
    const localMessages = [message('local')];
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, localMessages);

    expect(
      await reconcileMessagesForSend({
        snapshot: { checkpoint, messages: localMessages },
        localMessages,
      }),
    ).toBe(localMessages);
  });

  it('adopts the authoritative snapshot when local hydration is stale', async () => {
    const authoritativeMessages = [message('durable')];
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, authoritativeMessages);

    expect(
      await reconcileMessagesForSend({
        snapshot: { checkpoint, messages: authoritativeMessages },
        localMessages: [],
      }),
    ).toBe(authoritativeMessages);
  });

  it('validates the snapshot digest and retries one inconsistent read', async () => {
    const durableMessages = [message('durable')];
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, durableMessages);
    let reads = 0;

    await expect(
      loadAuthoritativeTranscriptSnapshot({
        expectedIdentity: identity,
        read: async () => {
          reads += 1;
          return { checkpoint, messages: reads === 1 ? [message('stale')] : durableMessages };
        },
      }),
    ).resolves.toEqual({ checkpoint, messages: durableMessages });
    expect(reads).toBe(2);
  });

  it('rejects malformed, wrong-identity, and persistently inconsistent snapshots', async () => {
    const messages = [message('durable')];
    const checkpoint = await advanceTranscriptCheckpoint(null, identity, messages);

    await expect(
      loadAuthoritativeTranscriptSnapshot({
        expectedIdentity: identity,
        read: async () => ({ checkpoint: { ...checkpoint, agentName: 'other' }, messages }),
      }),
    ).rejects.toThrow(/inconsistent transcript snapshot/i);
    await expect(
      loadAuthoritativeTranscriptSnapshot({
        expectedIdentity: identity,
        read: async () => ({ checkpoint: null, messages }),
      }),
    ).rejects.toThrow(/inconsistent transcript snapshot/i);
    await expect(
      loadAuthoritativeTranscriptSnapshot({
        expectedIdentity: identity,
        read: async () => ({ checkpoint, messages: [{ role: 'assistant', parts: [] }] }),
      }),
    ).rejects.toThrow(/inconsistent transcript snapshot/i);
  });
});

const identity = { agentName: 'agent', generation: 0, subchatIndex: 0 } as const;

function message(id: string): CloudChefMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: id }] };
}
