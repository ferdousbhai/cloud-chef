import { toast } from 'sonner';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { BaseChat } from './BaseChat.client';
import type { ChatProps } from './chat-types';

export function UnauthenticatedChat({
  initialMessages,
  subchats,
  authLoading,
}: Pick<ChatProps, 'initialMessages' | 'subchats'> & {
  authLoading: boolean;
}) {
  const hasMultipleSubchats = (subchats?.length ?? 0) > 1;
  const chatStarted = initialMessages.length > 0 || hasMultipleSubchats;
  const { messageRef, scrollRef } = useSnapScroll();
  return (
    <BaseChat
      messageRef={messageRef}
      scrollRef={scrollRef}
      showChat
      chatStarted={chatStarted}
      onStop={() => undefined}
      streamStatus="ready"
      buildProgress={null}
      currentError={undefined}
      messages={initialMessages}
      disabledReason={authLoading ? 'Loading account...' : null}
      runtimeNotice="Connect Cloudflare to build and preview."
      sendMessageInProgress={false}
      subchats={subchats}
      onSend={async () => {
        toast.info('Connect Cloudflare to chat or build.');
        return false;
      }}
    />
  );
}
