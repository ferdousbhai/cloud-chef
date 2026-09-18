import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { processMessage, type PartCache } from '~/lib/hooks/useProcessedMessages';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useStore } from '@nanostores/react';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';

const logger = createScopedLogger('ReloadMessages');

type ReloadedMessages = {
  initialMessages: CloudChefMessage[];
  partCache: PartCache;
  subchatIndex: number | undefined;
};

export function useReloadMessages(initialMessages: CloudChefMessage[] | undefined): ReloadedMessages | undefined {
  const [reloadState, setReloadState] = useState<ReloadedMessages | undefined>(undefined);
  const subchatIndex = useStore(subchatIndexStore);
  useEffect(() => {
    if (initialMessages === undefined) {
      return;
    }
    try {
      const partCache: PartCache = new Map();
      for (const message of initialMessages) {
        if (!message.parts) {
          continue;
        }
        processMessage(message, partCache);
      }
      setReloadState({ initialMessages, partCache, subchatIndex });
    } catch (error) {
      toast.error('Failed to load previous chat messages from storage.');
      logger.error('Error reloading messages:', error);
    }
  }, [initialMessages, subchatIndex]);
  return reloadState?.initialMessages === initialMessages && reloadState?.subchatIndex === subchatIndex
    ? reloadState
    : undefined;
}
