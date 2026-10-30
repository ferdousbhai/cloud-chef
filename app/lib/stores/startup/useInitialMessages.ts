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
  const request: TranscriptRequest = { workspaceId };
  if (selection.conversationIndex !== undefined) {
    request.conversationIndex = selection.conversationIndex;
  }
  return request;
}

interface InitialMessages {
  loadedWorkspaceId: string;
  deserialized: CloudChefMessage[];
  loadedConversationIndex: number;
  transcript: TranscriptIdentity;
}

type TranscriptSelection = {
  scope: string;
  conversationIndex?: number;
  loadedConversationIndex?: number;
};

type InitialMessagesState = {
  initialMessages: InitialMessages | null | undefined;
  error: Error | null | undefined;
  retry: () => void;
};

export function useInitialMessagesState(workspaceId: string | undefined): InitialMessagesState {
  const userId = useUserIdOrNullOrLoading();
  const conversationIndex = useStore(subchatIndexStore);
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
    if (
      activeSelection.conversationIndex !== undefined &&
      transcript.loadedConversationIndex !== activeSelection.conversationIndex
    ) {
      return;
    }
    if (activeSelection.loadedConversationIndex !== transcript.loadedConversationIndex) {
      // The store and the selection move together: set apart, a render could see the old store value with
      // the new selection and switch back to the conversation it just left.
      subchatIndexStore.set(transcript.loadedConversationIndex);
      // oxlint-disable-next-line react/set-state-in-effect
      setSelection({
        ...activeSelection,
        loadedConversationIndex: transcript.loadedConversationIndex,
      });
      return;
    }
    if (conversationIndex !== undefined && conversationIndex !== transcript.loadedConversationIndex) {
      setSelection({
        scope: activeSelection.scope,
        conversationIndex,
      });
    }
  }, [activeSelection, cached.transcript, conversationIndex]);

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
      loadedWorkspaceId: transcript.loadedWorkspaceId,
      deserialized,
      loadedConversationIndex: transcript.loadedConversationIndex,
      transcript: transcript.transcript,
    };
  }, [activeSelection, cached.isLoading, cached.transcript, workspaceId, userId]);

  if (
    initialMessages &&
    conversationIndex !== undefined &&
    initialMessages.loadedConversationIndex !== conversationIndex
  ) {
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
