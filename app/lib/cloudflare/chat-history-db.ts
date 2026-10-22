import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { z } from 'zod';
import { executeDataOperation } from './client';
import { api, type ChatHistorySummary } from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { useQueryCacheError } from './use-query-cache-error';
import { collectionCache, useCollectionRetry } from './query-collections';

const chatHistorySummarySchema = z.object({
  id: z.string().min(1),
  initialId: z.string().min(1),
  description: z.string().optional(),
  timestamp: z.iso.datetime(),
}) satisfies z.ZodType<ChatHistorySummary>;

function chatHistoryQueryKey(sessionId: string) {
  return ['cloudchef-data', api.messages.getAll, { sessionId }] as const;
}

function createChatHistoryCollection(sessionId: string) {
  return createCollection(
    queryCollectionOptions({
      id: `projects`,
      schema: chatHistorySummarySchema,
      queryKey: chatHistoryQueryKey(sessionId),
      queryClient,
      queryFn: ({ signal }) => executeDataOperation(api.messages.getAll, {}, { signal }),
      getKey: (item) => item.initialId,
      onDelete: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) => executeDataOperation(api.messages.remove, { id: mutation.key })),
        );
      },
    }),
  );
}

const chatHistoryCollections = collectionCache<ReturnType<typeof createChatHistoryCollection>>();

function getChatHistoryCollection(sessionId: string) {
  return chatHistoryCollections.get(sessionId, () => createChatHistoryCollection(sessionId));
}

export function useChatHistory(sessionId: string | null | undefined) {
  const collection = sessionId ? getChatHistoryCollection(sessionId) : undefined;
  const query = useLiveQuery(() => collection, [collection]);
  const error = useQueryCacheError(sessionId ? chatHistoryQueryKey(sessionId) : undefined);
  const retry = useCollectionRetry(collection);
  return {
    projects: query.data ?? [],
    isLoading: query.isLoading,
    error,
    retry,
  };
}

export async function removeChatHistoryItem(sessionId: string, initialId: string) {
  const collection = getChatHistoryCollection(sessionId);
  const tx = collection.delete(initialId, {
    metadata: { source: 'sidebar' },
  });
  await tx.isPersisted.promise;
}

export function refreshChatHistory(sessionId: string) {
  return queryClient.invalidateQueries({ queryKey: chatHistoryQueryKey(sessionId) });
}
