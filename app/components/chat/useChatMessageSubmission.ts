import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatDistanceStrict } from 'date-fns';
import { toast } from 'sonner';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { workspaceHintsToTurnContext } from '~/utils/fileUtils';
import { captureMessage, captureProductEvent } from '~/lib/telemetry.client';
import { isStreamStatusActive, type StreamStatus } from '~/lib/common/types';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { getMessageInputRevision, messageInputStore, setMessageInput } from '~/lib/stores/messageInput';
import { getChatRetryState, MAX_CHAT_RETRIES } from './chat-retry';
import type { ChatTurnContext } from 'cloudchef-agent/turn-context';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { builderModelStore } from '~/lib/stores/builder-model.client';
import type { WorkersAiModelId } from '~/lib/workers-ai-model';

/**
 * Sends one builder turn. The resolved value is the AI SDK's internal send result, which no caller
 * here consumes; both submission paths only await completion.
 */
type SendChatMessage = (
  message: { text: string },
  options?: { body?: { turnContext?: ChatTurnContext; modelId?: WorkersAiModelId } },
  onRequestStart?: () => void,
) => Promise<unknown>;

const logger = createScopedLogger('ChatMessageSubmission');

export function useChatMessageSubmission(args: {
  messages: CloudChefMessage[];
  chatStarted: boolean;
  streamStatus: StreamStatus;
  initializeChat: () => Promise<{ created: boolean }>;
  discardEmptyChat: () => Promise<void>;
  sendChatMessage: SendChatMessage;
  steerChatMessage: (input: { text: string; turnContext: ChatTurnContext }) => Promise<void>;
  enableAutoScroll: () => void;
  onStartChat: () => void | Promise<void>;
  onFirstPrompt: (prompt: string) => void;
  onBuilderRequestStart: () => void;
  pendingMessage: string | null;
  clearPendingMessage: () => void;
}) {
  const [turnSubmissionInProgress, setTurnSubmissionInProgress] = useState(false);
  const [steeringInProgress, setSteeringInProgress] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const turnSubmissionInProgressRef = useRef(false);
  const steeringInProgressRef = useRef(false);
  const pendingMessageSequenceRef = useRef(0);

  const sendMessage = async (messageInput: string, onAccepted: () => void = () => undefined): Promise<boolean> => {
    const steering = isStreamStatusActive(args.streamStatus);
    const retries = getChatRetryState();
    if (retries.numFailures >= MAX_CHAT_RETRIES || Date.now() < retries.nextRetry) {
      const retryMessage =
        retries.numFailures >= MAX_CHAT_RETRIES
          ? 'CloudChef is too busy building right now. Please try again later.'
          : `CloudChef is too busy building right now. Please try again in ${formatDistanceStrict(
              Date.now(),
              retries.nextRetry,
            )}.`;
      toast.error(retryMessage);
      captureMessage('User tried to send message but CloudChef is too busy');
      return false;
    }
    const admissionRef = steering ? steeringInProgressRef : turnSubmissionInProgressRef;
    if (admissionRef.current) {
      logger.debug('Message submission already in progress');
      return false;
    }
    const pending: PendingUserMessage = {
      id: `pending-user-message-${Date.now()}-${pendingMessageSequenceRef.current++}`,
      text: messageInput,
      previousUserMessageCount: args.messages.filter((message) => message.role === 'user').length,
    };
    try {
      admissionRef.current = true;
      if (steering) {
        setSteeringInProgress(true);
      } else {
        setTurnSubmissionInProgress(true);
      }
      setPendingUserMessage(pending);
      args.enableAutoScroll();
      if (steering) {
        const { turnContext, modifiedFiles } = await prepareTurnContext(args.chatStarted);
        await args.steerChatMessage({ text: messageInput, turnContext });
        if (modifiedFiles) {
          workbenchStore.resetAllFileModifications();
        }
        onAccepted();
        return true;
      }
      const modelId = builderModelStore.get();
      if (!args.messages.some((message) => message.role === 'user')) {
        args.onFirstPrompt(messageInput);
      }
      await runChatSubmissionLifecycle({
        initializeChat: args.initializeChat,
        discardEmptyChat: args.discardEmptyChat,
        onStartChat: args.onStartChat,
        onBuilderRequestStart: () => {
          args.onBuilderRequestStart();
          onAccepted();
        },
        submit: (onRequestStart) =>
          submitMessage(messageInput, args.chatStarted, modelId, args.sendChatMessage, onRequestStart),
      });
      return true;
    } catch (error) {
      logger.error('Failed to submit chat message', error);
      const message = error instanceof Error ? error.message : 'CloudChef could not start building. Please try again.';
      toast.error(message);
      captureMessage('Failed to submit chat message', { level: 'error' });
      return false;
    } finally {
      admissionRef.current = false;
      if (steering) {
        setSteeringInProgress(false);
      } else {
        setTurnSubmissionInProgress(false);
      }
      setPendingUserMessage((current) => (current?.id === pending.id ? null : current));
    }
  };

  const sendMessageRef = useRef(sendMessage);
  useLayoutEffect(() => {
    sendMessageRef.current = sendMessage;
  });
  const pendingMessageStarted = useRef(false);
  const mountedRef = useRef(true);
  const { pendingMessage, clearPendingMessage } = args;

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!pendingMessage) {
      pendingMessageStarted.current = false;
      return;
    }
    if (pendingMessageStarted.current) {
      return;
    }
    pendingMessageStarted.current = true;
    if (!messageInputStore.get()) {
      setMessageInput(pendingMessage);
    }
    const pendingInputRevision = getMessageInputRevision();
    void (async () => {
      let restoreInputRevision = pendingInputRevision;
      const sent = await sendMessageRef.current(pendingMessage, () => {
        if (
          mountedRef.current &&
          getMessageInputRevision() === pendingInputRevision &&
          messageInputStore.get() === pendingMessage
        ) {
          setMessageInput('');
          restoreInputRevision = getMessageInputRevision();
        }
      });
      if (!mountedRef.current) {
        return;
      }
      clearPendingMessage();
      if (!sent && getMessageInputRevision() === restoreInputRevision && !messageInputStore.get()) {
        setMessageInput(pendingMessage);
      }
    })();
  }, [clearPendingMessage, pendingMessage]);

  return {
    pendingUserMessage,
    sendMessage,
    sendMessageInProgress: isStreamStatusActive(args.streamStatus) ? steeringInProgress : turnSubmissionInProgress,
  };
}

export interface PendingUserMessage {
  id: string;
  text: string;
  previousUserMessageCount: number;
}

export function appendPendingUserMessage(
  messages: CloudChefMessage[],
  pendingMessage: PendingUserMessage | null,
): CloudChefMessage[] {
  if (
    !pendingMessage ||
    messages.filter((message) => message.role === 'user').length > pendingMessage.previousUserMessageCount
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      id: pendingMessage.id,
      role: 'user',
      parts: [{ type: 'text', text: pendingMessage.text }],
    },
  ];
}

export async function runChatSubmissionLifecycle(args: {
  initializeChat: () => Promise<{ created: boolean }>;
  discardEmptyChat: () => Promise<void>;
  onStartChat: () => void | Promise<void>;
  onBuilderRequestStart: () => void;
  submit: (onRequestStart: () => void) => Promise<void>;
}): Promise<void> {
  const initializedChat = await args.initializeChat();
  let builderRequestStarted = false;
  try {
    void Promise.resolve(args.onStartChat()).catch((error) => logger.warn('Chat transition failed', error));
  } catch (error) {
    logger.warn('Chat transition failed', error);
  }
  try {
    await args.submit(() => {
      builderRequestStarted = true;
      args.onBuilderRequestStart();
    });
  } catch (error) {
    if (initializedChat.created && !builderRequestStarted) {
      try {
        await args.discardEmptyChat();
      } catch (discardError) {
        logger.warn('Failed to discard an empty chat after submission failed', discardError);
      }
    }
    throw error;
  }
}

async function submitMessage(
  messageInput: string,
  chatStarted: boolean,
  modelId: WorkersAiModelId,
  sendChatMessage: SendChatMessage,
  onRequestStart: () => void,
): Promise<void> {
  const { turnContext, modifiedFiles } = await prepareTurnContext(chatStarted);

  toolActivityStore.startTurn();
  chatStore.setKey('aborted', false);
  await sendChatMessage({ text: messageInput }, { body: { turnContext, modelId } }, onRequestStart);
  if (modifiedFiles) {
    workbenchStore.resetAllFileModifications();
  }
}

async function prepareTurnContext(
  chatStarted: boolean,
): Promise<{ turnContext: ChatTurnContext; modifiedFiles: boolean }> {
  workbenchStore.flushPendingEditorChange();
  await workbenchStore.saveUnsavedFiles();
  void captureProductEvent('prompt_submitted');
  const modifiedFiles = workbenchStore.getModifiedFiles();
  const currentFile = workbenchStore.currentDocument.get()?.filePath;
  const content = workspaceHintsToTurnContext({
    currentFile: chatStarted || modifiedFiles ? currentFile : undefined,
    changedFiles: modifiedFiles ? Object.keys(modifiedFiles) : undefined,
  });
  return { turnContext: { version: 1, content }, modifiedFiles: modifiedFiles !== undefined };
}
