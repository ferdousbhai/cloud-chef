/* A chat's immutable initial ID is its route, persistence, and agent identity. */
import { useNavigate, useParams, type HistoryState } from '@tanstack/react-router';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { map } from 'nanostores';

const logger = createScopedLogger('ChatId');
const ChatIdContext = createContext<string | null>(null);

export function ChatIdProvider({ chatId, children }: { chatId: string; children: ReactNode }) {
  return <ChatIdContext.Provider value={chatId}>{children}</ChatIdContext.Provider>;
}

export function useChatId() {
  const chatId = useContext(ChatIdContext);
  if (!chatId) {
    throw new Error('useChatId must be used inside a ChatIdProvider');
  }
  return chatId;
}

export function chatUrlMask(chatId: string) {
  return {
    to: '/chat/$id',
    params: { id: chatId },
    unmaskOnReload: true,
  } as const;
}

export function maskedChatNavigation(chatId: string) {
  return {
    to: '/' as const,
    state: (previous: HistoryState) => ({
      ...previous,
      cloudchefChatMaskId: chatId,
    }),
    mask: chatUrlMask(chatId),
    replace: true,
    resetScroll: false,
    ignoreBlocker: true,
  };
}

/**
 * Keep the live homepage build mounted while publishing its resumable URL.
 * Reloading the masked URL enters the existing-project route.
 */
export function useNavigateToChat() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const currentChatRouteId = params.id;

  return useCallback(
    async (chatId: string): Promise<void> => {
      try {
        if (currentChatRouteId === chatId) {
          return;
        }

        if (currentChatRouteId) {
          await navigate({
            to: '/chat/$id',
            params: { id: chatId },
            replace: true,
            resetScroll: false,
            ignoreBlocker: true,
          });
          return;
        }

        await navigate(maskedChatNavigation(chatId));
      } catch (error) {
        logger.warn('Unable to publish the resumable chat URL', error);
      }
    },
    [currentChatRouteId, navigate],
  );
}

export const chatStore = map({
  started: false,
  aborted: false,
  showChat: true,
});
