import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { useCallback } from 'react';
import { z } from 'zod';
import { executeDataOperation } from './client';
import { api, type ChatHistorySummary } from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { loadAllChatHistory } from './data-page-loader';
import { registerClientCollectionDisposer } from './client-collections';
import { useQueryCacheError } from './use-query-cache-error';

const chatHistorySummarySchema = z.object({
  id: z.string().min(1),
  initialId: z.string().min(1),
  description: z.string().optional(),
  timestamp: z.iso.datetime(),
}) satisfies z.ZodType<ChatHistorySummary>;

function chatHistoryQueryKey(sessionId: string) {
  return ['ghostbuild-data', api.messages.getAll, { sessionId }] as const;
}

function createChatHistoryCollection(sessionId: string) {
  return createCollection(
    queryCollectionOptions({
      id: `projects`,
      schema: chatHistorySummarySchema,
      queryKey: chatHistoryQueryKey(sessionId),
      queryClient,
      queryFn: ({ signal }) => loadAllChatHistory(sessionId, signal),
      getKey: (item) => item.initialId,
      onDelete: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            executeDataOperation(api.messages.remove, { id: mutation.key, sessionId }),
          ),
        );
      },
    }),
  );
}

type ChatHistoryCollection = ReturnType<typeof createChatHistoryCollection>;

const chatHistoryCollections = new Map<string, ChatHistoryCollection>();

registerClientCollectionDisposer(async () => {
  const collections = new Set(chatHistoryCollections.values());
  chatHistoryCollections.clear();
  await Promise.allSettled([...collections].map((collection) => collection.cleanup()));
});

function getChatHistoryCollection(sessionId: string) {
  const existing = chatHistoryCollections.get(sessionId);
  if (existing) {
    return existing;
  }

  const collection = createChatHistoryCollection(sessionId);
  chatHistoryCollections.set(sessionId, collection);
  return collection;
}

export function useChatHistory(sessionId: string | null | undefined) {
  const collection = sessionId ? getChatHistoryCollection(sessionId) : undefined;
  const query = useLiveQuery(() => collection, [collection]);
  const error = useQueryCacheError(sessionId ? chatHistoryQueryKey(sessionId) : undefined);
  const retry = useCallback(() => {
    void collection?.utils.clearError().catch(() => undefined);
  }, [collection]);
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
