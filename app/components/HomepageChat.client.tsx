import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { Chat } from './chat/Chat';
import { useChatHomepage } from '~/lib/stores/startup';

const EMPTY_MESSAGES: CloudChefMessage[] = [];

export function HomepageChat({ initialId, initialPrompt }: { initialId: string; initialPrompt: string }) {
  const { initializeWorkspace, discardEmptyWorkspace, onBuilderRequestStart, initialMessages, subchats, transcript } =
    useChatHomepage(initialId);

  return (
    <Chat
      initialMessages={initialMessages ?? EMPTY_MESSAGES}
      initializeWorkspace={initializeWorkspace}
      discardEmptyWorkspace={discardEmptyWorkspace}
      onBuilderRequestStart={onBuilderRequestStart}
      subchats={subchats}
      initialPrompt={initialPrompt}
      transcript={transcript}
    />
  );
}
