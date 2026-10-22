import { describe, expect, it } from 'vitest';
import { dataOperationArgSchemas } from './data-operation-schemas';

describe('data operation argument bounds', () => {
  it('rejects empty or oversized identifiers and descriptions', () => {
    expect(
      dataOperationArgSchemas['messages.setDescription'].safeParse({
        id: '',
        description: 'Title',
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['messages.initializeChat'].safeParse({
        id: 'x'.repeat(513),
      }).success,
    ).toBe(false);
    expect(
      dataOperationArgSchemas['messages.setDescription'].safeParse({
        id: 'chat-1',
        description: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });

  it('bounds the subchat index', () => {
    const args = { chatId: 'chat-1', description: 'Title' };
    expect(
      dataOperationArgSchemas['subchats.setDescription'].safeParse({ ...args, subchatIndex: 10_000 }).success,
    ).toBe(true);
    expect(
      dataOperationArgSchemas['subchats.setDescription'].safeParse({ ...args, subchatIndex: 10_001 }).success,
    ).toBe(false);
  });
});
