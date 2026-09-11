import { useAgentChat } from '@cloudflare/ai-chat/react';
import { z } from 'zod';
import { useAgent } from 'agents/react';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BuilderAgent, BuilderAgentState, BuilderSteeringInput } from '~/agents/builder-agent';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { isAuthenticated } from '~/lib/stores/userId';
import { captureMessage } from '~/lib/telemetry.client';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { UIMessage } from 'ai';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { recordChatFailure, resetChatRetryState } from './chat-retry';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { waitForAgentSocketOpen } from './agent-connection';
import { CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER, WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showCloudflareAiFundingRequiredToast, showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { refreshChatHistory } from '~/lib/cloudflare/chat-history-db';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { description as descriptionStore } from '~/lib/stores/description';
import {
  transcriptCheckpointsEqual,
  stripTranscriptBaseMetadata,
  TRANSCRIPT_BASE_METADATA_KEY,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';
import { BuilderWorkspaceSyncController } from '~/lib/stores/builder-workspace-sync.client';
import type { BuilderWorkspaceAgent } from '~/lib/stores/builder-workspace-collection.client';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { toolProgressStore } from '~/lib/stores/tool-progress.client';
import { useQueryClient } from '@tanstack/react-query';
import { subchatQueryKey } from '~/lib/cloudflare/data-hooks';
import { settleBuilderStop } from './builder-stop';
import { refreshUserRuntimeSession, requireUserRuntimeEndpoint } from '~/lib/cloudflare/runtime-session';
import { builderModelStore } from '~/lib/stores/builder-model.client';
import { workersAiModelIdSchema } from '~/lib/workers-ai-model';
import { loadAuthoritativeTranscriptSnapshot, reconcileMessagesForSend } from './chat-send-reconciliation';
import { BUILDER_AGENT_QUERY_CACHE_TTL_MS, loadBuilderAgentCapability } from './builder-agent-auth';
import type { CloudflareExecutionDecisionHandler } from 'ghostbuild-agent/cloudflare-mcp';

const logger = createScopedLogger('BuilderAgentChat');

/** Streamed `data-tool-progress` parts arrive as untyped JSON on the agent socket. */
const toolProgressPartSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
});

/** Message metadata is caller-supplied; only an object can carry the transcript checkpoint. */
const messageMetadataSchema = z.looseObject({});

const AGENT_SEND_READY_TIMEOUT_MS = 10_000;
const AGENT_CANCEL_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Preparing the durable workspace can legitimately take minutes: after a container restart it
 * waits on the toolchain bootstrap, whose ceiling is CONTAINER_CONNECT_TIMEOUT_MS in
 * user-workspace-runtime/src/container-toolchain.ts (bootstrap + computerd download + connect
 * margin, pinned by test there). The agents SDK otherwise applies a 30-second default RPC
 * timeout, which turned a recovering workspace into an unresumable chat. Kept above that
 * ceiling by the pinning test in useBuilderAgentChat.test.tsx.
 */
export const WORKSPACE_PREPARE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * How long the browser waits between attempts to re-reach a workspace it could not open. A
 * control-plane release re-provisions the workspace runtime, and every session request answers
 * `409 workspace_preparing` for as long as the new image builds — roughly 40 seconds, observed.
 * A chat that was already open must survive that on its own, so it backs off rather than giving
 * up on the first refused connection. The last delay repeats until the attempts run out.
 */
export const WORKSPACE_RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const;

/**
 * The retry budget. Bounded on purpose: an unbounded loop is how a chat ends up sitting on a
 * spinner forever, which is the failure this exists to remove. Once it is spent the browser says
 * so and offers the retry, instead of pretending it is still loading.
 */
export const WORKSPACE_RECONNECT_ATTEMPTS = 10;

/**
 * What the workbench file sync is doing, as the chat surface should say it.
 * - `connecting`: the first attempt is in flight.
 * - `reconnecting`: an attempt failed and another is scheduled.
 * - `ready`: files are synced.
 * - `presentation-error`: the agent is reachable but the browser file cache did not load.
 * - `unavailable`: the retry budget is spent; only a deliberate retry continues.
 */
export type WorkspacePresentationState = 'connecting' | 'reconnecting' | 'ready' | 'presentation-error' | 'unavailable';

function workspaceReconnectDelayMs(attempt: number): number {
  return WORKSPACE_RECONNECT_DELAYS_MS[Math.min(attempt, WORKSPACE_RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
}

export function workspacePresentationId(accountId: string, agentName: string): string {
  return `${accountId}:${agentName}`;
}

export function useBuilderAgentChat(args: {
  accountId: string;
  chatInitialId: string;
  initialMessages: GhostbuildMessage[];
  onSubchatTitle: (subchatIndex: number, title: string) => void;
  presentationId: string;
  transcript: TranscriptIdentity;
}) {
  const activePresentationRef = useRef<string | null>(args.presentationId);
  useLayoutEffect(() => {
    activePresentationRef.current = args.presentationId;
    return () => {
      if (activePresentationRef.current === args.presentationId) {
        activePresentationRef.current = null;
      }
    };
  }, [args.presentationId]);
  const transcript = useMemo<TranscriptIdentity>(
    () => ({
      agentName: args.transcript.agentName,
      generation: args.transcript.generation,
      subchatIndex: args.transcript.subchatIndex,
    }),
    [args.transcript.agentName, args.transcript.generation, args.transcript.subchatIndex],
  );
  const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
  const previousSubchatIndexRef = useRef(currentSubchatIndex);
  const [workspacePresentation, setWorkspacePresentation] = useState<{
    gate: AsyncGate;
    state: Exclude<WorkspacePresentationState, 'connecting'>;
  } | null>(null);
  /** Bumped by a deliberate retry, which restarts the effect below with a fresh budget. */
  const [workspaceAttemptId, setWorkspaceAttemptId] = useState(0);
  const queryClient = useQueryClient();
  const generatedSubchatTitleUpdatedAtRef = useRef<string | null>(null);
  const runtimeEndpoint = new URL(requireUserRuntimeEndpoint());
  const runtimeOrigin = runtimeEndpoint.origin;
  const builderAgent = useAgent<BuilderAgent, BuilderAgentState>({
    agent: 'BuilderAgent',
    name: transcript.agentName,
    host: runtimeEndpoint.host,
    protocol: runtimeEndpoint.protocol === 'https:' ? 'wss' : 'ws',
    query: loadBuilderAgentCapability,
    queryDeps: [args.accountId, runtimeOrigin],
    // A finite query TTL replaces the live socket when it expires. Refresh the
    // short-lived capability only when the SDK reconnects or this identity changes.
    cacheTtl: BUILDER_AGENT_QUERY_CACHE_TTL_MS,
    onStateUpdate: (state) => {
      if (activePresentationRef.current !== args.presentationId) {
        return;
      }
      if (state.preview) {
        workbenchStore.updatePreview(state.preview);
      }
      workbenchStore.updatePublication(state.publication ?? null);
      const generatedTitle = state.generatedSubchatTitle;
      if (!generatedTitle || generatedSubchatTitleUpdatedAtRef.current === generatedTitle.updatedAt) {
        return;
      }
      generatedSubchatTitleUpdatedAtRef.current = generatedTitle.updatedAt;
      args.onSubchatTitle(generatedTitle.subchatIndex, generatedTitle.title);
      const chatId = args.chatInitialId;
      if (chatId) {
        void queryClient.invalidateQueries({
          queryKey: subchatQueryKey({ chatId, sessionId: args.accountId }),
        });
      }
    },
  });
  const workspaceControllerRef = useRef<BuilderWorkspaceSyncController | null>(null);
  const workspaceGateRef = useMemo(() => ({ current: createAsyncGate(args.presentationId) }), [args.presentationId]);
  const chat = useAgentChat<BuilderAgentState, UIMessage>({
    agent: builderAgent,
    getInitialMessages: null,
    messages: asUiMessages(args.initialMessages),
    syncMessagesToServer: false,
    experimental_throttle: 100,
    prepareSendMessagesRequest: ({ body }) => {
      if (!isAuthenticated()) {
        throw new Error('Not authenticated');
      }
      return {
        body: {
          ...body,
          modelId: workersAiModelIdSchema.safeParse(body?.modelId).data ?? builderModelStore.get(),
          chatInitialId: args.chatInitialId,
          subchatIndex: subchatIndexStore.get() ?? 0,
          transcript,
        },
      };
    },
    onData: (part) => {
      if (activePresentationRef.current !== args.presentationId || part.type !== 'data-tool-progress') {
        return;
      }
      const progress = toolProgressPartSchema.safeParse(part.data);
      if (progress.success && 'result' in progress.data) {
        toolProgressStore.record(progress.data);
      }
    },
    onError: (error: Error) => {
      if (activePresentationRef.current !== args.presentationId) {
        return;
      }
      captureMessage('Failed to process chat request', { level: 'error' });
      logger.error('Chat request failed', error);
      // A failure that arrived with nothing to say gives the user nothing to act on, so it is the
      // one that gets backed off; a provider that named its reason is reported and retried at will.
      recordChatFailure(error.message.trim().length === 0);
      toolActivityStore.abortActive();
      toolProgressStore.clear();
      if (error.message.includes(WORKERS_PAID_REQUIRED_MARKER)) {
        showWorkersPaidRequiredToast();
      } else if (error.message.includes(CLOUDFLARE_AI_FUNDING_REQUIRED_MARKER)) {
        showCloudflareAiFundingRequiredToast();
      }
      void refreshProjectMetadata(
        args.chatInitialId,
        args.accountId,
        () => activePresentationRef.current === args.presentationId,
      );
    },
    onFinish: ({ finishReason, message }) => {
      if (activePresentationRef.current !== args.presentationId) {
        return;
      }
      toolProgressStore.clear();
      // Record final tool outputs before stopping any provider-ended incomplete
      // calls; sampled message processing may not have observed the last chunk yet.
      toolActivityStore.finishTurn(message);
      if (finishReason === 'stop') {
        resetChatRetryState();
      }
      logger.debug('Finished streaming');
      void workspaceControllerRef.current?.pull().catch((workspaceError) => {
        logger.error('Failed to refresh the durable workspace presentation after a builder response', workspaceError);
      });
      void refreshProjectMetadata(
        args.chatInitialId,
        args.accountId,
        () => activePresentationRef.current === args.presentationId,
      );
    },
  });
  const setMessagesRef = useRef(chat.setMessages);
  const messagesRef = useRef<GhostbuildMessage[]>(chat.messages);
  const chatTerminalStateRef = useRef({ status: chat.status, isRecovering: chat.isRecovering });
  const builderTranscriptRef = useRef(builderAgent.state?.transcript);
  const stopBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const initialMessagesRef = useRef(args.initialMessages);
  useLayoutEffect(() => {
    setMessagesRef.current = chat.setMessages;
    messagesRef.current = chat.messages;
    chatTerminalStateRef.current = { status: chat.status, isRecovering: chat.isRecovering };
    builderTranscriptRef.current = builderAgent.state?.transcript;
    initialMessagesRef.current = args.initialMessages;
  });

  const readAuthoritativeTranscript = useCallback(() => {
    // `useAgent` only types `call` for the callables whose results are JSON-serializable, and a
    // transcript message may carry a `Date`. Go through the untyped RPC handle and parse the result.
    const agentRpc: BuilderWorkspaceAgent = builderAgent;
    return loadAuthoritativeTranscriptSnapshot({
      expectedIdentity: transcript,
      read: () => agentRpc.call('getTranscriptSnapshot', [transcript], { timeout: AGENT_SEND_READY_TIMEOUT_MS }),
    });
  }, [builderAgent, transcript]);

  useEffect(() => {
    let disposed = false;
    const callPreview = async (method: 'getPreviewState' | 'requestPreview') => {
      const state = await builderAgent.call(method, [], {
        timeout: method === 'getPreviewState' ? 10_000 : 30_000,
      });
      if (!disposed && activePresentationRef.current === args.presentationId) {
        workbenchStore.updatePreview(state);
      }
      return state;
    };
    const disconnect = workbenchStore.connectPreview({
      request: () => callPreview('requestPreview'),
    });
    void callPreview('getPreviewState').catch((error) => logger.warn('Unable to load remote preview state', error));
    return () => {
      disposed = true;
      disconnect();
    };
  }, [args.presentationId, builderAgent]);

  useEffect(() => {
    const previousGate = workspaceGateRef.current;
    const gate = previousGate.started ? createAsyncGate(args.presentationId) : previousGate;
    workspaceGateRef.current = gate;
    setWorkspacePresentation((presentation) => (presentation?.gate === gate ? presentation : null));
    const settleSupersededGate = () => {
      gate.error ??= new Error('The durable workspace initialization was superseded.');
      gate.resolve();
    };
    gate.started = true;
    gate.error = null;
    let disposed = false;
    let sendGateResolved = false;
    let activeController: BuilderWorkspaceSyncController | null = null;
    const isCurrentPresentation = () =>
      !disposed && activePresentationRef.current === args.presentationId && workspaceGateRef.current === gate;
    void (async () => {
      try {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
            if (!isCurrentPresentation()) {
              return;
            }
            const state = await builderAgent.call('prepareWorkspace', [], { timeout: WORKSPACE_PREPARE_TIMEOUT_MS });
            if (!state.initialized) {
              throw new Error('The durable project workspace was not initialized.');
            }
            if (!isCurrentPresentation()) {
              return;
            }
            sendGateResolved = true;
            gate.resolve();
            const agentRpc: BuilderWorkspaceAgent = builderAgent;
            const controller = await BuilderWorkspaceSyncController.initialize(agentRpc, {
              workspaceId: args.presentationId,
              isCurrent: isCurrentPresentation,
            });
            if (!isCurrentPresentation()) {
              controller.dispose();
              return;
            }
            workspaceControllerRef.current?.dispose();
            activeController = controller;
            workspaceControllerRef.current = controller;
            setWorkspacePresentation({ gate, state: 'ready' });
            return;
          } catch (workspaceError) {
            if (!isCurrentPresentation()) {
              return;
            }
            logger.error(
              sendGateResolved
                ? 'Failed to load the durable project workspace into the browser presentation cache'
                : 'Failed to initialize the durable project workspace',
              workspaceError,
            );
            // Past the gate the agent is reachable and only the browser file cache failed, so
            // retrying the connection is not the repair; the existing presentation error is.
            if (sendGateResolved) {
              setWorkspacePresentation({ gate, state: 'presentation-error' });
              return;
            }
            if (attempt + 1 >= WORKSPACE_RECONNECT_ATTEMPTS) {
              gate.error = workspaceError;
              setWorkspacePresentation({ gate, state: 'unavailable' });
              return;
            }
            setWorkspacePresentation({ gate, state: 'reconnecting' });
            // Re-admission is what discovers a release in progress: the control plane answers
            // `409 workspace_preparing` while the new runtime image builds, and this poll is what
            // publishes that to the browser and hands the agent a usable capability afterwards.
            await refreshUserRuntimeSession().catch((sessionError) =>
              logger.warn('Unable to refresh the user-owned runtime session while reconnecting', sessionError),
            );
            if (!isCurrentPresentation()) {
              return;
            }
            await delay(workspaceReconnectDelayMs(attempt));
            if (!isCurrentPresentation()) {
              return;
            }
          }
        }
      } finally {
        // A gate that never settles is a chat that can never send, so it settles on every exit.
        if (!sendGateResolved) {
          gate.resolve();
        }
      }
    })();
    return () => {
      disposed = true;
      settleSupersededGate();
      activeController?.dispose();
      if (workspaceControllerRef.current === activeController) {
        workspaceControllerRef.current = null;
      }
    };
  }, [args.presentationId, builderAgent, workspaceAttemptId, workspaceGateRef]);

  const retryWorkspacePresentation = useCallback(() => setWorkspaceAttemptId((id) => id + 1), []);
  const workspacePresentationState: WorkspacePresentationState =
    workspacePresentation?.gate === workspaceGateRef.current ? workspacePresentation.state : 'connecting';

  const sendMessage = useCallback(
    async (
      message: Parameters<typeof chat.sendMessage>[0],
      options?: Parameters<typeof chat.sendMessage>[1],
      onRequestStart?: () => void,
    ) => {
      const workspaceGate = workspaceGateRef.current;
      const assertCurrentPresentation = () => {
        if (
          activePresentationRef.current !== args.presentationId ||
          workspaceGateRef.current !== workspaceGate ||
          workspaceGate.error
        ) {
          throw workspaceGate.error ?? new Error('The durable workspace initialization was superseded.');
        }
      };
      await Promise.all([workspaceGate.promise, stopBarrierRef.current]);
      assertCurrentPresentation();
      try {
        await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
      } catch (error) {
        logger.warn('Builder connection was not ready before send', error);
        captureMessage('Builder connection was not ready before send', {
          level: 'error',
        });
        throw error;
      }
      assertCurrentPresentation();
      if (message !== undefined) {
        const snapshot = await readAuthoritativeTranscript();
        assertCurrentPresentation();
        const localMessages = messagesRef.current;
        const reconciledMessages = await reconcileMessagesForSend({
          snapshot,
          localMessages,
        });
        assertCurrentPresentation();
        if (reconciledMessages !== localMessages) {
          setMessagesRef.current(asUiMessages(reconciledMessages));
        }
        const metadata = ('metadata' in message && messageMetadataSchema.safeParse(message.metadata).data) || {};
        try {
          const request = chat.sendMessage(
            {
              ...message,
              metadata: { ...metadata, [TRANSCRIPT_BASE_METADATA_KEY]: snapshot.checkpoint },
            },
            options,
          );
          onRequestStart?.();
          return await request;
        } finally {
          setMessagesRef.current((messages) => messages.map(stripTranscriptBaseMetadata));
        }
      }
      const request = chat.sendMessage(message, options);
      onRequestStart?.();
      return request;
    },
    [args.presentationId, builderAgent, chat, readAuthoritativeTranscript, workspaceGateRef],
  );

  const deployValidatedRevision = useCallback(
    () => builderAgent.call('deployValidatedRevision', [], { timeout: 30 * 60_000 }),
    [builderAgent],
  );

  const decideCloudflareExecution = useCallback<CloudflareExecutionDecisionHandler>(
    async (executionId, decision) => {
      const method = decision === 'approve' ? 'approveCloudflareExecution' : 'rejectCloudflareExecution';
      const result = await builderAgent.call(method, [{ executionId }], { timeout: 2 * 60_000 });
      if (result.resumeTurn) {
        const status = result.execution.status;
        await sendMessage({
          id: `cloudflare-execution-decision-${crypto.randomUUID()}`,
          role: 'user',
          parts: [
            {
              type: 'text',
              text:
                decision === 'approve'
                  ? `I approved Cloudflare execution ${executionId}. Its durable result status is ${status}. Continue from that result; reconcile before retrying if it is indeterminate.`
                  : `I rejected Cloudflare execution ${executionId}. Continue without performing that proposed change.`,
            },
          ],
        });
      }
      return result;
    },
    [builderAgent, sendMessage],
  );

  const steerMessage = useCallback(
    async (input: BuilderSteeringInput) => {
      const workspaceGate = workspaceGateRef.current;
      const assertCurrentPresentation = () => {
        if (
          activePresentationRef.current !== args.presentationId ||
          workspaceGateRef.current !== workspaceGate ||
          workspaceGate.error
        ) {
          throw workspaceGate.error ?? new Error('The durable workspace initialization was superseded.');
        }
      };
      await workspaceGate.promise;
      assertCurrentPresentation();
      await waitForAgentSocketOpen(builderAgent, AGENT_SEND_READY_TIMEOUT_MS, { requireIdentity: false });
      assertCurrentPresentation();
      await builderAgent.call('steerActiveTurn', [input]);
    },
    [args.presentationId, builderAgent, workspaceGateRef],
  );

  const stop = useCallback(() => {
    void chat.stop();
    toolActivityStore.abortActive();
    toolProgressStore.clear();
    const cancellation = settleBuilderStop({
      cancel: () => builderAgent.call('cancelActiveTurn', [], { timeout: AGENT_CANCEL_SETTLE_TIMEOUT_MS }),
      reconcileMessages: (messages) => setMessagesRef.current(asUiMessages(messages)),
      refreshWorkspace: async () => {
        await workspaceControllerRef.current?.pull();
      },
    })
      .then(() => undefined)
      .catch((error) => {
        logger.error('Failed to durably cancel and reconcile the active builder turn', error);
        captureMessage('Failed to process chat request', { level: 'error' });
      });
    stopBarrierRef.current = cancellation;
  }, [builderAgent, chat]);

  useEffect(() => {
    if (previousSubchatIndexRef.current === currentSubchatIndex) {
      return;
    }
    previousSubchatIndexRef.current = currentSubchatIndex;
    toolActivityStore.abortActive();
    toolProgressStore.clear();
    setMessagesRef.current(asUiMessages(initialMessagesRef.current));
  }, [currentSubchatIndex]);

  useEffect(() => {
    const durableCheckpoint = builderAgent.state?.transcript;
    if (durableCheckpoint === undefined || (chat.status !== 'ready' && chat.status !== 'error') || chat.isRecovering) {
      return undefined;
    }
    let disposed = false;
    const isCurrentPresentation = () => !disposed && activePresentationRef.current === args.presentationId;
    void readAuthoritativeTranscript()
      .then(async (snapshot) => {
        const terminal = chatTerminalStateRef.current;
        if (
          !isCurrentPresentation() ||
          (terminal.status !== 'ready' && terminal.status !== 'error') ||
          terminal.isRecovering ||
          !transcriptCheckpointsEqual(builderTranscriptRef.current ?? null, snapshot.checkpoint)
        ) {
          return;
        }
        const localMessages = messagesRef.current;
        const reconciledMessages = await reconcileMessagesForSend({ snapshot, localMessages });
        if (isCurrentPresentation() && reconciledMessages !== localMessages) {
          setMessagesRef.current(asUiMessages(reconciledMessages));
        }
      })
      .catch((error) => logger.warn('Unable to reconcile the durable builder transcript', error));
    return () => {
      disposed = true;
    };
  }, [
    args.presentationId,
    builderAgent.state?.transcript,
    chat.isRecovering,
    chat.status,
    readAuthoritativeTranscript,
  ]);

  return {
    ...chat,
    stop,
    sendMessage,
    steerMessage,
    messages: chat.messages satisfies GhostbuildMessage[],
    streamStatus: chat.isRecovering ? ('submitted' as const) : chat.isStreaming ? ('streaming' as const) : chat.status,
    validationStage: builderAgent.state?.validationProgress?.stage ?? null,
    deployment: builderAgent.state?.deployment ?? null,
    publication: builderAgent.state?.publication ?? null,
    deployValidatedRevision,
    cloudflareExecutions: builderAgent.state?.cloudflareExecutions ?? [],
    decideCloudflareExecution,
    workspacePresentationState,
    retryWorkspacePresentation,
  };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

type AsyncGate = {
  key: string | null;
  promise: Promise<void>;
  resolve: () => void;
  error: unknown;
  started: boolean;
};

function createAsyncGate(key: string | null): AsyncGate {
  if (key === null) {
    return {
      key,
      promise: Promise.resolve(),
      resolve: () => undefined,
      error: null,
      started: false,
    };
  }
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { key, promise, resolve, error: null, started: false };
}

function asUiMessages(messages: GhostbuildMessage[]): UIMessage[] {
  // SAFETY: `GhostbuildMessage` is the AI SDK `UIMessage` shape with a deliberately open part union
  // (see `ghostbuild-agent/ai-compat`). Every message reaching this bridge came out of the AI SDK
  // chat store, or out of the durable transcript the agent persisted from that same store.
  return messages as UIMessage[];
}

async function refreshProjectMetadata(
  chatId: string,
  accountId: string,
  isActive: () => boolean,
  attempt = 0,
): Promise<void> {
  if (!chatId || !isActive()) {
    return;
  }
  try {
    const [, chat] = await Promise.all([
      refreshChatHistory(accountId),
      executeDataOperation(api.messages.get, { id: chatId, sessionId: accountId }),
    ]);
    if (!isActive()) {
      return;
    }
    if (chat?.description) {
      descriptionStore.set(chat.description);
    } else if (attempt < 2) {
      window.setTimeout(
        () => void refreshProjectMetadata(chatId, accountId, isActive, attempt + 1),
        (attempt + 1) * 1_000,
      );
    }
  } catch (error) {
    logger.debug('Unable to refresh generated project title', error);
  }
}
