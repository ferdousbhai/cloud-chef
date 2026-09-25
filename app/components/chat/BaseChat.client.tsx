import React, { lazy, Suspense, type ReactNode, type RefCallback, useCallback } from 'react';
import { messageText, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { isStreamStatusActive, type StreamStatus } from '~/lib/common/types';
import { MessageInput } from './MessageInput';
import { Messages } from './Messages.client';
import { ActivityPanel } from './ActivityPanel';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { useChatId } from '~/lib/stores/chatId';
import { setMessageInput } from '~/lib/stores/messageInput';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { classNames } from '~/utils/classNames';
import styles from './BaseChat.module.css';
import { useWorkspaceSwipe } from '~/lib/hooks/useWorkspaceSwipe';
import useViewport from '~/lib/hooks/useViewport';
import { DisabledChatMessageSheet } from './DisabledChatMessageSheet';
import { HomeIntro } from './HomeIntro.client';
import StreamingIndicator from './StreamingIndicator';
import { ReauthorizeInterstitial } from '~/components/cloudflare/ReauthorizeInterstitial.client';
import { MotionConfig } from 'framer-motion';
import { useStore } from '@nanostores/react';
import { toast } from 'sonner';
import { SubchatBar } from './SubchatBar';
import { refreshSubchats, useMutation } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { subchatIndexStore, useIsSubchatLoaded } from '~/lib/stores/subchats';
import type { BuildProgress } from './build-progress';
import type { SubchatSummary } from './subchat-model';
import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';
import type { BuilderPublicationState } from '~/agents/builder-publication-progress';
import { DeploymentStatus } from './DeploymentStatus.client';
import type {
  CloudflareExecutionDecisionHandler,
  CloudflareExecutionPublicState,
} from 'cloudchef-agent/cloudflare-mcp';

const Workbench = lazy(() =>
  import('~/components/workbench/Workbench.client').then((module) => ({ default: module.Workbench })),
);
interface BaseChatProps {
  messageRef: RefCallback<HTMLDivElement> | undefined;
  scrollRef: RefCallback<HTMLDivElement> | undefined;

  showChat: boolean;
  chatStarted: boolean;

  onStop: () => void;
  onSend: (messageInput: string, onAccepted?: () => void) => Promise<boolean>;
  sendMessageInProgress: boolean;

  streamStatus: StreamStatus;
  isRecovering: boolean;
  currentError: Error | undefined;
  buildProgress: BuildProgress | null;
  messages: CloudChefMessage[];
  disabledReason: ReactNode | null;
  runtimeNotice: ReactNode;
  deployment?: BuilderDeploymentState | null;
  publication?: BuilderPublicationState | null;
  onDeploy?: () => Promise<BuilderDeploymentState>;
  cloudflareExecutions?: readonly CloudflareExecutionPublicState[];
  onCloudflareExecutionDecision?: CloudflareExecutionDecisionHandler;

  subchats?: SubchatSummary[];
  onSubchatTitleChange?: (subchatIndex: number, title: string) => void;
}

export function BaseChat({
  messageRef,
  scrollRef,
  showChat,
  chatStarted,
  streamStatus,
  currentError,
  onSend,
  onStop,
  sendMessageInProgress,
  messages,
  isRecovering,
  buildProgress,
  disabledReason,
  runtimeNotice,
  deployment,
  publication,
  onDeploy,
  cloudflareExecutions,
  onCloudflareExecutionDecision,
  subchats,
  onSubchatTitleChange,
}: BaseChatProps) {
  const isStreaming = isRecovering || isStreamStatusActive(streamStatus);
  const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
  const createSubchat = useMutation(api.subchats.create);
  const setSubchatDescription = useMutation(api.subchats.setDescription);
  const isSubchatLoaded = useIsSubchatLoaded();
  const chatId = useChatId();
  const userId = useUserIdOrNullOrLoading();
  const activeChatContextRef = React.useRef<{ chatId: string; userId: string | null | undefined } | null>(null);
  const createSubchatPendingRef = React.useRef<symbol | null>(null);

  React.useLayoutEffect(() => {
    const context = { chatId, userId };
    activeChatContextRef.current = context;
    createSubchatPendingRef.current = null;
    return () => {
      if (activeChatContextRef.current === context) {
        activeChatContextRef.current = null;
      }
      createSubchatPendingRef.current = null;
    };
  }, [chatId, userId]);

  const handleCreateSubchat = useCallback(async (): Promise<boolean> => {
    const context = activeChatContextRef.current;
    if (!userId || context?.chatId !== chatId || context.userId !== userId || createSubchatPendingRef.current) {
      return false;
    }
    const attempt = Symbol('create-subchat');
    createSubchatPendingRef.current = attempt;
    const isActiveChat = () => activeChatContextRef.current === context;
    try {
      let subchatIndex: number;
      try {
        subchatIndex = await createSubchat({ chatId, sessionId: userId });
      } catch (error) {
        if (isActiveChat()) {
          toast.error(error instanceof Error ? error.message : 'Unable to create a new chat.');
        }
        return false;
      }
      if (!isActiveChat()) {
        return true;
      }
      try {
        await refreshSubchats({ chatId, sessionId: userId });
        if (!isActiveChat()) {
          return true;
        }
      } catch (error) {
        if (isActiveChat()) {
          toast.error(
            error instanceof Error
              ? `The chat was created, but its history could not refresh: ${error.message}`
              : 'The chat was created, but its history could not refresh. Reload to continue.',
          );
        }
        return true;
      }
      subchatIndexStore.set(subchatIndex);
      setMessageInput('');
      return true;
    } finally {
      if (createSubchatPendingRef.current === attempt) {
        createSubchatPendingRef.current = null;
      }
    }
  }, [createSubchat, chatId, userId]);
  const handleRenameSubchat = useCallback(
    async (title: string): Promise<boolean> => {
      const context = activeChatContextRef.current;
      if (!userId || context?.chatId !== chatId || context.userId !== userId) {
        return false;
      }
      const isActiveChat = () =>
        activeChatContextRef.current === context && (subchatIndexStore.get() ?? 0) === currentSubchatIndex;
      try {
        await setSubchatDescription({
          chatId,
          sessionId: userId,
          subchatIndex: currentSubchatIndex,
          description: title,
        });
      } catch (error) {
        if (isActiveChat()) {
          toast.error(error instanceof Error ? error.message : 'Unable to rename this chat.');
        }
        return false;
      }

      try {
        await refreshSubchats({ chatId, sessionId: userId });
      } catch (error) {
        if (isActiveChat()) {
          toast.error(
            error instanceof Error
              ? `The chat was renamed, but its history could not refresh: ${error.message}`
              : 'The chat was renamed, but its history could not refresh. Reload to see the new title.',
          );
        }
      }
      if (isActiveChat()) {
        onSubchatTitleChange?.(currentSubchatIndex, title);
      }
      return true;
    },
    [chatId, currentSubchatIndex, userId, setSubchatDescription, onSubchatTitleChange],
  );

  const lastUserMessage = messages.findLast((message) => message.role === 'user');
  const resendMessage = useCallback(async () => {
    if (lastUserMessage) {
      await onSend(messageText(lastUserMessage));
    }
  }, [lastUserMessage, onSend]);
  const isSmallViewport = useViewport(1024);
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const compactActivity = isSmallViewport || showWorkbench;
  const swipeEnabled = isSmallViewport && chatStarted;
  const workspaceSwipe = useWorkspaceSwipe(swipeEnabled);
  return (
    <MotionConfig reducedMotion="user">
      <div
        className={classNames(styles.BaseChat, 'relative flex h-full w-full overflow-hidden')}
        data-chat-visible={showChat}
      >
        <div
          ref={chatStarted ? undefined : scrollRef}
          className={classNames(styles.ChatScroller, 'flex size-full min-h-0 flex-col', {
            'touch-pan-y touch-pinch-zoom': swipeEnabled,
            'overflow-y-auto': !chatStarted,
          })}
          {...workspaceSwipe}
        >
          <div className="flex size-full min-h-0 grow flex-col lg:flex-row">
            <div
              className={classNames(
                styles.Chat,
                'flex min-w-0 flex-col flex-grow lg:min-w-[var(--chat-min-width)] h-full',
                {
                  'items-stretch': !chatStarted,
                },
              )}
              data-chat-started={chatStarted}
            >
              <div
                className={classNames('w-full', {
                  'h-full min-h-0 flex flex-col': chatStarted,
                })}
              >
                {!chatStarted ? (
                  <HomeIntro
                    disabledReason={disabledReason}
                    isStreaming={isStreaming}
                    messagesLength={messages.length}
                    onSend={onSend}
                    onStop={onStop}
                    sendMessageInProgress={sendMessageInProgress}
                  />
                ) : (
                  <>
                    <SubchatBar
                      chatId={chatId}
                      subchats={subchats}
                      currentSubchatIndex={currentSubchatIndex}
                      isStreaming={isStreaming}
                      chatDisabled={disabledReason !== null || messages.length === 0}
                      userId={userId ?? null}
                      handleCreateSubchat={handleCreateSubchat}
                      handleRenameSubchat={handleRenameSubchat}
                      isSubchatLoaded={isSubchatLoaded}
                    />
                  </>
                )}
                <div className={chatStarted ? styles.ChatLayout : undefined} data-compact={compactActivity}>
                  {chatStarted && isSubchatLoaded && (
                    <>
                      <div
                        ref={scrollRef}
                        className={styles.Conversation}
                        role="region"
                        aria-label="Conversation"
                        tabIndex={0}
                      >
                        <Messages
                          ref={messageRef}
                          className="flex min-w-0 flex-col gap-3 px-1 pb-4"
                          messages={messages}
                          isStreaming={isStreaming}
                          cloudflareExecutions={cloudflareExecutions}
                          onCloudflareExecutionDecision={onCloudflareExecutionDecision}
                        />
                      </div>
                      <ActivityPanel
                        messages={messages}
                        isStreaming={isStreaming}
                        compact={compactActivity}
                        cloudflareExecutions={cloudflareExecutions}
                        onCloudflareExecutionDecision={onCloudflareExecutionDecision}
                      />
                    </>
                  )}
                  {chatStarted && (
                    <div className={classNames(styles.ComposerDock, 'z-prompt flex min-w-0 w-full flex-col pb-2')}>
                      {runtimeNotice && (
                        <div className="mb-1.5 px-1 text-xs text-content-tertiary" role="status">
                          {runtimeNotice}
                        </div>
                      )}
                      {deployment ? (
                        <div className="mb-2">
                          <DeploymentStatus deployment={deployment} publication={publication} onRetry={onDeploy} />
                        </div>
                      ) : null}
                      {(!subchats || (currentSubchatIndex >= subchats.length - 1 && isSubchatLoaded)) && (
                        <>
                          {!disabledReason && (
                            <StreamingIndicator
                              streamStatus={streamStatus}
                              isRecovering={isRecovering}
                              currentError={currentError}
                              buildProgress={buildProgress}
                              isProjectUpdate={currentSubchatIndex > 0}
                              submissionPending={sendMessageInProgress}
                              resendMessage={resendMessage}
                            />
                          )}

                          <MessageInput
                            chatStarted={chatStarted}
                            isStreaming={isStreaming}
                            sendMessageInProgress={sendMessageInProgress}
                            disabled={disabledReason !== null}
                            onStop={onStop}
                            onSend={onSend}
                            numMessages={messages.length}
                          />
                        </>
                      )}
                      <DisabledChatMessageSheet message={disabledReason} />
                    </div>
                  )}
                </div>
              </div>
            </div>
            {chatStarted && (
              <Suspense fallback={null}>
                <Workbench chatStarted isStreaming={isStreaming} />
              </Suspense>
            )}
            {Boolean(userId) && chatStarted && <ReauthorizeInterstitial />}
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
