import { describe, expect, it, vi } from 'vitest';
import { advanceTranscriptCheckpoint } from 'cloudchef-agent/transcript';
import { settleBuilderStop } from './builder-stop';

describe('settleBuilderStop', () => {
  it('reconciles the browser transcript before allowing the next send', async () => {
    const messages = [
      { id: 'user-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'Build a game' }] },
      { id: 'assistant-1', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'Partial' }] },
    ];
    const checkpoint = await advanceTranscriptCheckpoint(
      null,
      { agentName: 'agent-1', generation: 0, subchatIndex: 0 },
      messages,
    );
    const order: string[] = [];
    const reconcileMessages = vi.fn(() => order.push('reconcile'));
    const refreshWorkspace = vi.fn(async () => {
      order.push('workspace');
    });

    const result = await settleBuilderStop({
      cancel: async () => ({ checkpoint, messages }),
      reconcileMessages,
      refreshWorkspace,
    });

    expect(result).toEqual({ checkpoint, messages });
    expect(reconcileMessages).toHaveBeenCalledWith(messages);
    expect(order).toEqual(['reconcile', 'workspace']);
  });

  it('rejects an invalid server snapshot instead of opening the send barrier', async () => {
    await expect(
      settleBuilderStop({
        cancel: async () => ({ checkpoint: null, messages: [{ role: 'assistant' }] }),
        reconcileMessages: vi.fn(),
        refreshWorkspace: vi.fn(),
      }),
    ).rejects.toThrow('invalid transcript');
  });
});
