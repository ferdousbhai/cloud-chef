import { useMutation as useTanStackMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { z } from 'zod';
import { transcriptIdentitySchema } from 'cloudchef-agent/transcript';
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
    mutationKey: ['cloudchef-data', path],
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
  return ['cloudchef-data', api.subchats.get, args] as const;
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
const MAX_SUBCHAT_COLLECTIONS = 32;

registerClientCollectionDisposer(async () => {
  const collections = new Set(subchatCollections.values());
  subchatCollections.clear();
  await Promise.allSettled([...collections].map((collection) => collection.cleanup()));
});

function getSubchatCollection(args: SubchatQueryArgs) {
  const scopeKey = `${args.sessionId}:${args.chatId}`;
  const existing = subchatCollections.get(scopeKey);
  if (existing) {
    subchatCollections.delete(scopeKey);
    subchatCollections.set(scopeKey, existing);
    return existing;
  }
  const collection = createSubchatCollection(args);
  subchatCollections.set(scopeKey, collection);
  if (subchatCollections.size > MAX_SUBCHAT_COLLECTIONS) {
    const [oldestKey] = subchatCollections.keys();
    if (oldestKey) {
      const oldest = subchatCollections.get(oldestKey);
      subchatCollections.delete(oldestKey);
      void oldest?.cleanup().catch(() => undefined);
    }
  }
  return collection;
}

export async function refreshSubchats(args: SubchatQueryArgs): Promise<void> {
  const collection = subchatCollections.get(`${args.sessionId}:${args.chatId}`);
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
