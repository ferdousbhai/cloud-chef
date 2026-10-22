import { describe, expect, it } from 'vitest';
import { conversationCompactionKey } from './index';

describe('conversation compaction policy', () => {
  it('builds stable scope-bound keys', () => {
    expect(conversationCompactionKey({ scope: 'agent/one', throughId: 'message 2', revision: 3 })).toBe(
      'conversation-compaction:agent%2Fone:message%202:3',
    );
  });
});
