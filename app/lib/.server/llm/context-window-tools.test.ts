import { describe, expect, it, vi } from 'vitest';
import { createContextWindowTools } from './context-window-tools';
import type { HistoryEntry } from './context-compaction';

function setup(entries: HistoryEntry[] = []) {
  const requestRollover = vi.fn();
  return { requestRollover, tools: createContextWindowTools({ history: () => entries, requestRollover }) };
}

describe('context window tools', () => {
  it('queues an authored handoff and rejects an oversized handoff without changing context', async () => {
    const { tools, requestRollover } = setup();
    await tools.new_context.execute('call', { handoff: 'Next: validate revision 42.' });
    expect(requestRollover).toHaveBeenCalledWith('Next: validate revision 42.');
    await expect(tools.new_context.execute('call2', { handoff: 'x'.repeat(6001) })).rejects.toThrow();
    expect(requestRollover).toHaveBeenCalledOnce();
  });

  it('recovers an old entry page by page without losing long tool output', async () => {
    const text = `BUILD_FAILURE ${'x'.repeat(20000)} last diagnostic`;
    const { tools } = setup([{ id: 'old-build', role: 'assistant', text }]);
    const search = await tools.history.execute('s', { op: 'search', query: 'build_failure' });
    expect(search.content).toEqual([{ type: 'text', text: expect.stringContaining('old-build') }]);
    const pages = await Promise.all(
      [0, 8000, 16000].map((offset) => tools.history.execute(`r${offset}`, { op: 'read', id: 'old-build', offset })),
    );
    const data = pages.map((page) => JSON.parse(page.content[0].type === 'text' ? page.content[0].text : '{}'));
    expect(data.map((page) => page.text).join('')).toBe(text);
    expect(data.map((page) => page.nextOffset)).toEqual([8000, 16000, null]);
  });

  it('searches only the supplied conversation and ranks original entries before prior retrievals', async () => {
    const { tools } = setup([
      { id: 'original', role: 'user', text: 'due dates' },
      { id: 'lookup', role: 'toolResult', text: 'due dates', retrieval: true },
    ]);
    const search = await tools.history.execute('s', { op: 'search', query: 'due', limit: 1 });
    expect(search.content[0]).toEqual({ type: 'text', text: expect.stringContaining('original') });
    await expect(tools.history.execute('r', { op: 'read', id: 'another-conversation' })).rejects.toThrow('unavailable');
  });

  it('pages search results so older matching entries remain reachable', async () => {
    const { tools } = setup(
      Array.from({ length: 25 }, (_, index) => ({ id: `entry-${index}`, role: 'user', text: 'todo' })),
    );
    const page = await tools.history.execute('s', { op: 'search', query: 'todo', offset: 20, limit: 10 });
    const data = page.details;
    expect(data).toMatchObject({ totalMatches: 25, nextOffset: null });
    expect(JSON.stringify(data)).toContain('entry-0');
    expect(JSON.stringify(data)).not.toContain('entry-24');
  });

  it('honors cancellation before queuing a context switch', async () => {
    const { tools, requestRollover } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(tools.new_context.execute('n', {}, controller.signal)).rejects.toThrow();
    expect(requestRollover).not.toHaveBeenCalled();
  });
});
