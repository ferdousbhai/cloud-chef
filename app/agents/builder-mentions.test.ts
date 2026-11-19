import { describe, expect, it } from 'vitest';
import {
  BuilderMentionStore,
  finalAssistantText,
  type MentionStart,
  type MentionThread,
  type PendingMention,
  type QuestionSource,
} from './builder-mentions';

const THREAD = '11111111-1111-4111-8111-111111111111';
const COMMENT = '22222222-2222-4222-8222-222222222222';

function memoryKv() {
  type Value = MentionThread | QuestionSource | PendingMention | MentionStart[];
  const values = new Map<string, Value>();
  return {
    get: (key: string) => values.get(key),
    put: (key: string, value: Value) => void values.set(key, value),
    delete: (key: string) => values.delete(key),
  };
}

describe('a mention-started chat', () => {
  it('keeps its thread, its read-only source, and the mention turn until its answer is delivered', () => {
    const store = new BuilderMentionStore(memoryKv());
    expect(store.thread()).toBeNull();
    store.setThread({ threadId: THREAD, number: 4, post: '/sara/recipes', access: 'read' });
    store.setQuestion({ projectId: THREAD, commit: 'a'.repeat(40), post: '/sara/recipes' });
    store.setPending({ threadId: THREAD, commentId: COMMENT, chatId: 'chat' });
    expect(store.thread()?.number).toBe(4);
    expect(store.question()?.commit).toBe('a'.repeat(40));
    store.clearPending(THREAD);
    expect(store.pending()?.commentId).toBe(COMMENT);
    store.clearPending(COMMENT);
    expect(store.pending()).toBeNull();
  });

  it('answers with what the last message ends with after its last tool call', () => {
    expect(
      finalAssistantText([
        { id: '1', role: 'user', parts: [{ type: 'text', text: 'Fix it' }] },
        {
          id: '2',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Looking. ' },
            { type: 'dynamic-tool', toolName: 'exec', toolCallId: 't', state: 'output-available' },
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'Fixed: the picker works on phones ' },
            { type: 'text', text: 'and it is live.' },
          ],
        },
      ]),
    ).toBe('Fixed: the picker works on phones and it is live.');
    expect(
      finalAssistantText([
        {
          id: '2',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Started it.' },
            { type: 'dynamic-tool', toolName: 'exec', toolCallId: 't', state: 'output-error' },
          ],
        },
      ]),
    ).toBe('Started it.');
    expect(finalAssistantText([])).toBe('');
  });

  it('keeps mentions that wait for the chat in the order they came, each once', () => {
    const store = new BuilderMentionStore(memoryKv());
    const start = (commentId: string): MentionStart => ({
      ownerId: 'sara',
      text: 'Fix it',
      commentId,
      thread: { threadId: THREAD, number: 4, post: '/sara/recipes', access: 'edit' },
    });
    const second = '33333333-3333-4333-8333-333333333333';
    expect(store.dequeue()).toBeNull();
    expect(store.enqueue(start(COMMENT))).toBe(true);
    expect(store.enqueue(start(second))).toBe(true);
    expect(store.enqueue(start(COMMENT))).toBe(true);
    expect(store.queued().map((waiting) => waiting.commentId)).toEqual([COMMENT, second]);
    expect(store.dequeue()?.commentId).toBe(COMMENT);
    expect(store.dequeue()?.commentId).toBe(second);
    expect(store.dequeue()).toBeNull();
  });
});
