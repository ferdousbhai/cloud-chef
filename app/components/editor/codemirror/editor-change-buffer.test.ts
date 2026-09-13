import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorChangeBuffer } from './editor-change-buffer';
import type { EditorUpdate } from './editor-types';

function update(projectId: string, filePath: string, content: string): EditorUpdate {
  return { projectId, filePath, content, selection: null as never };
}

describe('editor change buffer', () => {
  afterEach(() => vi.useRealTimers());

  it('cannot let typing in a new file cancel the old-file update', async () => {
    vi.useFakeTimers();
    const delivered: EditorUpdate[] = [];
    const buffer = createEditorChangeBuffer(150);

    buffer.queue({ callback: (value) => delivered.push(value), update: update('project-a', '/a.ts', 'a1') });
    buffer.flush();
    buffer.queue({ callback: (value) => delivered.push(value), update: update('project-a', '/b.ts', 'b1') });
    await vi.advanceTimersByTimeAsync(150);

    expect(delivered).toEqual([
      expect.objectContaining({ projectId: 'project-a', filePath: '/a.ts', content: 'a1' }),
      expect.objectContaining({ projectId: 'project-a', filePath: '/b.ts', content: 'b1' }),
    ]);
  });

  it('flushes the original edit exactly once at a flush boundary', async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const buffer = createEditorChangeBuffer(150);
    const original = update('original-project', '/original.ts', 'latest visible content');

    buffer.queue({ callback, update: original });
    buffer.flush();
    buffer.flush();
    await vi.advanceTimersByTimeAsync(150);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(original);
  });

  it('can discard an invalid pending transition without a stale write', async () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const buffer = createEditorChangeBuffer(150);

    buffer.queue({ callback, update: update('project-a', '/binary.png', 'stale text') });
    buffer.cancel();
    await vi.advanceTimersByTimeAsync(150);

    expect(callback).not.toHaveBeenCalled();
  });
});
