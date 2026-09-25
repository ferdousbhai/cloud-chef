import { forwardRef, type ForwardedRef } from 'react';
import { classNames } from '~/utils/classNames';
import { AssistantMessage } from './AssistantMessage';
import { UserMessage } from './UserMessage';
import { useStore } from '@nanostores/react';
import { profileStore } from '~/lib/stores/profile';
import { ChatBubbleIcon, PersonIcon } from '@radix-ui/react-icons';
import { messageText, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import styles from './BaseChat.module.css';
import type {
  CloudflareExecutionDecisionHandler,
  CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-mcp';

interface MessagesProps {
  className?: string;
  messages: CloudChefMessage[];
  isStreaming?: boolean;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;
}

export const Messages = forwardRef<HTMLDivElement, MessagesProps>(function Messages(
  { messages, isStreaming = false, className, cloudflareExecutions, onCloudflareExecutionDecision }: MessagesProps,
  ref: ForwardedRef<HTMLDivElement> | undefined,
) {
  const profile = useStore(profileStore);

  return (
    <div className={className} ref={ref}>
      {messages.length > 0 ? (
        messages.map((message, index) => {
          const { role } = message;
          const isUserMessage = role === 'user';

          return (
            <div
              key={message.id}
              className={classNames(styles.Message, 'relative flex w-full gap-2', {
                [styles.UserMessage]: isUserMessage,
                [styles.AssistantMessage]: !isUserMessage,
              })}
            >
              {isUserMessage && (
                <div className="flex size-6 shrink-0 items-center justify-center self-start overflow-hidden rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-content-secondary">
                  {profile?.avatar ? (
                    <img
                      src={profile.avatar}
                      alt={profile?.username || 'User'}
                      className="size-full object-cover"
                      loading="eager"
                      decoding="sync"
                    />
                  ) : (
                    <PersonIcon className="size-3" />
                  )}
                </div>
              )}
              {isUserMessage ? (
                <UserMessage content={messageText(message)} />
              ) : (
                <AssistantMessage
                  message={message}
                  isStreaming={isStreaming && index === messages.length - 1}
                  cloudflareExecutions={cloudflareExecutions}
                  onCloudflareExecutionDecision={onCloudflareExecutionDecision}
                />
              )}
            </div>
          );
        })
      ) : (
        <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
          <div className="mb-4 flex size-12 shrink-0 items-center justify-center text-gray-600 dark:text-gray-500">
            <ChatBubbleIcon className="size-6" />
          </div>
          <h3 className="text-content-primary text-lg font-semibold">What should CloudChef change?</h3>
        </div>
      )}
    </div>
  );
});
