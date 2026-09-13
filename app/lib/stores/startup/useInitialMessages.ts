import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { TranscriptIdentity } from 'ghostbuild-agent/transcript';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import {
  useCachedChatTranscript,
  type SerializedMessage,
  type TranscriptRequest,
} from '~/lib/cloudflare/chat-transcript-db';
import { description } from '~/lib/stores/description';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { subchatIndexStore } from '~/lib/stores/subchats';

const logger = createScopedLogger('InitialMessages');

function transcriptRequest(chatId: string, selection: TranscriptSelection): TranscriptRequest {
  const request: TranscriptRequest = { chatId };
  if (selection.subchatIndex !== undefined) {
    request.subchatIndex = selection.subchatIndex;
  }
  return request;
}

interface InitialMessages {
  loadedChatId: string;
  deserialized: GhostbuildMessage[];
  loadedSubchatIndex: number;
  transcript: TranscriptIdentity;
}

type TranscriptSelection = {
  scope: string;
  subchatIndex?: number;
  loadedSubchatIndex?: number;
};

type InitialMessagesState = {
  initialMessages: InitialMessages | null | undefined;
  error: unknown;
  retry: () => void;
};

export function useInitialMessages(chatId: string | undefined): InitialMessages | null | undefined {
  return useInitialMessagesState(chatId).initialMessages;
}

export function useInitialMessagesState(chatId: string | undefined): InitialMessagesState {
  const userId = useUserIdOrNullOrLoading();
  const subchatIndex = useStore(subchatIndexStore);
  const scope = chatId && userId ? `${userId}:${chatId}` : undefined;
  const [selection, setSelection] = useState<TranscriptSelection>();
  const activeSelection = selection?.scope === scope ? selection : undefined;
  const cached = useCachedChatTranscript(
    userId,
    chatId && activeSelection ? transcriptRequest(chatId, activeSelection) : undefined,
  );

  useEffect(() => {
    setSelection(scope ? { scope } : undefined);
  }, [scope]);

  useEffect(() => {
    const transcript = cached.transcript;
    if (!activeSelection || transcript?.status !== 'ready') {
      return;
    }
    if (activeSelection.subchatIndex !== undefined && transcript.loadedSubchatIndex !== activeSelection.subchatIndex) {
      return;
    }
    if (activeSelection.loadedSubchatIndex !== transcript.loadedSubchatIndex) {
      if (subchatIndexStore.get() !== transcript.loadedSubchatIndex) {
        subchatIndexStore.set(transcript.loadedSubchatIndex);
      }
      setSelection({
        ...activeSelection,
        loadedSubchatIndex: transcript.loadedSubchatIndex,
      });
      return;
    }
    if (subchatIndex !== undefined && subchatIndex !== transcript.loadedSubchatIndex) {
      setSelection({
        scope: activeSelection.scope,
        subchatIndex,
      });
    }
  }, [activeSelection, cached.transcript, subchatIndex]);

  useEffect(() => {
    const transcript = cached.transcript;
    if (transcript?.status !== 'ready') {
      return;
    }
    description.set(transcript.description);
  }, [cached.transcript]);

  useEffect(() => {
    if (!cached.error) {
      return;
    }
    toast.error('Failed to refresh chat messages from storage. Try reloading the page.');
    logger.error('Error refreshing initial messages:', cached.error);
  }, [cached.error]);

  const initialMessages = useMemo<InitialMessages | null | undefined>(() => {
    const transcript = cached.transcript;
    if (!chatId || !userId || !activeSelection || cached.isLoading || transcript === undefined) {
      return undefined;
    }
    if (transcript.status === 'missing') {
      return null;
    }
    const deserialized = transcript.messages.map(deserializeMessageFromStorage);
    return {
      loadedChatId: transcript.loadedChatId,
      deserialized,
      loadedSubchatIndex: transcript.loadedSubchatIndex,
      transcript: transcript.transcript,
    };
  }, [activeSelection, cached.isLoading, cached.transcript, chatId, userId]);

  if (initialMessages && subchatIndex !== undefined && initialMessages.loadedSubchatIndex !== subchatIndex) {
    return { initialMessages: undefined, error: cached.error, retry: cached.retry };
  }
  return { initialMessages, error: cached.error, retry: cached.retry };
}

function deserializeMessageFromStorage(message: SerializedMessage): GhostbuildMessage {
  return {
    ...message,
    createdAt: message.createdAt === undefined ? undefined : new Date(message.createdAt),
  };
}
