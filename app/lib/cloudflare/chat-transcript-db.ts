import { createCollection, eq, type LoadSubsetOptions } from '@tanstack/db';
import { parseLoadSubsetOptions, queryCollectionOptions } from '@tanstack/query-db-collection';
import { useLiveQuery } from '@tanstack/react-db';
import { useCallback } from 'react';
import { z } from 'zod';
import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  transcriptCheckpointSchema,
  transcriptIdentitySchema,
} from 'cloudchef-agent/transcript';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { UserRuntimeRequestError } from './client';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { fetchUserRuntime } from './runtime-session';
import { useQueryCacheError } from './use-query-cache-error';

const TRANSCRIPT_QUERY_KEY_PREFIX = ['cloudchef-local', 'transcripts'] as const;
const TRANSCRIPT_FETCH_TIMEOUT_MS = 30_000;

export type SerializedMessage = Omit<CloudChefMessage, 'createdAt'> & { createdAt: number | undefined };

const serializedMessageFields = z
  .object({
    id: z.string().min(1),
    role: z.enum(['system', 'user', 'assistant']),
    createdAt: z.number().optional(),
    parts: z.array(z.object({ type: z.string().min(1) }).loose()),
  })
  .loose();

const serializedMessageSchema = z.custom<SerializedMessage>(
  (value) => serializedMessageFields.safeParse(value).success,
  'Invalid serialized message.',
);

/** What the runtime answers for a chat's transcript: the chat is gone, or its identity with any saved history. */
const transcriptResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('missing') }),
  z.strictObject({
    status: z.literal('ready'),
    version: z.literal(TRANSCRIPT_HISTORY_FORMAT_VERSION),
    initialId: z.string().min(1),
    description: z.string().optional(),
    transcript: transcriptIdentitySchema,
    checkpoint: transcriptCheckpointSchema.nullable(),
    messages: z.array(serializedMessageSchema),
  }),
]);

const missingChatTranscriptSchema = z.object({
  requestKey: z.string().min(1),
  status: z.literal('missing'),
});

const readyChatTranscriptSchema = z.object({
  requestKey: z.string().min(1),
  status: z.literal('ready'),
  loadedChatId: z.string().min(1),
  description: z.string().optional(),
  loadedSubchatIndex: z.number().int().nonnegative(),
  transcript: transcriptIdentitySchema,
  checkpoint: transcriptCheckpointSchema.nullable(),
  messages: z.array(serializedMessageSchema),
});

const cachedChatTranscriptSchema = z.discriminatedUnion('status', [
  missingChatTranscriptSchema,
  readyChatTranscriptSchema,
]);

type CachedChatTranscript = z.infer<typeof cachedChatTranscriptSchema>;

export type TranscriptRequest = {
  chatId: string;
  subchatIndex?: number;
};

function transcriptRequestKey(request: TranscriptRequest): string {
  return JSON.stringify([request.chatId, request.subchatIndex ?? null]);
}

const transcriptRequestKeySchema = z.tuple([z.string().min(1), z.number().int().nonnegative().nullable()]);

function parseTranscriptRequestKey(value: string): TranscriptRequest {
  const parsed = transcriptRequestKeySchema.safeParse(JSON.parse(value));
  if (!parsed.success) {
    throw new Error('Invalid persisted transcript request key.');
  }
  const [chatId, subchatIndex] = parsed.data;
  if (subchatIndex === null) {
    return { chatId };
  }
  return { chatId, subchatIndex };
}

function requestKeyFromSubsetOptions(options: LoadSubsetOptions | null | undefined): string | undefined {
  for (const filter of parseLoadSubsetOptions(options).filters) {
    if (filter.operator !== 'eq' || filter.field.length !== 1 || filter.field[0] !== 'requestKey') {
      continue;
    }
    const requestKey = z.string().safeParse(filter.value);
    if (requestKey.success) {
      return requestKey.data;
    }
  }
  return undefined;
}

function createTranscriptCollection(sessionId: string) {
  return createCollection(
    queryCollectionOptions({
      id: 'transcripts',
      schema: cachedChatTranscriptSchema,
      syncMode: 'on-demand',
      queryKey: (options) => {
        const requestKey = requestKeyFromSubsetOptions(options);
        return requestKey
          ? [...TRANSCRIPT_QUERY_KEY_PREFIX, sessionId, requestKey]
          : [...TRANSCRIPT_QUERY_KEY_PREFIX, sessionId];
      },
      queryFn: async ({ meta, signal }) => {
        const requestKey = requestKeyFromSubsetOptions(meta?.loadSubsetOptions);
        if (!requestKey) {
          throw new Error('Transcript queries require an exact request key.');
        }
        return [await loadChatTranscript(sessionId, requestKey, parseTranscriptRequestKey(requestKey), signal)];
      },
      queryClient,
      getKey: (item) => item.requestKey,
      refetchOnMount: 'always',
      refetchOnReconnect: true,
    }),
  );
}

type TranscriptCollection = ReturnType<typeof createTranscriptCollection>;

const transcriptCollections = new Map<string, TranscriptCollection>();

function getTranscriptCollection(sessionId: string) {
  const existing = transcriptCollections.get(sessionId);
  if (existing) {
    return existing;
  }
  const collection = createTranscriptCollection(sessionId);
  transcriptCollections.set(sessionId, collection);
  return collection;
}

type CachedChatTranscriptQuery = {
  transcript: CachedChatTranscript | undefined;
  isLoading: boolean;
  error: Error | null | undefined;
  retry: () => void;
};

export function useCachedChatTranscript(
  sessionId: string | null | undefined,
  request: TranscriptRequest | undefined,
): CachedChatTranscriptQuery {
  const collection = sessionId ? getTranscriptCollection(sessionId) : undefined;
  const requestKey = request ? transcriptRequestKey(request) : undefined;
  const query = useLiveQuery(
    (q) =>
      collection && requestKey
        ? q.from({ transcript: collection }).where(({ transcript }) => eq(transcript.requestKey, requestKey))
        : undefined,
    [collection, requestKey],
  );
  const error = useQueryCacheError(
    sessionId && requestKey ? [...TRANSCRIPT_QUERY_KEY_PREFIX, sessionId, requestKey] : undefined,
  );
  const retry = useCallback(() => {
    void collection?.utils.clearError().catch(() => undefined);
  }, [collection]);
  return {
    transcript: query.data?.[0],
    isLoading: query.isLoading,
    error,
    retry,
  };
}

async function loadChatTranscript(
  sessionId: string,
  requestKey: string,
  request: TranscriptRequest,
  signal: AbortSignal,
): Promise<CachedChatTranscript> {
  signal.throwIfAborted();
  const response = await fetchUserRuntime('/v1/chats/messages', {
    method: 'POST',
    body: JSON.stringify({ chatId: request.chatId, subchatIndex: request.subchatIndex }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    throw await projectMessagesRequestError(response);
  }
  const loaded = parseTranscriptResponse(await response.json());
  signal.throwIfAborted();
  if (loaded.status === 'missing') {
    return { requestKey, status: 'missing' };
  }
  return {
    requestKey,
    status: 'ready',
    loadedChatId: loaded.initialId,
    description: loaded.description,
    loadedSubchatIndex: loaded.transcript.subchatIndex,
    transcript: loaded.transcript,
    checkpoint: loaded.checkpoint,
    messages: loaded.messages,
  };
}

/** Each field falls back independently so a malformed `retryable` cannot hide a usable `error`. */
const projectMessagesErrorSchema = z
  .object({
    error: z.string().optional().catch(undefined),
    retryable: z.boolean().optional().catch(undefined),
  })
  .loose();

export async function projectMessagesRequestError(response: Response): Promise<UserRuntimeRequestError> {
  const payload = projectMessagesErrorSchema.safeParse(await response.json().catch(() => null));
  const failure = payload.success ? payload.data : undefined;
  const detail = failure?.error === undefined ? '' : `: ${failure.error}`;
  return new UserRuntimeRequestError(
    `Failed to fetch project messages (${response.status})${detail}`,
    response.status,
    failure?.retryable,
  );
}

export function parseTranscriptResponse(deserialized: unknown): z.infer<typeof transcriptResponseSchema> {
  return transcriptResponseSchema.parse(deserialized);
}
