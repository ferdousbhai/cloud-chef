import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { Chat } from './chat/Chat';
import { useChatHomepage } from '~/lib/stores/startup';

const EMPTY_MESSAGES: CloudChefMessage[] = [];

export function HomepageChat({ initialId, initialPrompt }: { initialId: string; initialPrompt: string }) {
  const { initializeChat, discardEmptyChat, onBuilderRequestStart, initialMessages, subchats, transcript } =
    useChatHomepage(initialId);

  return (
    <Chat
      initialMessages={initialMessages ?? EMPTY_MESSAGES}
      initializeChat={initializeChat}
      discardEmptyChat={discardEmptyChat}
      onBuilderRequestStart={onBuilderRequestStart}
      subchats={subchats}
      initialPrompt={initialPrompt}
      transcript={transcript}
    />
  );
}
