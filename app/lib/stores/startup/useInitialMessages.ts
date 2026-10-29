import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import {
  useCachedChatTranscript,
  type SerializedMessage,
  type TranscriptRequest,
} from '~/lib/cloudflare/chat-transcript-db';
import { cloudflareReauthorizationRequiredStore } from '~/lib/cloudflare/runtime-session';
import { description } from '~/lib/stores/description';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { subchatIndexStore } from '~/lib/stores/subchats';

const logger = createScopedLogger('InitialMessages');

function transcriptRequest(workspaceId: string, selection: TranscriptSelection): TranscriptRequest {
  const request: TranscriptRequest = { chatId: workspaceId };
  if (selection.subchatIndex !== undefined) {
    request.subchatIndex = selection.subchatIndex;
  }
  return request;
}

interface InitialMessages {
  loadedChatId: string;
  deserialized: CloudChefMessage[];
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
  error: Error | null | undefined;
  retry: () => void;
};

export function useInitialMessagesState(workspaceId: string | undefined): InitialMessagesState {
  const userId = useUserIdOrNullOrLoading();
  const subchatIndex = useStore(subchatIndexStore);
  const scope = workspaceId && userId ? `${userId}:${workspaceId}` : undefined;
  const [selection, setSelection] = useState<TranscriptSelection>();
  // A new scope starts from its latest subchat, until its transcript says which one that is.
  const scopeStart = useMemo<TranscriptSelection | undefined>(() => (scope ? { scope } : undefined), [scope]);
  const activeSelection = selection?.scope === scope ? selection : scopeStart;
  const cached = useCachedChatTranscript(
    userId,
    workspaceId && activeSelection ? transcriptRequest(workspaceId, activeSelection) : undefined,
  );

  useEffect(() => {
    const transcript = cached.transcript;
    if (!activeSelection || transcript?.status !== 'ready') {
      return;
    }
    if (activeSelection.subchatIndex !== undefined && transcript.loadedSubchatIndex !== activeSelection.subchatIndex) {
      return;
    }
    if (activeSelection.loadedSubchatIndex !== transcript.loadedSubchatIndex) {
      // The store and the selection move together: set apart, a render could see the old store value with
      // the new selection and switch back to the conversation it just left.
      subchatIndexStore.set(transcript.loadedSubchatIndex);
      // oxlint-disable-next-line react/set-state-in-effect
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
    logger.error('Error refreshing initial messages:', cached.error);
    // Cloudflare permissions to approve again have their own prompt where the project would be.
    if (cloudflareReauthorizationRequiredStore.get()) {
      return;
    }
    toast.error('Failed to refresh chat messages from storage. Try reloading the page.');
  }, [cached.error]);

  const initialMessages = useMemo<InitialMessages | null | undefined>(() => {
    const transcript = cached.transcript;
    if (!workspaceId || !userId || !activeSelection || cached.isLoading || transcript === undefined) {
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
  }, [activeSelection, cached.isLoading, cached.transcript, workspaceId, userId]);

  if (initialMessages && subchatIndex !== undefined && initialMessages.loadedSubchatIndex !== subchatIndex) {
    return { initialMessages: undefined, error: cached.error, retry: cached.retry };
  }
  return { initialMessages, error: cached.error, retry: cached.retry };
}

function deserializeMessageFromStorage(message: SerializedMessage): CloudChefMessage {
  return {
    ...message,
    createdAt: message.createdAt === undefined ? undefined : new Date(message.createdAt),
  };
}
