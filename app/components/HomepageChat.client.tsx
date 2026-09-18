import { useState } from 'react';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { Chat } from './chat/Chat';
import type { PartCache } from '~/lib/hooks/useProcessedMessages';
import { useChatHomepage } from '~/lib/stores/startup';

const EMPTY_MESSAGES: CloudChefMessage[] = [];

export function HomepageChat({ initialId, initialPrompt }: { initialId: string; initialPrompt: string }) {
  const [partCache] = useState<PartCache>(() => new Map());
  const { initializeChat, discardEmptyChat, onBuilderRequestStart, initialMessages, subchats, transcript } =
    useChatHomepage(initialId);

  return (
    <Chat
      initialMessages={initialMessages ?? EMPTY_MESSAGES}
      partCache={partCache}
      initializeChat={initializeChat}
      discardEmptyChat={discardEmptyChat}
      onBuilderRequestStart={onBuilderRequestStart}
      subchats={subchats}
      initialPrompt={initialPrompt}
      transcript={transcript}
    />
  );
}
