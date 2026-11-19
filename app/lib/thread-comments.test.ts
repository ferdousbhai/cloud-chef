import { describe, expect, it } from 'vitest';
import { COULD_NOT_FINISH, formatCommentsList, formatCommentsThread, parseCommentsArguments } from './thread-comments';

const AT = Date.UTC(2026, 10, 18, 9, 30);

describe('cloudchef comments', () => {
  it('reads its arguments, and answers anything else with how to use it', () => {
    expect(parseCommentsArguments([])).toEqual({ op: 'list' });
    expect(parseCommentsArguments(['show', '#3'])).toEqual({ op: 'show', number: 3 });
    expect(parseCommentsArguments(['close', '3', '--changed'])).toEqual({ op: 'close', number: 3, reason: 'changed' });
    expect(parseCommentsArguments(['close', '3', '--not-planned'])).toEqual({
      op: 'close',
      number: 3,
      reason: 'not_planned',
    });
    expect(parseCommentsArguments(['close', '3', '--same-as', '1'])).toEqual({
      op: 'close',
      number: 3,
      reason: 'duplicate',
      sameAs: 1,
    });
    for (const wrong of [['show'], ['show', 'x'], ['close', '3'], ['close', '3', '--same-as'], ['reply', '3']]) {
      expect(parseCommentsArguments(wrong)).toHaveProperty('usage');
    }
  });

  it('lists each thread with who, when, its first comment, replies, and an earlier version', () => {
    const text = formatCommentsList({
      post: '/sara/recipes',
      open: 1,
      threads: [
        {
          number: 1,
          kind: 'comment',
          state: 'open',
          by: 'ben',
          at: AT,
          body: 'The date picker fails\non phones',
          replies: 2,
          earlierVersion: true,
        },
        {
          number: 2,
          kind: 'suggestion',
          state: 'on_its_way',
          by: null,
          at: AT,
          body: 'Tags',
          replies: 1,
          earlierVersion: false,
        },
      ],
    });
    expect(text).toContain(
      '#1 @ben, 2026-11-18 09:30 (open, 2 replies, on an earlier version)\n    The date picker fails\n    on phones',
    );
    expect(text).toContain('#2 someone no longer here, 2026-11-18 09:30 (on its way, 1 reply, a suggested change)');
    expect(formatCommentsList({ post: '/sara/recipes', open: 0, threads: [] })).toBe(
      'No open threads on /sara/recipes.\n',
    );
  });

  it('shows a whole thread, with CloudChef’s replies named as asked by someone', () => {
    const text = formatCommentsThread({
      post: '/sara/recipes',
      thread: {
        number: 3,
        kind: 'comment',
        state: 'closed',
        by: 'ben',
        at: AT,
        body: 'Dark mode?',
        replies: 2,
        earlierVersion: false,
        closeReason: 'duplicate',
        sameAs: 1,
        locked: true,
        suggestion: null,
      },
      replies: [
        { by: 'sara', at: AT, body: 'Same as #1', byAgent: false },
        { by: 'ben', at: AT, body: 'It follows the system setting now.', byAgent: true },
      ],
    });
    expect(text.split('\n')[0]).toBe('#3 on /sara/recipes (closed as the same as #1, locked)');
    expect(text).toContain('CloudChef, asked by @ben, 2026-11-18 09:30:\n    It follows the system setting now.');
  });

  it('says publicly only that CloudChef couldn’t finish, never why', () => {
    expect(COULD_NOT_FINISH).not.toMatch(/error|failed:/i);
  });
});
