import { describe, expect, it } from 'vitest';
import { createContextWindowTools } from './context-window-tools';
import type { HistoryEntry } from './context-compaction';

function setup(entries: HistoryEntry[] = []) {
  return { tools: createContextWindowTools({ history: () => entries }) };
}

describe('context window tools', () => {
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
});
