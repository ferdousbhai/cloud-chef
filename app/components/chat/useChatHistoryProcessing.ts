import { useEffect, useMemo } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { createSampler } from '~/utils/sampler';
import { useProcessedMessages, type PartCache } from '~/lib/hooks/useProcessedMessages';

interface ProcessMessagesOptions {
  messages: GhostbuildMessage[];
  processMessages: (messages: GhostbuildMessage[]) => void;
}

export function useChatHistoryProcessing(args: { messages: GhostbuildMessage[]; partCache: PartCache }) {
  const { parsedMessages, processMessages } = useProcessedMessages(args.partCache);
  const { messages } = args;
  const processSampledMessages = useMemo(
    () =>
      createSampler((options: ProcessMessagesOptions) => {
        options.processMessages(options.messages);
      }, 50),
    [],
  );

  useEffect(() => {
    processSampledMessages({ messages, processMessages });
  }, [messages, processMessages, processSampledMessages]);

  useEffect(() => () => processSampledMessages.cancel(), [processSampledMessages]);

  return parsedMessages;
}
