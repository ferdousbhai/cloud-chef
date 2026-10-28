import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { z } from 'zod';
import { executeDataOperation } from './client';
import { api, type WorkspaceSummary } from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { useQueryCacheError } from './use-query-cache-error';
import { collectionCache, useCollectionRetry } from './query-collections';

const workspaceSummarySchema = z.object({
  id: z.string().min(1),
  initialId: z.string().min(1),
  description: z.string().optional(),
  timestamp: z.iso.datetime(),
  productionUrl: z.url({ protocol: /^https$/ }).nullish(),
}) satisfies z.ZodType<WorkspaceSummary>;

function workspaceHistoryQueryKey(sessionId: string) {
  return ['cloudchef-data', api.messages.getAll, { sessionId }] as const;
}

function createWorkspaceHistoryCollection(sessionId: string) {
  return createCollection(
    queryCollectionOptions({
      id: `projects`,
      schema: workspaceSummarySchema,
      queryKey: workspaceHistoryQueryKey(sessionId),
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

const workspaceHistoryCollections = collectionCache<ReturnType<typeof createWorkspaceHistoryCollection>>();

function getWorkspaceHistoryCollection(sessionId: string) {
  return workspaceHistoryCollections.get(sessionId, () => createWorkspaceHistoryCollection(sessionId));
}

export function useWorkspaceHistory(sessionId: string | null | undefined) {
  const collection = sessionId ? getWorkspaceHistoryCollection(sessionId) : undefined;
  const query = useLiveQuery(() => collection, [collection]);
  const error = useQueryCacheError(sessionId ? workspaceHistoryQueryKey(sessionId) : undefined);
  const retry = useCollectionRetry(collection);
  return {
    projects: query.data ?? [],
    isLoading: query.isLoading,
    error,
    retry,
  };
}

export async function removeWorkspaceHistoryItem(sessionId: string, initialId: string) {
  const collection = getWorkspaceHistoryCollection(sessionId);
  const tx = collection.delete(initialId, {
    metadata: { source: 'sidebar' },
  });
  await tx.isPersisted.promise;
}

export function refreshWorkspaceHistory(sessionId: string) {
  return queryClient.invalidateQueries({ queryKey: workspaceHistoryQueryKey(sessionId) });
}
