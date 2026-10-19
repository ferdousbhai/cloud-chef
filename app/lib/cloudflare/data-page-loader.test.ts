import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const executeDataOperation = vi.hoisted(() => vi.fn());

vi.mock('./client', () => ({ executeDataOperation }));

import { collectDataPages, loadAllChatHistory, loadAllSubchats } from './data-page-loader';

describe('bounded data page loading', () => {
  beforeEach(() => {
    executeDataOperation.mockReset();
  });

  it('drains chat history pages into the existing array contract', async () => {
    const firstItem = {
      id: 'chat-2',
      initialId: 'chat-2',
      timestamp: '2026-02-03T04:05:06.000Z',
    };
    const lastItem = {
      id: 'chat-1',
      initialId: 'chat-1',
      timestamp: '2026-02-02T04:05:06.000Z',
    };
    const cursor = { timestamp: firstItem.timestamp, rowId: 'row-2' };
    executeDataOperation
      .mockResolvedValueOnce({ items: [firstItem], nextCursor: cursor })
      .mockResolvedValueOnce({ items: [lastItem] });

    await expect(loadAllChatHistory('user-1')).resolves.toEqual([firstItem, lastItem]);
    expect(executeDataOperation).toHaveBeenNthCalledWith(
      1,
      'messages.getAll',
      {
        sessionId: 'user-1',
        cursor: undefined,
        limit: 50,
      },
      { signal: undefined },
    );
    expect(executeDataOperation).toHaveBeenNthCalledWith(
      2,
      'messages.getAll',
      {
        sessionId: 'user-1',
        cursor,
        limit: 50,
      },
      { signal: undefined },
    );
  });

  it('returns an empty final page and rejects cursor cycles', async () => {
    const options = {
      maximumItemsPerPage: 2,
      itemKey: (item: number) => item,
      itemSchema: z.number(),
      cursorSchema: z.number(),
      cursorAdvances: (previous: number, next: number) => next > previous,
      validatePageOrder: () => true,
    };
    await expect(collectDataPages(async () => ({ items: [] }), options)).resolves.toEqual([]);

    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], nextCursor: 1 })
      .mockResolvedValueOnce({ items: [2], nextCursor: 2 })
      .mockResolvedValueOnce({ items: [3], nextCursor: 1 });
    await expect(collectDataPages(loadPage, options)).rejects.toThrow('Data pagination did not advance');
  });

  it('rejects malformed, oversized, and duplicate pages', async () => {
    const item = {
      id: 'chat-1',
      initialId: 'chat-1',
      timestamp: '2026-02-03T04:05:06.000Z',
    };
    executeDataOperation.mockResolvedValueOnce({ items: 'not-an-array' });
    await expect(loadAllChatHistory('user-1')).rejects.toThrow('Data pagination returned a malformed page');

    executeDataOperation.mockResolvedValueOnce({ items: Array.from({ length: 51 }, () => item) });
    await expect(loadAllChatHistory('user-1')).rejects.toThrow('Data pagination returned an oversized page');

    executeDataOperation
      .mockResolvedValueOnce({
        items: [item],
        nextCursor: { timestamp: item.timestamp, rowId: 'row-1' },
      })
      .mockResolvedValueOnce({ items: [item] });
    await expect(loadAllChatHistory('user-1')).rejects.toThrow('Data pagination returned a duplicate item');
  });

  it('rejects empty continuation pages and cursors that move in the wrong direction', async () => {
    executeDataOperation.mockResolvedValueOnce({ items: [], nextCursor: { subchatIndex: 1 } });
    await expect(loadAllSubchats('chat-1', 'user-1')).rejects.toThrow('Data pagination returned a malformed cursor');

    const subchat = (subchatIndex: number) => ({
      subchatIndex,
      updatedAt: subchatIndex,
      transcript: { agentName: `agent-${subchatIndex}`, generation: 0, subchatIndex },
    });
    executeDataOperation
      .mockResolvedValueOnce({ items: [subchat(1)], nextCursor: { subchatIndex: 1 } })
      .mockResolvedValueOnce({ items: [subchat(2)], nextCursor: { subchatIndex: 0 } });
    await expect(loadAllSubchats('chat-1', 'user-1')).rejects.toThrow('Data pagination returned an out-of-order page');
  });

  it('rejects page rows that do not match the cursor ordering contract', async () => {
    const subchat = (subchatIndex: number) => ({
      subchatIndex,
      updatedAt: subchatIndex,
      transcript: { agentName: `agent-${subchatIndex}`, generation: 0, subchatIndex },
    });
    executeDataOperation.mockResolvedValueOnce({
      items: [subchat(2), subchat(1)],
      nextCursor: { subchatIndex: 1 },
    });

    await expect(loadAllSubchats('chat-1', 'user-1')).rejects.toThrow('Data pagination returned an out-of-order page');
  });

  it('accumulates long histories iteratively without imposing a silent total cap', async () => {
    const pageCount = 500;
    const loadPage = vi.fn(async (cursor: number | undefined) => {
      const item = cursor ?? 0;
      return {
        items: [item],
        nextCursor: item + 1 < pageCount ? item + 1 : undefined,
      };
    });

    await expect(
      collectDataPages(loadPage, {
        maximumItemsPerPage: 1,
        itemKey: (item) => item,
        itemSchema: z.number(),
        cursorSchema: z.number(),
        cursorAdvances: (previous, next) => next > previous,
        validatePageOrder: () => true,
      }),
    ).resolves.toEqual(Array.from({ length: pageCount }, (_, index) => index));
    expect(loadPage).toHaveBeenCalledTimes(pageCount);
  });
});
