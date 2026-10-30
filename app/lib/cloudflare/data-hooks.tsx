import { useMutation as useTanStackMutation } from '@tanstack/react-query';
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
  type ConversationSummary,
} from './data-api';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { useQueryCacheError } from './use-query-cache-error';
import { collectionCache, useCollectionRetry } from './query-collections';

type ConversationQueryArgs = { workspaceId: string; sessionId: string };

export function useMutation<Path extends DataOperationPath>(path: Path) {
  const { mutateAsync } = useTanStackMutation<DataOperationResult<Path>, Error, DataOperationArgs<Path>>({
    mutationKey: ['cloudchef-data', path],
    mutationFn: (args) => executeDataOperation(path, args),
  });
  return mutateAsync;
}

const conversationSummarySchema = z.object({
  conversationIndex: z.number().int().nonnegative(),
  description: z.string().optional(),
  updatedAt: z.number().int(),
  transcript: transcriptIdentitySchema,
}) satisfies z.ZodType<ConversationSummary>;

export function conversationsQueryKey(args: ConversationQueryArgs | 'skip') {
  return ['cloudchef-data', api.subchats.get, args] as const;
}

function createSubchatCollection(args: ConversationQueryArgs) {
  return createCollection(
    queryCollectionOptions({
      id: `conversations:${args.workspaceId}`,
      schema: conversationSummarySchema,
      queryKey: conversationsQueryKey(args),
      queryFn: ({ signal }) => executeDataOperation(api.subchats.get, { workspaceId: args.workspaceId }, { signal }),
      queryClient,
      getKey: (item) => item.conversationIndex,
    }),
  );
}

const MAX_SUBCHAT_COLLECTIONS = 32;
const subchatCollections = collectionCache<ReturnType<typeof createSubchatCollection>>(MAX_SUBCHAT_COLLECTIONS);

function subchatScopeKey(args: ConversationQueryArgs): string {
  return `${args.sessionId}:${args.workspaceId}`;
}

export async function refreshConversations(args: ConversationQueryArgs): Promise<void> {
  const collection = subchatCollections.find(subchatScopeKey(args));
  if (collection) {
    await collection.utils.refetch({ throwOnError: true });
    return;
  }
  await queryClient.invalidateQueries({ queryKey: conversationsQueryKey(args) });
}

export function useAllConversationsState(args: ConversationQueryArgs | 'skip') {
  const collection =
    args !== 'skip' ? subchatCollections.get(subchatScopeKey(args), () => createSubchatCollection(args)) : undefined;
  const query = useLiveQuery(() => collection, [collection]);
  const error = useQueryCacheError(args === 'skip' ? undefined : conversationsQueryKey(args));
  const retry = useCollectionRetry(collection);
  if (args === 'skip' || !collection) {
    return { subchats: undefined, error: undefined, retry };
  }
  return {
    subchats: query.data,
    error,
    retry,
  };
}
