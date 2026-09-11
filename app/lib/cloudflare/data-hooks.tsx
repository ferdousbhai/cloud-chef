import { useMutation as useTanStackMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { z } from 'zod';
import { transcriptIdentitySchema } from 'ghostbuild-agent/transcript';
import { executeDataOperation } from './client';
import {
  api,
  type DataOperationArgs,
  type DataOperationPath,
  type DataOperationResult,
  type SubchatSummary,
} from './data-api';
import { loadAllSubchats } from './data-page-loader';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { registerClientCollectionDisposer } from './client-collections';
import { useQueryCacheError } from './use-query-cache-error';

type SubchatQueryArgs = { chatId: string; sessionId: string };

export function useMutation<Path extends DataOperationPath>(path: Path) {
  const { mutateAsync } = useTanStackMutation<DataOperationResult<Path>, Error, DataOperationArgs<Path>>({
    mutationKey: ['ghostbuild-data', path],
    mutationFn: (args) => executeDataOperation(path, args),
  });
  return mutateAsync;
}

const subchatSummarySchema = z.object({
  subchatIndex: z.number().int().nonnegative(),
  description: z.string().optional(),
  updatedAt: z.number().int(),
  transcript: transcriptIdentitySchema,
}) satisfies z.ZodType<SubchatSummary>;

export function subchatQueryKey(args: SubchatQueryArgs | 'skip') {
  return ['ghostbuild-data', api.subchats.get, args] as const;
}

function createSubchatCollection(args: SubchatQueryArgs) {
  return createCollection(
    queryCollectionOptions({
      id: `subchats:${args.chatId}`,
      schema: subchatSummarySchema,
      queryKey: subchatQueryKey(args),
      queryFn: ({ signal }) => loadAllSubchats(args.chatId, args.sessionId, signal),
      queryClient,
      getKey: (item) => item.subchatIndex,
    }),
  );
}

type SubchatCollection = ReturnType<typeof createSubchatCollection>;

const subchatCollections = new Map<string, SubchatCollection>();
const activeSubchatCollections = new Map<string, SubchatCollection>();
const MAX_SUBCHAT_COLLECTIONS = 32;

registerClientCollectionDisposer(async () => {
  const collections = new Set(subchatCollections.values());
  subchatCollections.clear();
  activeSubchatCollections.clear();
  await Promise.allSettled([...collections].map((collection) => collection.cleanup()));
});

function getSubchatCollection(args: SubchatQueryArgs) {
  const scopeKey = `${args.sessionId}:${args.chatId}`;
  const key = scopeKey;
  const existing = subchatCollections.get(key);
  if (existing) {
    subchatCollections.delete(key);
    subchatCollections.set(key, existing);
    activeSubchatCollections.set(scopeKey, existing);
    return existing;
  }
  const collection = createSubchatCollection(args);
  subchatCollections.set(key, collection);
  activeSubchatCollections.set(scopeKey, collection);
  if (subchatCollections.size > MAX_SUBCHAT_COLLECTIONS) {
    const [oldestKey] = subchatCollections.keys();
    if (oldestKey) {
      const oldest = subchatCollections.get(oldestKey);
      subchatCollections.delete(oldestKey);
      for (const [activeKey, activeCollection] of activeSubchatCollections) {
        if (activeCollection === oldest) {
          activeSubchatCollections.delete(activeKey);
        }
      }
      void oldest?.cleanup().catch(() => undefined);
    }
  }
  return collection;
}

export async function refreshSubchats(args: SubchatQueryArgs): Promise<void> {
  const collection = activeSubchatCollections.get(`${args.sessionId}:${args.chatId}`);
  if (collection) {
    await collection.utils.refetch({ throwOnError: true });
    return;
  }
  await queryClient.invalidateQueries({ queryKey: subchatQueryKey(args) });
}

export function useAllSubchatsState(args: SubchatQueryArgs | 'skip') {
  const collection = args !== 'skip' ? getSubchatCollection(args) : undefined;
  const query = useLiveQuery(() => collection, [collection]);
  const error = useQueryCacheError(args === 'skip' ? undefined : subchatQueryKey(args));
  const retry = useCallback(() => {
    void collection?.utils.clearError().catch(() => undefined);
  }, [collection]);
  if (args === 'skip' || !collection) {
    return { subchats: undefined, error: undefined, retry };
  }
  return {
    subchats: query.data,
    error,
    retry,
  };
}
