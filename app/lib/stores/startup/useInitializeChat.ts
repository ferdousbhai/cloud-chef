import { executeDataOperation } from '~/lib/cloudflare/client';
import { userIdStore } from '~/lib/stores/userId';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';

export function useInitializeChat(chatId: string, onInitialized?: (initialized: boolean) => void) {
  return useCallback(async () => {
    const userId = signedInUserId();

    const result = await executeDataOperation(api.messages.initializeChat, {
      id: chatId,
      sessionId: userId,
    });
    onInitialized?.(true);
    return result;
  }, [chatId, onInitialized]);
}

export function useDiscardEmptyChat(chatId: string) {
  return useCallback(async () => {
    const userId = signedInUserId();
    await executeDataOperation(api.messages.discardEmptyChat, {
      id: chatId,
      sessionId: userId,
    });
  }, [chatId]);
}

/** These run only from a signed-in chat, so a missing user is a bug rather than a wait. */
function signedInUserId(): string {
  const userId = userIdStore.get();
  if (!userId) {
    throw new Error('A chat is changed only while signed in.');
  }
  return userId;
}
