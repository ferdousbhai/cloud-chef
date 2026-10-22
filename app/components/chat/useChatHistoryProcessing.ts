import { useEffect, useMemo } from 'react';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { createSampler } from '~/utils/sampler';
import { useProcessedMessages } from '~/lib/hooks/useProcessedMessages';

interface ProcessMessagesOptions {
  messages: CloudChefMessage[];
  processMessages: (messages: CloudChefMessage[]) => void;
}

export function useChatHistoryProcessing(args: { messages: CloudChefMessage[] }) {
  const { parsedMessages, processMessages } = useProcessedMessages();
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
