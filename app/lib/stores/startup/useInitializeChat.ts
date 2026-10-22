import { executeDataOperation } from '~/lib/cloudflare/client';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';

export function useInitializeChat(chatId: string, onInitialized?: (initialized: boolean) => void) {
  return useCallback(async () => {
    const result = await executeDataOperation(api.messages.initializeChat, { id: chatId });
    onInitialized?.(true);
    return result;
  }, [chatId, onInitialized]);
}

export function useDiscardEmptyChat(chatId: string) {
  return useCallback(async () => {
    await executeDataOperation(api.messages.discardEmptyChat, { id: chatId });
  }, [chatId]);
}
