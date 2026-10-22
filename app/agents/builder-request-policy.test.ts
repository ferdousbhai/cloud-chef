import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import {
  boundBuilderMessageForPersistence,
  loadBuilderTranscriptBinding,
  requireBuilderRequestScope,
  requireBuilderTranscriptIdentity,
  type BuilderTranscriptBinding,
} from './builder-request-policy';

const binding: BuilderTranscriptBinding = {
  agentName: 'chat--transcript-2-0',
  chatInitialId: 'chat',
  subchatIndex: 2,
  parentAgentName: 'chat--transcript-1-0',
};

describe('BuilderAgent request policy', () => {
  it('resolves the Agent name through its active owner-scoped transcript', async () => {
    const first = vi.fn(async () => ({
      agent_name: binding.agentName,
      initial_id: binding.chatInitialId,
      subchat_index: binding.subchatIndex,
      parent_agent_name: binding.parentAgentName,
    }));
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn((_query: string) => ({ bind }));

    await expect(
      loadBuilderTranscriptBinding({ prepare } as unknown as D1Database, {
        agentName: binding.agentName,
        ownerId: 'owner',
      }),
    ).resolves.toEqual(binding);
    expect(bind).toHaveBeenCalledWith(binding.agentName, 'owner');
    expect(prepare.mock.calls[0]?.[0]).toContain('chats.is_deleted = 0');
  });

  it('accepts only an exact D1-bound chat and subchat, naming them from the binding', () => {
    // What the browser still sends for the chat and subchat is not read.
    const body = {
      chatInitialId: 'other-chat',
      subchatIndex: 0,
      modelId: '@cf/zai-org/glm-5.3-flash',
      transcript: { agentName: binding.agentName, subchatIndex: 2 },
    };
    expect(requireBuilderRequestScope(body, binding)).toEqual({
      chatInitialId: 'chat',
      subchatIndex: 2,
      modelId: '@cf/zai-org/glm-5.3-flash',
      transcript: { agentName: binding.agentName, subchatIndex: 2 },
    });
  });

  it.each(['@cf/deepseek-ai/deepseek-v4-flash-0731', 'anthropic/claude-opus-5-5', 'openrouter/openai/gpt-5:free'])(
    "accepts a well-formed Workers AI or gateway provider's model id (%s), which the turn then confirms is offered",
    (modelId) => {
      expect(
        requireBuilderRequestScope(
          {
            modelId,
            transcript: { agentName: binding.agentName, subchatIndex: 2 },
          },
          binding,
        ).modelId,
      ).toBe(modelId);
    },
  );

  it('carries a chosen reasoning effort, and none for the provider default', () => {
    const scope = (reasoningLevel: string | null | undefined) =>
      requireBuilderRequestScope(
        {
          modelId: 'anthropic/claude-opus-5-5',
          transcript: { agentName: binding.agentName, subchatIndex: 2 },
          reasoningLevel,
        },
        binding,
      );
    expect(scope('xhigh').reasoningLevel).toBe('xhigh');
    expect(scope(undefined).reasoningLevel).toBeUndefined();
    expect(scope(null).reasoningLevel).toBeUndefined();
  });

  it.each([
    [{ reasoningLevel: 'off' }, 400],
    [{ reasoningLevel: 'none' }, 400],
    [{ reasoningLevel: 'turbo' }, 400],
    [{ reasoningLevel: 3 }, 400],
    [{ modelId: undefined }, 400],
    [{ modelId: 'deepseek/deepseek-v4-pro' }, 400],
    [{ modelId: 'anthropic/' }, 400],
    [{ modelId: 'anthropic/claude Opus 5' }, 400],
    [{ modelId: 'fireworks/kimi-k2' }, 400],
    [{ transcript: { agentName: binding.agentName, subchatIndex: 1 } }, 409],
  ])('rejects mismatched or malformed scope fields: %o', (override, status) => {
    const action = () =>
      requireBuilderRequestScope(
        {
          modelId: '@cf/zai-org/glm-5.3-flash',
          transcript: { agentName: binding.agentName, subchatIndex: 2 },
          ...override,
        },
        binding,
      );

    expect(action).toThrow(expect.objectContaining({ status }));
  });

  it('rejects transcript operations when no active D1 binding exists', () => {
    expect(() => requireBuilderTranscriptIdentity({ agentName: binding.agentName, subchatIndex: 2 }, null)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('bounds direct-client user text without altering assistant tool parts', () => {
    const user = boundBuilderMessageForPersistence({
      id: 'user',
      role: 'user',
      parts: [{ type: 'text', text: 'x'.repeat(MAX_USER_MESSAGE_CHARACTERS + 8_000) }],
    });
    const assistant = {
      id: 'assistant',
      role: 'assistant' as const,
      parts: [
        {
          type: 'dynamic-tool' as const,
          toolName: 'write',
          toolCallId: 'call',
          state: 'input-available' as const,
          input: { content: 'x'.repeat(MAX_USER_MESSAGE_CHARACTERS + 8_000) },
        },
      ],
    } satisfies UIMessage;

    expect(user.parts[0]).toMatchObject({ type: 'text', text: 'x'.repeat(MAX_USER_MESSAGE_CHARACTERS) });
    expect(boundBuilderMessageForPersistence(assistant)).toBe(assistant);
  });
});
