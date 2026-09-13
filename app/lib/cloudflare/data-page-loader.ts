import { z } from 'zod';
import { executeDataOperation } from './client';
import { api, type ChatHistorySummary, type SubchatSummary } from './data-api';
import {
  DEFAULT_DATA_PAGE_SIZE,
  MAX_SUBCHAT_INDEX,
  type ChatHistoryCursor,
  type DataPage,
  type SubchatCursor,
} from './data-pagination';

type PageLoader<Item, Cursor> = (cursor: Cursor | undefined) => Promise<DataPage<Item, Cursor>>;

type PageCollectionOptions<Item, Cursor> = {
  signal?: AbortSignal;
  maximumItemsPerPage: number;
  itemKey: (item: Item) => string | number;
  itemSchema: z.ZodType;
  cursorSchema: z.ZodType;
  cursorAdvances: (previous: Cursor, next: Cursor) => boolean;
  validatePageOrder: (items: Item[], previous: Cursor | undefined, next: Cursor | undefined) => boolean;
};

const pageEnvelopeSchema = z.looseObject({ items: z.array(z.unknown()) });

export async function collectDataPages<Item, Cursor>(
  loadPage: PageLoader<Item, Cursor>,
  options: PageCollectionOptions<Item, Cursor>,
): Promise<Item[]> {
  const items: Item[] = [];
  const seenItemKeys = new Set<string | number>();
  const seenCursorKeys = new Set<string>();
  let cursor: Cursor | undefined;

  for (;;) {
    options.signal?.throwIfAborted();
    const page = await loadPage(cursor);
    options.signal?.throwIfAborted();
    if (!pageEnvelopeSchema.safeParse(page).success) {
      throw new Error('Data pagination returned a malformed page');
    }
    if (page.items.length > options.maximumItemsPerPage) {
      throw new Error('Data pagination returned an oversized page');
    }
    for (const item of page.items) {
      if (!options.itemSchema.safeParse(item).success) {
        throw new Error('Data pagination returned a malformed item');
      }
      const key = options.itemKey(item);
      if (seenItemKeys.has(key)) {
        throw new Error('Data pagination returned a duplicate item');
      }
      seenItemKeys.add(key);
      items.push(item);
    }

    if (page.nextCursor === undefined) {
      if (!options.validatePageOrder(page.items, cursor, undefined)) {
        throw new Error('Data pagination returned an out-of-order page');
      }
      return items;
    }
    if (page.items.length === 0 || !options.cursorSchema.safeParse(page.nextCursor).success) {
      throw new Error('Data pagination returned a malformed cursor');
    }
    if (!options.validatePageOrder(page.items, cursor, page.nextCursor)) {
      throw new Error('Data pagination returned an out-of-order page');
    }
    if (cursor !== undefined && !options.cursorAdvances(cursor, page.nextCursor)) {
      throw new Error('Data pagination did not advance');
    }

    const cursorKey = stableCursorKey(page.nextCursor);
    if (seenCursorKeys.has(cursorKey)) {
      throw new Error('Data pagination did not advance');
    }
    seenCursorKeys.add(cursorKey);
    cursor = page.nextCursor;
  }
}

export function loadAllChatHistory(sessionId: string, signal?: AbortSignal): Promise<ChatHistorySummary[]> {
  return collectDataPages<ChatHistorySummary, ChatHistoryCursor>(
    (cursor) =>
      executeDataOperation(
        api.messages.getAll,
        {
          sessionId,
          cursor,
          limit: DEFAULT_DATA_PAGE_SIZE,
        },
        { signal },
      ),
    {
      signal,
      maximumItemsPerPage: DEFAULT_DATA_PAGE_SIZE,
      itemKey: (item) => item.initialId,
      itemSchema: chatHistorySummarySchema,
      cursorSchema: chatHistoryCursorSchema,
      cursorAdvances: (previous, next) =>
        next.timestamp < previous.timestamp || (next.timestamp === previous.timestamp && next.rowId < previous.rowId),
      validatePageOrder: (items, previous, next) =>
        isDescendingBy(items, (item) => item.timestamp) &&
        (previous === undefined || items.every((item) => item.timestamp <= previous.timestamp)) &&
        (next === undefined || next.timestamp === items.at(-1)?.timestamp),
    },
  );
}

export function loadAllSubchats(chatId: string, sessionId: string, signal?: AbortSignal): Promise<SubchatSummary[]> {
  return collectDataPages<SubchatSummary, SubchatCursor>(
    (cursor) =>
      executeDataOperation(
        api.subchats.get,
        {
          chatId,
          sessionId,
          cursor,
          limit: DEFAULT_DATA_PAGE_SIZE,
        },
        { signal },
      ),
    {
      signal,
      maximumItemsPerPage: DEFAULT_DATA_PAGE_SIZE,
      itemKey: (item) => item.subchatIndex,
      itemSchema: subchatSummarySchema,
      cursorSchema: subchatCursorSchema,
      cursorAdvances: (previous, next) => next.subchatIndex > previous.subchatIndex,
      validatePageOrder: (items, previous, next) =>
        isStrictlyAscendingBy(items, (item) => item.subchatIndex) &&
        (previous === undefined || items.every((item) => item.subchatIndex > previous.subchatIndex)) &&
        (next === undefined || next.subchatIndex === items.at(-1)?.subchatIndex),
    },
  );
}

const MAX_CURSOR_ROW_ID_LENGTH = 512;

/**
 * Millisecond-precision ISO-8601, round-tripped through `Date` so calendar-invalid inputs the
 * regex alone accepts — February 30th, for instance — are rejected too.
 */
const storedChatTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  });

const subchatIndexSchema = z.number().int().nonnegative().max(MAX_SUBCHAT_INDEX);

const chatHistorySummarySchema = z.looseObject({
  id: z.string().min(1),
  initialId: z.string().min(1),
  timestamp: storedChatTimestampSchema,
  description: z.string().optional(),
});

const subchatSummarySchema = z
  .looseObject({
    subchatIndex: subchatIndexSchema,
    updatedAt: z.number().int(),
    description: z.string().optional(),
    transcript: z.looseObject({
      agentName: z.string().min(1),
      generation: z.number().int().nonnegative(),
      subchatIndex: z.number(),
    }),
  })
  .refine((value) => value.transcript.subchatIndex === value.subchatIndex);

const chatHistoryCursorSchema = z.strictObject({
  rowId: z.string().min(1).max(MAX_CURSOR_ROW_ID_LENGTH),
  timestamp: storedChatTimestampSchema,
});

const subchatCursorSchema = z.strictObject({ subchatIndex: subchatIndexSchema });

function stableCursorKey<Cursor>(cursor: Cursor): string {
  return JSON.stringify(cursor);
}

function isDescendingBy<Item>(items: Item[], select: (item: Item) => string): boolean {
  return items.every((item, index) => index === 0 || select(items[index - 1]) >= select(item));
}

function isStrictlyAscendingBy<Item>(items: Item[], select: (item: Item) => number): boolean {
  return items.every((item, index) => index === 0 || select(items[index - 1]) < select(item));
}
