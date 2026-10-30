import { describe, expect, it } from 'vitest';
import {
  ConversationAgentIdentityMismatchError,
  ConversationAgentIdentityRepository,
  conversationAgentIdentitiesEqual,
  type ConversationAgentDurableIdentity,
} from './conversation-agent-identity';

const identity: ConversationAgentDurableIdentity = {
  userId: 'owner-1',
  transcript: {
    agentName: 'chat--transcript-2-0',
    chatInitialId: 'chat',
    conversationIndex: 2,
    parentAgentName: 'chat--transcript-1-0',
  },
};

class TestIdentityStorage {
  row: Record<string, unknown> | null = null;
  transactions = 0;

  readonly sql = {
    exec: <T>(query: string, ...bindings: unknown[]): Iterable<T> => {
      const normalized = query.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT user_id')) {
        return (this.row ? [this.row] : []) as T[];
      }
      if (normalized.startsWith('INSERT INTO builder_identity')) {
        this.row = {
          owner_id: bindings[0],
          user_id: bindings[1],
          agent_name: bindings[2],
          chat_initial_id: bindings[3],
          subchat_index: bindings[4],
          parent_agent_name: bindings[5],
        };
      }
      return [];
    },
  };

  transactionSync<T>(callback: () => T): T {
    this.transactions += 1;
    return callback();
  }
}

describe('ConversationAgent durable identity', () => {
  it('survives object eviction and accepts only an exact immutable replay', () => {
    const storage = new TestIdentityStorage();
    const firstInstance = new ConversationAgentIdentityRepository(storage as never);

    expect(firstInstance.claim(identity)).toEqual(identity);
    expect(storage.transactions).toBe(1);

    const recoveredInstance = new ConversationAgentIdentityRepository(storage as never);
    expect(recoveredInstance.get()).toEqual(identity);
    expect(recoveredInstance.claim(structuredClone(identity))).toEqual(identity);
    expect(storage.transactions).toBe(2);
  });

  it.each([
    { userId: 'owner-2' },
    { transcript: { ...identity.transcript, agentName: 'other-agent' } },
    { transcript: { ...identity.transcript, conversationIndex: 3 } },
  ])('rejects a mismatched replay after the identity is claimed: %o', (override) => {
    const storage = new TestIdentityStorage();
    const repository = new ConversationAgentIdentityRepository(storage as never);
    repository.claim(identity);

    const changed = { ...identity, ...override } as ConversationAgentDurableIdentity;
    expect(conversationAgentIdentitiesEqual(identity, changed)).toBe(false);
    expect(() => repository.claim(changed)).toThrow(ConversationAgentIdentityMismatchError);
  });
});
