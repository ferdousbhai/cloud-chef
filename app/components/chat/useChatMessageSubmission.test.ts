import { describe, expect, it, vi } from 'vitest';
import { runChatSubmissionLifecycle } from './useChatMessageSubmission';

describe('runChatSubmissionLifecycle', () => {
  it('discards a newly created draft when preflight fails before dispatch', async () => {
    const discardEmptyWorkspace = vi.fn().mockResolvedValue(undefined);

    await expect(
      runChatSubmissionLifecycle({
        initializeWorkspace: async () => ({ created: true }),
        discardEmptyWorkspace,
        onStartChat: vi.fn(),
        onBuilderRequestStart: vi.fn(),
        submit: async () => {
          throw new Error('connection failed');
        },
      }),
    ).rejects.toThrow('connection failed');

    expect(discardEmptyWorkspace).toHaveBeenCalledOnce();
  });

  it('keeps the chat once the builder request has been dispatched', async () => {
    const discardEmptyWorkspace = vi.fn().mockResolvedValue(undefined);

    await expect(
      runChatSubmissionLifecycle({
        initializeWorkspace: async () => ({ created: true }),
        discardEmptyWorkspace,
        onStartChat: vi.fn(),
        onBuilderRequestStart: vi.fn(),
        submit: async (onRequestStart) => {
          onRequestStart();
          throw new Error('stream failed');
        },
      }),
    ).rejects.toThrow('stream failed');

    expect(discardEmptyWorkspace).not.toHaveBeenCalled();
  });
});
