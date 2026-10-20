import { describe, expect, it } from 'vitest';
import { streamedToolInput } from './streaming-tool-input';

describe('streamedToolInput', () => {
  it('reads the path from the partially decoded object the stream rebuilt', () => {
    expect(streamedToolInput({ input: { path: '/home/project/src/routes/index.tsx', content: 'export' } })).toEqual({
      path: '/home/project/src/routes/index.tsx',
      characters: 6,
    });
  });

  it('reads the path out of raw JSON that is still being written', () => {
    expect(streamedToolInput({ input: '{"path": "/home/project/app.ts", "content": "const a = 1' })).toMatchObject({
      path: '/home/project/app.ts',
    });
  });

  it('decodes an escaped path', () => {
    expect(streamedToolInput({ input: '{"path":"/home/project/a\\"b.ts"' }).path).toBe('/home/project/a"b.ts');
  });

  it('has no path until the path itself has finished streaming', () => {
    expect(streamedToolInput({ input: '{"path": "/home/project/src/rou' }).path).toBeNull();
    expect(streamedToolInput({ input: '{' }).path).toBeNull();
    expect(streamedToolInput({ input: { content: 'no path yet' } }).path).toBeNull();
    expect(streamedToolInput({ input: undefined })).toEqual({ path: null, characters: 0 });
  });

  it('counts every edit operation written so far', () => {
    expect(
      streamedToolInput({
        input: {
          path: '/home/project/a.ts',
          edits: [{ content: 'one' }, { content: 'three' }, { afterLine: 2 }, { oldText: 'x', newText: 'four' }],
        },
      }).characters,
    ).toBe(12);
  });

  it('counts the raw prefix while nothing has been decoded yet', () => {
    expect(streamedToolInput({ input: '{"path"' }).characters).toBe(7);
    expect(streamedToolInput({ input: { path: '/home/project/a.ts' } }).characters).toBe(0);
  });
});
