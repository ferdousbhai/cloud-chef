import { executeDataOperation } from '~/lib/cloudflare/client';
import { useCallback } from 'react';
import { api } from '~/lib/cloudflare/data-api';

export function useInitializeChat(workspaceId: string, onInitialized?: (initialized: boolean) => void) {
  return useCallback(async () => {
    const result = await executeDataOperation(api.messages.initializeChat, { id: workspaceId });
    onInitialized?.(true);
    return result;
  }, [workspaceId, onInitialized]);
}

export function useDiscardEmptyChat(workspaceId: string) {
  return useCallback(async () => {
    await executeDataOperation(api.messages.discardEmptyChat, { id: workspaceId });
  }, [workspaceId]);
}
