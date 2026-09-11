import { useEffect } from 'react';
import { loadedSubchatIndexStore, subchatIndexStore } from '~/lib/stores/subchats';
import { workbenchStore } from '~/lib/stores/workbench.client';

export function useChatSelectionSync(loadedSubchatIndex?: number): void {
  useEffect(() => {
    if (loadedSubchatIndex === undefined) {
      return undefined;
    }
    loadedSubchatIndexStore.set(loadedSubchatIndex);
    if (subchatIndexStore.get() !== loadedSubchatIndex) {
      subchatIndexStore.set(loadedSubchatIndex);
    }
    return () => {
      if (loadedSubchatIndexStore.get() === loadedSubchatIndex) {
        loadedSubchatIndexStore.set(undefined);
      }
    };
  }, [loadedSubchatIndex]);

  useEffect(() => {
    // The loaded index is the same number the chat-info read would report; it is already resolved
    // from it upstream. Reading it again here cost a second request whose failure threw during
    // render, past the inline load-error retry the chat surface builds for exactly this case.
    if (loadedSubchatIndex !== undefined && loadedSubchatIndex > 0) {
      workbenchStore.showWorkbench.set(true);
    }
  }, [loadedSubchatIndex]);
}
