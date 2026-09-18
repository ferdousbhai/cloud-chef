import { describe, expect, it } from 'vitest';
import {
  applyLineEdits,
  lineAnchoredRead,
  lineEditBaseTag,
  type LineEditOperation,
  lineEditToolParameters,
} from './line-edit.js';

const SHA = 'ab'.repeat(32);

describe('line-anchored editing', () => {
  it('numbers a bounded read and returns a compact snapshot tag for continuation', () => {
    expect(
      lineAnchoredRead({
        path: '/home/project/src/app.ts',
        content: 'one\ntwo\nthree\n',
        sha256: SHA,
        offset: 2,
        limit: 1,
        maxLines: 2_000,
        maxBytes: 256 * 1024,
      }),
    ).toEqual({
      path: '/home/project/src/app.ts',
      base: 'ABABABABABABABABABABABAB',
      content: '2:two',
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      truncated: true,
      nextOffset: 3,
    });
  });

  it('applies replacements and insertions against the same original CRLF snapshot', () => {
    const result = applyLineEdits('one\r\ntwo\r\nthree\r\nfour\r\n', [
      { startLine: 2, endLine: 3, content: 'TWO\nTHREE' },
      { afterLine: 1, content: 'between' },
      { afterLine: 4, content: 'five' },
    ]);

    expect(result).toEqual({
      content: 'one\r\nbetween\r\nTWO\r\nTHREE\r\nfour\r\nfive\r\n',
      editsApplied: 3,
      firstChangedLine: 2,
    });
  });

  it('uses empty replacement content to delete numbered lines', () => {
    expect(applyLineEdits('one\ntwo\nthree', [{ startLine: 2, endLine: 2, content: '' }]).content).toBe('one\nthree');
  });

  it('rejects overlapping operations and out-of-bounds anchors', () => {
    expect(() =>
      applyLineEdits('one\ntwo\nthree', [
        { startLine: 1, endLine: 2, content: 'changed' },
        { afterLine: 1, content: 'inside' },
      ]),
    ).toThrow('overlap');
    expect(() => applyLineEdits('one', [{ afterLine: 2, content: 'later' }])).toThrow('beyond insertion line');
  });

  it.each([
    [{ afterLine: -1, content: 'insert' }, 'edits[0].afterLine must be a non-negative integer.'],
    [{ afterLine: 0.5, content: 'insert' }, 'edits[0].afterLine must be a non-negative integer.'],
    [{ afterLine: 0, content: '' }, 'edits[0] does not delete or insert content.'],
    [{ afterLine: 0, content: 1 }, 'edits[0].content must be a string.'],
    [{ startLine: 0, endLine: 1, content: 'replace' }, 'edits[0].startLine must be a positive integer.'],
    [{ startLine: 1, endLine: 1.5, content: 'replace' }, 'edits[0].endLine must be a positive integer.'],
    [{ startLine: 1, endLine: 1, content: 1 }, 'edits[0].content must be a string.'],
  ] as const)('rejects malformed operations at runtime: %j', (operation, message) => {
    expect(() => applyLineEdits('one\ntwo', [operation as unknown as LineEditOperation])).toThrow(message);
  });

  it('preserves insertion-at-replacement-start behavior', () => {
    expect(
      applyLineEdits('one\ntwo\nthree', [
        { startLine: 2, endLine: 2, content: 'TWO' },
        { afterLine: 1, content: 'between' },
      ]).content,
    ).toBe('one\nbetween\nTWO\nthree');
  });

  it('preserves the complete strict line-edit schema, 24-character base, and 100-operation cap', () => {
    expect(
      lineEditToolParameters.safeParse({
        path: '/home/project/src/app.ts',
        base: lineEditBaseTag(SHA),
        edits: [{ startLine: 1, endLine: 1, content: 'changed' }],
      }).success,
    ).toBe(true);
    expect(
      lineEditToolParameters.safeParse({
        path: '/home/project/src/app.ts',
        base: lineEditBaseTag(SHA),
        edits: [{ afterLine: 0, content: 'first', unexpected: true }],
      }).success,
    ).toBe(false);
    expect(
      lineEditToolParameters.safeParse({
        path: '/home/project/src/app.ts',
        base: lineEditBaseTag(SHA),
        edits: Array.from({ length: 101 }, () => ({ afterLine: 0, content: 'too many' })),
      }).success,
    ).toBe(false);
    expect(
      lineEditToolParameters.safeParse({
        path: '/home/project/src/app.ts',
        edits: [{ oldText: 'one', newText: 'changed' }],
      }).success,
    ).toBe(false);
  });
});
