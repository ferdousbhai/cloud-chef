import { describe, expect, it } from 'vitest';
import { dataOperationArgSchemas } from './data-operation-schemas';

describe('data operation argument bounds', () => {
  it('rejects empty or oversized identifiers and descriptions', () => {
    expect(
      dataOperationArgSchemas['messages.setDescription'].safeParse({
        sessionId: '',
        id: 'chat-1',
        description: 'Title',
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['messages.initializeChat'].safeParse({
        sessionId: 'user-1',
        id: 'x'.repeat(513),
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['messages.setDescription'].safeParse({
        sessionId: 'user-1',
        id: 'chat-1',
        description: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });

  it('bounds the subchat index', () => {
    const args = { sessionId: 'user-1', chatId: 'chat-1', description: 'Title' };
    expect(
      dataOperationArgSchemas['subchats.setDescription'].safeParse({ ...args, subchatIndex: 10_000 }).success,
    ).toBe(true);
    expect(
      dataOperationArgSchemas['subchats.setDescription'].safeParse({ ...args, subchatIndex: 10_001 }).success,
    ).toBe(false);
  });
});
