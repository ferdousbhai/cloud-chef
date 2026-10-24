import { describe, expect, it } from 'vitest';
import { logicalLines, readFileLines, replaceText } from './file-edit.js';

const LIMITS = { maxLines: 10_000, maxBytes: 1024 * 1024 };

describe('readFileLines', () => {
  it('returns plain text, and where to continue a bounded read', () => {
    expect(
      readFileLines({ path: '/home/project/a.ts', content: 'one\r\ntwo\r\nthree\r\n', limit: 2, ...LIMITS }),
    ).toEqual({
      path: '/home/project/a.ts',
      content: 'one\ntwo',
      startLine: 1,
      endLine: 2,
      totalLines: 3,
      truncated: true,
      nextOffset: 3,
    });
    expect(readFileLines({ path: 'b', content: 'one\ntwo\n', offset: 2, ...LIMITS }).content).toBe('two');
  });

  it('reads an empty file, and refuses an offset past the end', () => {
    expect(readFileLines({ path: 'e', content: '', ...LIMITS })).toMatchObject({ content: '', totalLines: 0 });
    expect(() => readFileLines({ path: 'e', content: 'a\n', offset: 3, ...LIMITS })).toThrow('beyond end of content');
  });

  it('stops at the byte cap', () => {
    const result = readFileLines({ path: 'c', content: 'aaaa\nbbbb\ncccc\n', maxLines: 100, maxBytes: 10 });
    expect(result).toMatchObject({ content: 'aaaa\nbbbb', truncated: true, nextOffset: 3 });
  });
});

describe('logicalLines', () => {
  it('drops a BOM and treats a lone CR as a break only in a file without LF', () => {
    expect(logicalLines('﻿a\r\nb')).toEqual(['a', 'b']);
    expect(logicalLines('a\rb\r')).toEqual(['a', 'b']);
    expect(logicalLines('x = "\r";\ny\n')).toEqual(['x = "\r";', 'y']);
  });
});

describe('replaceText', () => {
  it('replaces a unique occurrence', () => {
    expect(replaceText('const a = 1;\nconst b = 2;\n', 'b = 2', 'b = 3')).toEqual({
      content: 'const a = 1;\nconst b = 3;\n',
      replacements: 1,
    });
  });

  it('refuses text that is missing or ambiguous, unless every occurrence is asked for', () => {
    expect(() => replaceText('a\nb\n', 'c', 'd')).toThrow('not found');
    expect(() => replaceText('x\nx\n', 'x', 'y')).toThrow('occurs 2 times');
    expect(replaceText('x\nx\n', 'x', 'y', true)).toEqual({ content: 'y\ny\n', replacements: 2 });
  });

  it('matches LF text against a CRLF file and keeps its line breaks', () => {
    expect(replaceText('a\r\nb\r\nc\r\n', 'a\nb', 'A\nB').content).toBe('A\r\nB\r\nc\r\n');
  });

  it('inserts replacement text literally', () => {
    expect(replaceText('a', 'a', '$&$&').content).toBe('$&$&');
  });
});
