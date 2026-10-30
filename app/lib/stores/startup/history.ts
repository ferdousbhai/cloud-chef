import { useEffect } from 'react';
import { loadedSubchatIndexStore, subchatIndexStore } from '~/lib/stores/subchats';
import { workbenchStore } from '~/lib/stores/workbench.client';

export function useChatSelectionSync(loadedConversationIndex?: number): void {
  useEffect(() => {
    if (loadedConversationIndex === undefined) {
      return undefined;
    }
    loadedSubchatIndexStore.set(loadedConversationIndex);
    subchatIndexStore.set(loadedConversationIndex);
    return () => {
      if (loadedSubchatIndexStore.get() === loadedConversationIndex) {
        loadedSubchatIndexStore.set(undefined);
      }
    };
  }, [loadedConversationIndex]);

  useEffect(() => {
    // The loaded index is the same number the chat-info read would report; it is already resolved
    // from it upstream. Reading it again here cost a second request whose failure threw during
    // render, past the inline load-error retry the chat surface builds for exactly this case.
    if (loadedConversationIndex !== undefined && loadedConversationIndex > 0) {
      workbenchStore.showWorkbench.set(true);
    }
  }, [loadedConversationIndex]);
}
