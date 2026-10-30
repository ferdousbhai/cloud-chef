import { useDiscardEmptyChat, useInitializeChat } from './useInitializeChat';
import { useInitialMessagesState } from './useInitialMessages';
import { useChatSelectionSync } from './history';
import { useCallback, useEffect, useState } from 'react';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { useAllConversationsState } from '~/lib/cloudflare/data-hooks';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useStore } from '@nanostores/react';
import { transcriptAgentName } from 'cloudchef-agent/transcript';
import { useNavigateToChat } from '~/lib/stores/workspaceId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';

const EMPTY_INITIAL_MESSAGES: CloudChefMessage[] = [];

export function useChatHomepage(workspaceId: string) {
  const navigateToChat = useNavigateToChat();
  const [chatInitialized, setChatInitialized] = useState(false);
  const initializeWorkspace = useInitializeChat(workspaceId, setChatInitialized);
  const discardEmptyWorkspace = useDiscardEmptyChat(workspaceId);
  const loaded = useInitialMessagesState(chatInitialized ? workspaceId : undefined).initialMessages;
  useChatSelectionSync(loaded?.loadedConversationIndex ?? (chatInitialized ? 0 : undefined));
  const subchatState = useSubchats(workspaceId, chatInitialized);
  const subchats = subchatState.subchats;
  const conversationIndex = useStore(subchatIndexStore) ?? 0;
  const loadedTranscript = loaded?.loadedConversationIndex === conversationIndex ? loaded.transcript : undefined;
  const transcript =
    loadedTranscript ??
    subchats?.find((subchat) => subchat.conversationIndex === conversationIndex)?.transcript ??
    ({ agentName: transcriptAgentName(workspaceId, conversationIndex), conversationIndex } as const);
  const onBuilderRequestStart = useCallback(() => {
    toolActivityStore.handoffActiveTurn();
    void navigateToChat(workspaceId);
  }, [workspaceId, navigateToChat]);

  return {
    initializeWorkspace,
    discardEmptyWorkspace,
    onBuilderRequestStart,
    initialMessages: loaded?.deserialized ?? EMPTY_INITIAL_MESSAGES,
    subchats,
    transcript,
  };
}

export function useExistingChat(workspaceId: string) {
  const navigateToChat = useNavigateToChat();
  const initializeWorkspace = useInitializeChat(workspaceId);
  const discardEmptyWorkspace = useDiscardEmptyChat(workspaceId);
  const initialMessageState = useInitialMessagesState(workspaceId);
  const initialMessages = initialMessageState.initialMessages;
  useEffect(() => {
    if (initialMessages?.loadedWorkspaceId && initialMessages.loadedWorkspaceId !== workspaceId) {
      void navigateToChat(initialMessages.loadedWorkspaceId);
    }
  }, [workspaceId, initialMessages?.loadedWorkspaceId, navigateToChat]);
  useChatSelectionSync(initialMessages?.loadedConversationIndex);
  const subchatState = useSubchats(workspaceId);
  const subchats = subchatState.subchats;
  const onBuilderRequestStart = useCallback(() => undefined, []);

  return {
    initialMessages: initialMessages ? initialMessages.deserialized : initialMessages,
    initializeWorkspace,
    discardEmptyWorkspace,
    onBuilderRequestStart,
    subchats,
    transcript: initialMessages?.transcript,
    loadError: initialMessageState.error,
    retryLoad: initialMessageState.retry,
    subchatLoadError: subchatState.error,
    retrySubchats: subchatState.retry,
  };
}

function useSubchats(workspaceId: string, enabled = true) {
  const userId = useUserIdOrNullOrLoading();
  return useAllConversationsState(
    userId && enabled
      ? {
          workspaceId,
          sessionId: userId,
        }
      : 'skip',
  );
}
