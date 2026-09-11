import { executeDataOperation } from '~/lib/cloudflare/client';
import { waitForUserId } from '~/lib/stores/userId';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';

export function useInitializeChat(chatId: string, onInitialized?: (initialized: boolean) => void) {
  return useCallback(async () => {
    const userId = await waitForUserId('useInitializeChat');

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
    const userId = await waitForUserId('useDiscardEmptyChat');
    await executeDataOperation(api.messages.discardEmptyChat, {
      id: chatId,
      sessionId: userId,
    });
  }, [chatId]);
}
