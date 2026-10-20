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

    expect(result).toMatchObject({
      content: 'one\r\nbetween\r\nTWO\r\nTHREE\r\nfour\r\nfive\r\n',
      editsApplied: 3,
      firstChangedLine: 2,
      bracketImbalance: [],
    });
  });

  it('shows the lines a range edit removed and flags the brackets it dropped', () => {
    // The real failure: a range that ran two lines too far took the closing `))}` and
    // `</Fragment>` with it, and nothing said so until validation.
    const source = [
      'export function List() {',
      '  return (',
      '    <Fragment>',
      '      {items.map((item) => (',
      '        <p',
      '          className="a"',
      '        >{item}</p>',
      '      ))}',
      '    </Fragment>',
      '  );',
      '}',
      '',
    ].join('\n');

    const result = applyLineEdits(source, [
      { startLine: 6, endLine: 9, content: '          className="b"\n        >{item}</p>' },
    ]);

    expect(result.diff).toBe(
      [
        '@@ original lines 6-9 -> new lines 6-7 @@',
        ' 4:      {items.map((item) => (',
        ' 5:        <p',
        '-6:          className="a"',
        '-7:        >{item}</p>',
        '-8:      ))}',
        '-9:    </Fragment>',
        '+6:          className="b"',
        '+7:        >{item}</p>',
        ' 8:  );',
        ' 9:}',
      ].join('\n'),
    );
    expect(result.bracketImbalance).toEqual([
      '2 more "(" than ")" than before (a dropped ")"?)',
      '1 more "{" than "}" than before (a dropped "}"?)',
    ]);
  });

  it('numbers diff context in the edited file and elides a long replaced region', () => {
    const source = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');

    const result = applyLineEdits(source, [
      { afterLine: 1, content: 'inserted' },
      { startLine: 5, endLine: 30, content: 'short' },
    ]);

    const hunks = result.diff.split(/\n(?=@@)/);
    expect(hunks[0]).toBe(
      ['@@ original after line 1 -> new line 2 @@', ' 1:line 1', '+2:inserted', ' 3:line 2', ' 4:line 3'].join('\n'),
    );
    expect(hunks[1]).toContain('-5:line 5');
    expect(hunks[1]).toContain('… 10 more removed line(s)');
    expect(hunks[1]).toContain('-30:line 30');
    expect(hunks[1]).not.toContain('-13:line 13');
    expect(hunks[1]).toContain('+6:short\n 7:line 31');
    expect(result.bracketImbalance).toEqual([]);
  });

  it('replaces exact text that occurs once, alongside line operations and in CRLF files', () => {
    const result = applyLineEdits('const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n', [
      { oldText: 'b = 2', newText: 'b = 20' },
      { startLine: 3, endLine: 3, content: 'const c = 30;' },
    ]);

    expect(result.content).toBe('const a = 1;\r\nconst b = 20;\r\nconst c = 30;\r\n');
    expect(result.diff).toContain('-2:const b = 2;\n+2:const b = 20;');
  });

  it.each([
    ['a whole line with its newline', 'a\nb\nc\n', { oldText: 'b\n', newText: '' }, 'a\nc\n'],
    ['across lines', 'a\nb\nc\n', { oldText: 'a\nb', newText: 'ab' }, 'ab\nc\n'],
    ['the last line and the final newline', 'a\nb\n', { oldText: 'b\n', newText: 'B\nC\n' }, 'a\nB\nC\n'],
    ['text at the end of a file without a final newline', 'a\nb\nc', { oldText: '\nc', newText: '' }, 'a\nb'],
    ['an insertion written as a replacement', 'a\nc\n', { oldText: 'a\n', newText: 'a\nb\n' }, 'a\nb\nc\n'],
  ] as const)('replaces exact text: %s', (_label, source, operation, expected) => {
    expect(applyLineEdits(source, [operation]).content).toBe(expected);
  });

  it('rejects exact text that is missing or ambiguous instead of guessing where it goes', () => {
    expect(() => applyLineEdits('a\nb\n', [{ oldText: '2:b', newText: 'c' }])).toThrow(
      'edits[0].oldText was not found. Copy it exactly from the latest read',
    );
    expect(() => applyLineEdits('x\nx\n', [{ oldText: 'x', newText: 'y' }])).toThrow('edits[0].oldText occurs 2 times');
    expect(() =>
      applyLineEdits('a\nb\n', [
        { oldText: 'a', newText: 'A' },
        { startLine: 1, endLine: 1, content: 'other' },
      ]),
    ).toThrow('overlap');
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
    expect(
      lineEditToolParameters.safeParse({
        path: '/home/project/src/app.ts',
        base: lineEditBaseTag(SHA),
        edits: [{ oldText: 'one', newText: 'changed' }],
      }).success,
    ).toBe(true);
    expect(
      lineEditToolParameters.safeParse({
        path: '/home/project/src/app.ts',
        base: lineEditBaseTag(SHA),
        edits: [{ oldText: '', newText: 'changed' }],
      }).success,
    ).toBe(false);
    expect(
      lineEditToolParameters.safeParse({
        path: '/home/project/src/app.ts',
        base: lineEditBaseTag(SHA),
        edits: [{ oldText: 'one', newText: 'changed', startLine: 1 }],
      }).success,
    ).toBe(false);
  });
});
