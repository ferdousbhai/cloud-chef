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
  agentName: 'chat--transcript-2-3',
  chatInitialId: 'chat',
  generation: 3,
  subchatIndex: 2,
  parentAgentName: 'chat--transcript-1-2',
};

describe('BuilderAgent request policy', () => {
  it('resolves the Agent name through its active owner-scoped transcript', async () => {
    const first = vi.fn(async () => ({
      agent_name: binding.agentName,
      initial_id: binding.chatInitialId,
      generation: binding.generation,
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

  it('accepts only an exact D1-bound chat, subchat, and generation', () => {
    expect(
      requireBuilderRequestScope(
        {
          chatInitialId: 'chat',
          subchatIndex: 2,
          modelId: '@cf/zai-org/glm-5.3-flash',
          transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 2 },
        },
        binding,
      ),
    ).toEqual({
      chatInitialId: 'chat',
      subchatIndex: 2,
      modelId: '@cf/zai-org/glm-5.3-flash',
      transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 2 },
    });
  });

  it.each([
    [{ chatInitialId: 'other-chat' }, 409],
    [{ subchatIndex: 10_001 }, 400],
    [{ modelId: undefined }, 400],
    [{ modelId: 'deepseek/deepseek-v4-pro' }, 400],
    [{ transcript: { agentName: binding.agentName, generation: 4, subchatIndex: 2 } }, 409],
    [{ transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 1 } }, 409],
  ])('rejects mismatched or malformed scope fields: %o', (override, status) => {
    const action = () =>
      requireBuilderRequestScope(
        {
          chatInitialId: 'chat',
          subchatIndex: 2,
          modelId: '@cf/zai-org/glm-5.3-flash',
          transcript: { agentName: binding.agentName, generation: 3, subchatIndex: 2 },
          ...override,
        },
        binding,
      );

    expect(action).toThrow(expect.objectContaining({ status }));
  });

  it('rejects transcript operations when no active D1 binding exists', () => {
    expect(() =>
      requireBuilderTranscriptIdentity({ agentName: binding.agentName, generation: 3, subchatIndex: 2 }, null),
    ).toThrow(expect.objectContaining({ status: 409 }));
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
