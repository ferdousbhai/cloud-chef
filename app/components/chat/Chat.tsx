import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useSnapScroll } from '~/lib/hooks/useSnapScroll';
import { useUnsavedEditsGuard } from '~/lib/hooks/useUnsavedEditsGuard';
import { useFileSaveStatus } from '~/lib/stores/file-save-status';
import { chatStore } from '~/lib/stores/chatId';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { BaseChat } from './BaseChat.client';
import { useChatId } from '~/lib/stores/chatId';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { authClient } from '~/lib/auth-client';
import type { ChatProps } from './chat-types';
import { UnauthenticatedChat } from './UnauthenticatedChat';
import { workspacePresentationId, useBuilderAgentChat, type WorkspacePresentationState } from './useBuilderAgentChat';
import { useProcessedMessages } from '~/lib/hooks/useProcessedMessages';
import { useCurrentToolStatus } from './useCurrentToolStatus';
import { useBuildProgress } from './useBuildProgress';
import { appendPendingUserMessage, useChatMessageSubmission } from './useChatMessageSubmission';
import { deriveProvisionalTitle } from '~/lib/title-generation';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { applyLiveSubchatTitle, type LiveSubchatTitle } from './subchat-model';
import {
  getUserRuntimeSession,
  UserRuntimeSessionError,
  userRuntimeEndpointStore,
  userWorkspacePreparingStore,
  type UserRuntimeErrorCode,
} from '~/lib/cloudflare/runtime-session';
import { WorkspacePreparingLoading, WorkspacePreparingPanel } from '~/components/WorkspacePreparing';
import { Button } from '@ui/Button';
import { Loading } from '~/components/Loading';
import { LinkButton } from '~/components/ui/LinkButton';
import { buttonClassNames } from '~/components/ui/primitives/Button';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { WORKERS_PAID_URL } from '~/lib/workers-paid.client';
import { loadBuilderModelCatalog, loadBuilderModelPreference } from '~/lib/stores/builder-model.client';
import { messageOf } from '~/lib/json-request';

const logger = createScopedLogger('Chat');

export const Chat = memo(
  ({
    initialMessages,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    subchats,
    initialPrompt,
    transcript,
  }: ChatProps) => {
    const [pendingInitialMessage, setPendingInitialMessage] = useState<string | null>(initialPrompt ?? null);
    const clearPendingInitialMessage = useCallback(() => setPendingInitialMessage(null), []);
    const userId = useUserIdOrNullOrLoading();
    const runtimeEndpoint = useStore(userRuntimeEndpointStore);
    const workspacePreparing = useStore(userWorkspacePreparingStore);
    const [runtimeConnectionError, setRuntimeConnectionError] = useState<{
      message: string;
      code: UserRuntimeErrorCode | null;
      upgradeUrl: string | null;
    } | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    useEffect(() => {
      if (userId === null || userId === undefined || runtimeEndpoint) {
        return undefined;
      }
      let canceled = false;
      setRuntimeConnectionError(null);
      void getUserRuntimeSession({ retryProvisioning: retryCount > 0 }).catch((error) => {
        if (!canceled) {
          logger.error('Unable to connect to the user-owned runtime', error);
          setRuntimeConnectionError({
            message: messageOf(error, 'Unable to connect to your Cloudflare workspace.'),
            code: error instanceof UserRuntimeSessionError ? error.code : null,
            upgradeUrl: error instanceof UserRuntimeSessionError ? error.upgradeUrl : null,
          });
        }
      });
      return () => {
        canceled = true;
      };
    }, [retryCount, runtimeEndpoint, userId]);
    if (userId === null || userId === undefined) {
      return (
        <UnauthenticatedChat initialMessages={initialMessages} subchats={subchats} authLoading={userId === undefined} />
      );
    }
    if (!runtimeEndpoint) {
      return runtimeConnectionError ? (
        <WorkspaceRuntimeConnectionError
          message={runtimeConnectionError.message}
          code={runtimeConnectionError.code}
          upgradeUrl={runtimeConnectionError.upgradeUrl}
          onRetry={() => setRetryCount((count) => count + 1)}
        />
      ) : workspacePreparing ? (
        <WorkspacePreparingLoading />
      ) : (
        // Most sessions answer at once; only one the runtime says is still being prepared is a long wait.
        <Loading message="Connecting to your workspace…" />
      );
    }

    return (
      <AuthenticatedChat
        accountId={userId}
        initialMessages={initialMessages}
        initializeChat={initializeChat}
        discardEmptyChat={discardEmptyChat}
        onBuilderRequestStart={onBuilderRequestStart}
        subchats={subchats}
        pendingInitialMessage={pendingInitialMessage}
        clearPendingInitialMessage={clearPendingInitialMessage}
        transcript={transcript}
      />
    );
  },
);
Chat.displayName = 'Chat';

function WorkspaceRuntimeConnectionError({
  message,
  code,
  upgradeUrl,
  onRetry,
}: {
  message: string;
  code: UserRuntimeErrorCode | null;
  upgradeUrl: string | null;
  onRetry: () => void;
}) {
  const planRequired = code === 'workspace_plan_required';
  const reauthorizationRequired = code === 'cloudflare_reauthorization_required';
  // An organization's connection is reauthorized by its admins, from its settings.
  const { data: session } = authClient.useSession();
  const organization = session?.context?.kind === 'organization' ? session.context : null;
  // Preparation that outran the readiness deadline is still preparation, not a refusal.
  if (code === 'workspace_preparing') {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-5">
        <WorkspacePreparingPanel onKeepWaiting={onRetry} />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <section
        className="app-card m-auto w-full max-w-lg shrink-0 p-5 text-center"
        aria-labelledby="workspace-connection-heading"
      >
        <h1 id="workspace-connection-heading" className="font-display text-2xl font-bold text-content-primary">
          CloudChef could not prepare your workspace.
        </h1>
        <p className="mt-3 break-words text-sm text-content-secondary" role="alert">
          {message}
        </p>
        {planRequired ? (
          <ol className="mx-auto mt-5 max-w-md list-decimal space-y-2 pl-5 text-left text-sm text-content-secondary">
            <li>Open Cloudflare and enable the Workers Paid plan.</li>
            <li>Return to this tab. You do not need to reconnect your account.</li>
            <li>Select “Try again” to finish creating the workspace.</li>
          </ol>
        ) : null}
        {reauthorizationRequired && organization && organization.role !== 'admin' ? (
          <p className="mx-auto mt-5 max-w-md text-sm text-content-secondary">
            Ask an admin of {organization.orgName} to reconnect its Cloudflare account, then select “Try again”.
          </p>
        ) : reauthorizationRequired && organization ? (
          <ol className="mx-auto mt-5 max-w-md list-decimal space-y-2 pl-5 text-left text-sm text-content-secondary">
            <li>Open {organization.orgName}&apos;s settings below and reconnect its Cloudflare account.</li>
            <li>Approve the updated permissions.</li>
            <li>Return to the builder and select “Try again”.</li>
          </ol>
        ) : reauthorizationRequired ? (
          <ol className="mx-auto mt-5 max-w-md list-decimal space-y-2 pl-5 text-left text-sm text-content-secondary">
            <li>Open your Cloudflare account settings below.</li>
            <li>Reauthorize CloudChef and approve the updated permissions.</li>
            <li>Return to the builder and select “Try again”.</li>
          </ol>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {planRequired ? (
            <a
              className={buttonClassNames({ variant: 'primary', size: 'md' })}
              href={upgradeUrl ?? WORKERS_PAID_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Workers plan
            </a>
          ) : null}
          <Button variant={planRequired ? 'neutral' : 'primary'} onClick={onRetry}>
            Try again
          </Button>
          {organization ? (
            organization.role === 'admin' ? (
              <LinkButton to="/settings" hash="organizations" variant={reauthorizationRequired ? 'primary' : 'neutral'}>
                {reauthorizationRequired ? 'Open team settings' : 'Team settings'}
              </LinkButton>
            ) : null
          ) : (
            <LinkButton to="/settings" hash="cloudflare" variant={reauthorizationRequired ? 'primary' : 'neutral'}>
              {reauthorizationRequired ? 'Reauthorize Cloudflare' : 'Cloudflare account'}
            </LinkButton>
          )}
        </div>
      </section>
    </div>
  );
}

/** Said when a release is re-provisioning the runtime a chat is already sitting in. */
const WORKSPACE_RELEASE_NOTICE = 'Preparing your workspace — a new release is rolling out.';

/**
 * What the composer says while the workbench file sync is not yet live. A wait the browser is
 * still working through reads as a wait; a wait it has given up on says so and offers the retry,
 * because an unexplained "Loading project files…" is indistinguishable from a hang.
 */
function workspaceSyncNotice(state: WorkspacePresentationState, workspacePreparing: boolean): ReactNode {
  if (state === 'ready') {
    return null;
  }
  if (state === 'presentation-error') {
    return 'Editor unavailable. Chat, builds, and previews still work.';
  }
  if (state === 'unavailable') {
    // Said where the composer is closed: see chatDisabledReason.
    return null;
  }
  if (workspacePreparing) {
    return WORKSPACE_RELEASE_NOTICE;
  }
  return state === 'reconnecting' ? 'Reconnecting to your workspace…' : 'Loading project files…';
}

const ARCHIVED_LINKED_CHAT_REASON =
  'This conversation continues in a newer one. Open the project from GitHub projects in the sidebar to keep working.';

/**
 * Why the composer is closed, or null while it sends. A workspace the browser gave up reaching closes it
 * too: a message sent then would only fail, so the composer says it's paused and offers the retry.
 */
function chatDisabledReason(
  archivedLinkedChat: boolean,
  hasUnsavedFiles: boolean,
  state: WorkspacePresentationState,
  onRetry: () => void,
): ReactNode | null {
  if (archivedLinkedChat) {
    return hasUnsavedFiles
      ? `${ARCHIVED_LINKED_CHAT_REASON} Editor changes you had not saved can't be saved here.`
      : ARCHIVED_LINKED_CHAT_REASON;
  }
  if (state === 'unavailable') {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>CloudChef could not reach your workspace. Chat is paused until it reconnects.</span>
        <Button variant="neutral" size="xs" onClick={onRetry}>
          Reconnect
        </Button>
      </span>
    );
  }
  return null;
}

const AuthenticatedChat = memo(
  ({
    accountId,
    initialMessages,
    initializeChat,
    discardEmptyChat,
    onBuilderRequestStart,
    subchats,
    pendingInitialMessage,
    clearPendingInitialMessage,
    transcript,
  }: ChatProps & {
    accountId: string;
    pendingInitialMessage: string | null;
    clearPendingInitialMessage: () => void;
  }) => {
    const chatInitialId = useChatId();
    const workspacePreparing = useStore(userWorkspacePreparingStore);
    const presentationId = workspacePresentationId(accountId, transcript.agentName);
    useLayoutEffect(() => {
      loadBuilderModelPreference();
      void loadBuilderModelCatalog();
    }, []);
    useLayoutEffect(() => {
      workbenchStore.activateWorkspace(presentationId);
      toolActivityStore.activateScope(presentationId);
    }, [presentationId]);
    const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
    const hasMultipleSubchats = (subchats?.length ?? 0) > 1;
    const [liveSubchatTitle, setLiveSubchatTitle] = useState<LiveSubchatTitle | null>(null);
    const handleSubchatTitleChange = useCallback(
      (subchatIndex: number, title: string) => setLiveSubchatTitle({ subchatIndex, title }),
      [],
    );
    const [chatStarted, setChatStarted] = useState(
      initialMessages.length > 0 || hasMultipleSubchats || pendingInitialMessage !== null,
    );
    const { showChat } = useStore(chatStore);
    // A newer conversation on this GitHub project took over: this one stays to read, not to work in.
    const linkedProject = useStore(workbenchStore.linkedProject);
    const archivedLinkedChat = linkedProject?.archived === true;
    const hasUnsavedFiles = useStore(workbenchStore.unsavedFiles).size > 0;
    // Switching project resets the workbench and drops its buffers, so leaving asks first.
    useUnsavedEditsGuard(useFileSaveStatus() !== null);
    // A GitHub project already exists: its first turn changes it rather than creating a project.
    const isProjectUpdate = currentSubchatIndex > 0 || linkedProject !== null;

    const {
      messages,
      stop,
      sendMessage: sendChatMessage,
      steerMessage,
      error,
      isRecovering,
      streamStatus,
      validationStage,
      deployment,
      publication,
      deployValidatedRevision,
      requestProduction,
      cloudflareExecutions,
      decideCloudflareExecution,
      workspacePresentationState,
      retryWorkspacePresentation,
      upgradeWaiting,
    } = useBuilderAgentChat({
      accountId,
      chatInitialId,
      initialMessages,
      onSubchatTitle: handleSubchatTitleChange,
      presentationId,
      transcript,
    });
    const parsedMessages = useProcessedMessages(messages);

    useEffect(() => {
      chatStore.setKey('started', chatStarted);
      return () => {
        chatStore.set({ started: false, aborted: false, showChat: true });
      };
    }, [chatStarted]);

    const abort = () => {
      stop();
      chatStore.setKey('aborted', true);
    };

    const activeToolNames = useCurrentToolStatus(messages);
    const buildProgress = useBuildProgress({
      streamStatus,
      isRecovering,
      isProjectUpdate,
      activeToolNames,
      validationStage,
      messages,
    });

    const startChat = () => {
      if (chatStarted) {
        return;
      }
      chatStore.setKey('started', true);
      setChatStarted(true);
    };

    const { messageRef, scrollRef, enableAutoScroll } = useSnapScroll();
    const { pendingUserMessage, sendMessage, sendMessageInProgress } = useChatMessageSubmission({
      messages,
      chatStarted,
      streamStatus,
      initializeChat,
      discardEmptyChat,
      sendChatMessage,
      steerChatMessage: steerMessage,
      enableAutoScroll,
      onStartChat: startChat,
      onFirstPrompt: (prompt) => {
        const title = deriveProvisionalTitle(prompt);
        if (title) {
          handleSubchatTitleChange(currentSubchatIndex, title);
        }
      },
      onBuilderRequestStart,
      pendingMessage: pendingInitialMessage,
      clearPendingMessage: clearPendingInitialMessage,
    });
    const visibleMessages = useMemo(
      () => appendPendingUserMessage(parsedMessages, pendingUserMessage),
      [parsedMessages, pendingUserMessage],
    );
    const visibleSubchats = useMemo(
      () => applyLiveSubchatTitle(subchats, liveSubchatTitle, transcript),
      [liveSubchatTitle, subchats, transcript],
    );
    return (
      <BaseChat
        messageRef={messageRef}
        scrollRef={scrollRef}
        showChat={showChat}
        chatStarted={chatStarted}
        onStop={abort}
        onSend={sendMessage}
        streamStatus={streamStatus}
        currentError={error}
        buildProgress={buildProgress}
        messages={visibleMessages}
        disabledReason={chatDisabledReason(
          archivedLinkedChat,
          hasUnsavedFiles,
          workspacePresentationState,
          retryWorkspacePresentation,
        )}
        deployment={deployment}
        publication={publication}
        onDeploy={deployValidatedRevision}
        onRequestProduction={requestProduction}
        cloudflareExecutions={cloudflareExecutions}
        onCloudflareExecutionDecision={decideCloudflareExecution}
        runtimeNotice={
          upgradeWaiting
            ? 'Your workspace is being upgraded. Your message starts as soon as it finishes.'
            : workspaceSyncNotice(workspacePresentationState, workspacePreparing)
        }
        sendMessageInProgress={sendMessageInProgress}
        subchats={visibleSubchats}
        onSubchatTitleChange={handleSubchatTitleChange}
      />
    );
  },
);
AuthenticatedChat.displayName = 'AuthenticatedChat';
