import { useAgentChat } from '@cloudflare/ai-chat/react';
import { z } from 'zod';
import { useAgent } from 'agents/react';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationAgent, ConversationAgentState, BuilderSteeringInput } from '~/agents/conversation-agent';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { captureMessage } from '~/lib/telemetry.client';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import type { UIMessage } from 'ai';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { recordChatFailure, resetChatRetryState } from './chat-retry';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { waitForAgentSocketOpen } from './agent-connection';
import { WORKERS_PAID_REQUIRED_MARKER } from '~/lib/workers-paid';
import { showWorkersPaidRequiredToast } from '~/lib/workers-paid.client';
import { refreshWorkspaceHistory } from '~/lib/cloudflare/workspace-history-db';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { description as descriptionStore } from '~/lib/stores/description';
import {
  transcriptCheckpointsEqual,
  stripTranscriptBaseMetadata,
  TRANSCRIPT_BASE_METADATA_KEY,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import { BuilderWorkspaceSyncController } from '~/lib/stores/builder-workspace-sync.client';
import type { BuilderWorkspaceAgent } from '~/lib/stores/builder-workspace-collection.client';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { toolProgressStore } from '~/lib/stores/tool-progress.client';
import { projectRevertStore } from '~/lib/stores/project-actions.client';
import { useQueryClient } from '@tanstack/react-query';
import { conversationsQueryKey } from '~/lib/cloudflare/data-hooks';
import { settleBuilderStop } from './builder-stop';
import {
  refreshUserRuntimeSession,
  requireUserRuntimeEndpoint,
  resetUserRuntimeSession,
  runtimeSessionNeedsAction,
} from '~/lib/cloudflare/runtime-session';
import { builderModelRequestFields, builderModelStore } from '~/lib/stores/builder-model.client';
import { builderModelIdSchema } from '~/lib/workers-ai-model';
import { loadAuthoritativeTranscriptSnapshot, reconcileMessagesForSend } from './chat-send-reconciliation';
import { CONVERSATION_AGENT_QUERY_CACHE_TTL_MS, loadConversationAgentCapability } from './conversation-agent-auth';
import type { CloudflareExecutionDecisionHandler } from 'cloudchef-agent/cloudflare-api';

const logger = createScopedLogger('ConversationAgentChat');

/** Streamed `data-tool-progress` parts arrive as untyped JSON on the agent socket. */
const toolProgressPartSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
});

const AGENT_SEND_READY_TIMEOUT_MS = 10_000;
const AGENT_CANCEL_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;

/** What restoring a version answers: which files it changed, none when they already matched. */
const revertResultSchema = z.object({ changedPaths: z.array(z.string()) });

/**
 * Preparing the durable workspace can legitimately take minutes: after a container restart it
 * waits on the toolchain bootstrap, whose ceiling is CONTAINER_CONNECT_TIMEOUT_MS in
 * user-workspace-runtime/src/container-toolchain.ts (bootstrap + computerd download + connect
 * margin, pinned by test there). The agents SDK otherwise applies a 30-second default RPC
 * timeout, which turned a recovering workspace into an unresumable chat. Kept above that
 * ceiling by the pinning test in useConversationAgentChat.test.tsx. A team project's first open also imports
 * its history, which may take the import's own 30 minutes (`IMPORT_TIMEOUT_MS` in project-repository.ts),
 * so this waits longer than that.
 */
export const WORKSPACE_PREPARE_TIMEOUT_MS = 35 * 60 * 1000;

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
 * - `failed`: the agent answered that the project's files could not be put in the workspace (a team
 *   project's import refused, say); reconnecting would only repeat it, so only a deliberate retry continues.
 */
export type WorkspacePresentationState =
  'connecting' | 'reconnecting' | 'ready' | 'presentation-error' | 'unavailable' | 'failed';

function workspaceReconnectDelayMs(attempt: number): number {
  return WORKSPACE_RECONNECT_DELAYS_MS[Math.min(attempt, WORKSPACE_RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
}

export function workspacePresentationId(accountId: string, agentName: string): string {
  return `${accountId}:${agentName}`;
}

export function useConversationAgentChat(args: {
  accountId: string;
  chatInitialId: string;
  initialMessages: CloudChefMessage[];
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
    () => ({ agentName: args.transcript.agentName, subchatIndex: args.transcript.subchatIndex }),
    [args.transcript.agentName, args.transcript.subchatIndex],
  );
  const currentSubchatIndex = useStore(subchatIndexStore) ?? 0;
  const previousSubchatIndexRef = useRef(currentSubchatIndex);
  const [workspacePresentation, setWorkspacePresentation] = useState<{
    gate: AsyncGate;
    state: Exclude<WorkspacePresentationState, 'connecting'>;
    /** Why, when `failed`: the agent's own words. */
    failure?: string;
  } | null>(null);
  /** Bumped by a deliberate retry, which restarts the effect below with a fresh budget. */
  const [workspaceAttemptId, setWorkspaceAttemptId] = useState(0);
  const queryClient = useQueryClient();
  const generatedSubchatTitleUpdatedAtRef = useRef<string | null>(null);
  const runtimeEndpoint = new URL(requireUserRuntimeEndpoint());
  const runtimeOrigin = runtimeEndpoint.origin;
  // Set while the workspace is being upgraded and the person's message waits to start.
  const [upgradeWaiting, setUpgradeWaiting] = useState(false);
  const conversationAgent = useAgent<ConversationAgent, ConversationAgentState>({
    agent: 'ConversationAgent',
    name: transcript.agentName,
    host: runtimeEndpoint.host,
    protocol: runtimeEndpoint.protocol === 'https:' ? 'wss' : 'ws',
    query: loadConversationAgentCapability,
    queryDeps: [args.accountId, runtimeOrigin],
    // A finite query TTL replaces the live socket when it expires. Refresh the
    // short-lived capability only when the SDK reconnects or this identity changes.
    cacheTtl: CONVERSATION_AGENT_QUERY_CACHE_TTL_MS,
    onStateUpdate: (state) => {
      if (activePresentationRef.current !== args.presentationId) {
        return;
      }
      workbenchStore.updateSite({
        url: state.productionUrl ?? state.deployment?.productionUrl ?? null,
        revision: state.productionRevision ?? null,
        deployment: state.deployment ?? null,
      });
      workbenchStore.updatePublication(state.publication ?? null);
      setUpgradeWaiting(state.upgradeWaiting === true);
      const linked = state.linkedProject ?? null;
      const shownLinked = workbenchStore.linkedProject.get();
      if (linked?.repository !== shownLinked?.repository || linked?.defaultBranch !== shownLinked?.defaultBranch) {
        workbenchStore.linkedProject.set(linked);
      }
      const site = state.linkedSite ?? null;
      const shownSite = workbenchStore.linkedSite.get();
      if (site?.url !== shownSite?.url || site?.frameable !== shownSite?.frameable || site?.kind !== shownSite?.kind) {
        workbenchStore.linkedSite.set(site);
      }
      workbenchStore.conversationClosed.set(state.conversationClosed === true);
      workbenchStore.conversationAdopted.set(state.conversationAdopted === true);
      const generatedTitle = state.generatedSubchatTitle;
      if (!generatedTitle || generatedSubchatTitleUpdatedAtRef.current === generatedTitle.updatedAt) {
        return;
      }
      generatedSubchatTitleUpdatedAtRef.current = generatedTitle.updatedAt;
      args.onSubchatTitle(generatedTitle.subchatIndex, generatedTitle.title);
      const workspaceId = args.chatInitialId;
      if (workspaceId) {
        void queryClient.invalidateQueries({
          queryKey: conversationsQueryKey({ workspaceId, sessionId: args.accountId }),
        });
      }
    },
  });
  const workspaceControllerRef = useRef<BuilderWorkspaceSyncController | null>(null);
  // presentationId is the key, not an input: changing presentation must hand out a fresh gate.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate re-key
  const workspaceGateRef = useMemo(() => ({ current: createAsyncGate() }), [args.presentationId]);
  const chat = useAgentChat<ConversationAgentState, UIMessage>({
    agent: conversationAgent,
    getInitialMessages: null,
    messages: asUiMessages(args.initialMessages),
    syncMessagesToServer: false,
    throttle: 100,
    prepareSendMessagesRequest: ({ body }) => {
      return {
        body: {
          ...body,
          // The model, and the effort the person chose for it; none at all means the provider's default.
          ...builderModelRequestFields(builderModelIdSchema.safeParse(body?.modelId).data ?? builderModelStore.get()),
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
  const messagesRef = useRef<CloudChefMessage[]>(chat.messages);
  const chatTerminalStateRef = useRef({ status: chat.status, isRecovering: chat.isRecovering });
  const builderTranscriptRef = useRef(conversationAgent.state?.transcript);
  const stopBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const initialMessagesRef = useRef(args.initialMessages);
  useLayoutEffect(() => {
    setMessagesRef.current = chat.setMessages;
    messagesRef.current = chat.messages;
    chatTerminalStateRef.current = { status: chat.status, isRecovering: chat.isRecovering };
    builderTranscriptRef.current = conversationAgent.state?.transcript;
    initialMessagesRef.current = args.initialMessages;
  });

  useLayoutEffect(() => {
    if (chat.isStreaming || chat.isRecovering) {
      toolActivityStore.resumeTurn(chat.messages.at(-1));
    }
  }, [chat.isStreaming, chat.isRecovering, chat.messages]);

  const readAuthoritativeTranscript = useCallback(() => {
    // `useAgent` only types `call` for the callables whose results are JSON-serializable, and a
    // transcript message may carry a `Date`. Go through the untyped RPC handle and parse the result.
    const agentRpc: BuilderWorkspaceAgent = conversationAgent;
    return loadAuthoritativeTranscriptSnapshot({
      expectedIdentity: transcript,
      read: () => agentRpc.call('getTranscriptSnapshot', [transcript], { timeout: AGENT_SEND_READY_TIMEOUT_MS }),
    });
  }, [conversationAgent, transcript]);

  // The gate holder is a per-presentation mutable cell made during render (above), not a value React tracks:
  // a send started before this effect runs must wait on the new presentation's gate, so it is written here.
  /* eslint-disable react-hooks/immutability */
  useEffect(() => {
    const previousGate = workspaceGateRef.current;
    const gate = previousGate.started ? createAsyncGate() : previousGate;
    workspaceGateRef.current = gate;
    setWorkspacePresentation((presentation) => (presentation?.gate === gate ? presentation : null));
    const settleSupersededGate = () => {
      gate.error ??= new Error(WORKSPACE_SUPERSEDED_MESSAGE);
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
            await waitForAgentSocketOpen(conversationAgent, AGENT_SEND_READY_TIMEOUT_MS);
            if (!isCurrentPresentation()) {
              return;
            }
            const state = await conversationAgent.call('prepareWorkspace', [], {
              timeout: WORKSPACE_PREPARE_TIMEOUT_MS,
            });
            if ('failure' in state) {
              if (isCurrentPresentation()) {
                gate.error = new Error(state.failure);
                setWorkspacePresentation({ gate, state: 'failed', failure: state.failure });
              }
              return;
            }
            if (!state.initialized) {
              throw new Error('The durable project workspace was not initialized.');
            }
            if (!isCurrentPresentation()) {
              return;
            }
            sendGateResolved = true;
            gate.resolve();
            const agentRpc: BuilderWorkspaceAgent = conversationAgent;
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
            // Re-admission is what discovers a runtime being rebuilt: the control plane answers
            // `409 workspace_preparing` while a runtime that cannot serve this browser is prepared,
            // and this poll publishes that and hands the agent a usable capability afterwards. A
            // runtime merely from an earlier release keeps answering while its upgrade waits.
            await refreshUserRuntimeSession().catch((sessionError: Error) => {
              logger.warn('Unable to refresh the user-owned runtime session while reconnecting', sessionError);
              // Reconnecting can't fix a refusal only the person can act on, such as Cloudflare permissions
              // to approve again: dropping the session puts the chat's own explanation of it in its place.
              if (runtimeSessionNeedsAction(sessionError)) {
                resetUserRuntimeSession();
              }
            });
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
  }, [args.presentationId, conversationAgent, workspaceAttemptId, workspaceGateRef]);
  /* eslint-enable react-hooks/immutability */

  const retryWorkspacePresentation = useCallback(() => setWorkspaceAttemptId((id) => id + 1), []);
  // Read during render on purpose: a presentation from a gate this render no longer holds is stale (see above).
  // eslint-disable-next-line react-hooks/refs
  const currentPresentation = workspacePresentation?.gate === workspaceGateRef.current ? workspacePresentation : null;
  const workspacePresentationState: WorkspacePresentationState = currentPresentation?.state ?? 'connecting';
  const workspaceFailure = currentPresentation?.failure ?? null;

  const assertCurrentPresentation = useCallback(
    (gate: AsyncGate) => {
      if (activePresentationRef.current !== args.presentationId || workspaceGateRef.current !== gate || gate.error) {
        throw gate.error ?? new Error(WORKSPACE_SUPERSEDED_MESSAGE);
      }
    },
    [args.presentationId, workspaceGateRef],
  );

  const sendMessage = useCallback(
    async (
      message: NonNullable<Parameters<typeof chat.sendMessage>[0]>,
      options?: Parameters<typeof chat.sendMessage>[1],
      onRequestStart?: () => void,
    ) => {
      const workspaceGate = workspaceGateRef.current;
      await Promise.all([workspaceGate.promise, stopBarrierRef.current]);
      assertCurrentPresentation(workspaceGate);
      try {
        await waitForAgentSocketOpen(conversationAgent, AGENT_SEND_READY_TIMEOUT_MS);
      } catch (error) {
        logger.warn('Builder connection was not ready before send', error);
        captureMessage('Builder connection was not ready before send', {
          level: 'error',
        });
        throw error;
      }
      assertCurrentPresentation(workspaceGate);
      const snapshot = await readAuthoritativeTranscript();
      assertCurrentPresentation(workspaceGate);
      const localMessages = messagesRef.current;
      const reconciledMessages = await reconcileMessagesForSend({
        snapshot,
        localMessages,
      });
      assertCurrentPresentation(workspaceGate);
      if (reconciledMessages !== localMessages) {
        setMessagesRef.current(asUiMessages(reconciledMessages));
      }
      try {
        const request = chat.sendMessage(
          { ...message, metadata: { [TRANSCRIPT_BASE_METADATA_KEY]: snapshot.checkpoint } },
          options,
        );
        onRequestStart?.();
        return await request;
      } finally {
        setMessagesRef.current((messages) => messages.map(stripTranscriptBaseMetadata));
      }
    },
    [assertCurrentPresentation, conversationAgent, chat, readAuthoritativeTranscript, workspaceGateRef],
  );

  const deployValidatedRevision = useCallback(async () => {
    await waitForAgentSocketOpen(conversationAgent, AGENT_SEND_READY_TIMEOUT_MS);
    return conversationAgent.call('deployValidatedRevision', [], { timeout: 30 * 60_000 });
  }, [conversationAgent]);

  useEffect(() => workbenchStore.connectSite({ publish: deployValidatedRevision }), [deployValidatedRevision]);

  const requestProduction = useCallback(
    async (input: { title: string; note: string }) => {
      await waitForAgentSocketOpen(conversationAgent, AGENT_SEND_READY_TIMEOUT_MS);
      const { outcome } = await conversationAgent.call('requestProduction', [input], { timeout: 2 * 60_000 });
      return outcome;
    },
    [conversationAgent],
  );

  // History reverts through this connection: the agent applies the commit's files as one change set, and
  // refuses while a turn runs.
  useEffect(() => {
    const agentRpc: BuilderWorkspaceAgent = conversationAgent;
    projectRevertStore.set(async (commit) => {
      await waitForAgentSocketOpen(conversationAgent, AGENT_SEND_READY_TIMEOUT_MS);
      const result = revertResultSchema.safeParse(
        await agentRpc.call('revertToCommit', [commit], { timeout: 2 * 60_000 }),
      );
      // Unreadable answers are reported as a change, the restore having been asked for and not refused.
      return { changed: !result.success || result.data.changedPaths.length > 0 };
    });
    return () => projectRevertStore.set(null);
  }, [conversationAgent]);

  const decideCloudflareExecution = useCallback<CloudflareExecutionDecisionHandler>(
    async (executionId, decision) => {
      const method = decision === 'approve' ? 'approveCloudflareExecution' : 'rejectCloudflareExecution';
      await waitForAgentSocketOpen(conversationAgent, AGENT_SEND_READY_TIMEOUT_MS);
      const result = await conversationAgent.call(method, [{ executionId }], { timeout: 2 * 60_000 });
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
    [conversationAgent, sendMessage],
  );

  // A change filed for the team's admins: once one of them decides it while this chat is open, the agent carries on
  // from the result, as after the person's own approval. Only a decision seen arriving here does that, once.
  const filedApprovalsRef = useRef(new Set<string>());
  useEffect(() => {
    const decided = decidedTeamApprovals(chat.messages, filedApprovalsRef.current);
    if (decided.length === 0 || chat.status !== 'ready' || chat.isRecovering) {
      return;
    }
    for (const approvalId of decided) {
      filedApprovalsRef.current.delete(approvalId);
    }
    sendMessage({
      id: `team-approval-decided-${crypto.randomUUID()}`,
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'A team admin decided the Cloudflare change I asked for; its result is in that step. Continue from it.',
        },
      ],
    }).catch((error: Error) => logger.warn('Unable to continue after a team admin decided', error));
  }, [chat.messages, chat.status, chat.isRecovering, sendMessage]);

  const steerMessage = useCallback(
    async (input: BuilderSteeringInput) => {
      const workspaceGate = workspaceGateRef.current;
      await workspaceGate.promise;
      assertCurrentPresentation(workspaceGate);
      await waitForAgentSocketOpen(conversationAgent, AGENT_SEND_READY_TIMEOUT_MS);
      assertCurrentPresentation(workspaceGate);
      await conversationAgent.call('steerActiveTurn', [input]);
    },
    [assertCurrentPresentation, conversationAgent, workspaceGateRef],
  );

  const stop = useCallback(() => {
    void chat.stop();
    toolActivityStore.abortActive();
    toolProgressStore.clear();
    const cancellation = settleBuilderStop({
      cancel: () => conversationAgent.call('cancelActiveTurn', [], { timeout: AGENT_CANCEL_SETTLE_TIMEOUT_MS }),
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
  }, [conversationAgent, chat]);

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
    const durableCheckpoint = conversationAgent.state?.transcript;
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
    conversationAgent.state?.transcript,
    chat.isRecovering,
    chat.status,
    readAuthoritativeTranscript,
  ]);

  return {
    ...chat,
    upgradeWaiting,
    stop,
    sendMessage,
    steerMessage,
    messages: chat.messages satisfies CloudChefMessage[],
    streamStatus: chat.isRecovering ? ('submitted' as const) : chat.isStreaming ? ('streaming' as const) : chat.status,
    validationStage: conversationAgent.state?.validationProgress?.stage ?? null,
    deployment: conversationAgent.state?.deployment ?? null,
    publication: conversationAgent.state?.publication ?? null,
    deployValidatedRevision,
    requestProduction,
    cloudflareExecutions: conversationAgent.state?.cloudflareExecutions ?? [],
    decideCloudflareExecution,
    workspacePresentationState,
    workspaceFailure,
    retryWorkspacePresentation,
  };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const WORKSPACE_SUPERSEDED_MESSAGE = 'The durable workspace initialization was superseded.';

type AsyncGate = {
  promise: Promise<void>;
  resolve: () => void;
  error: unknown;
  started: boolean;
};

function createAsyncGate(): AsyncGate {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve, error: null, started: false };
}

function asUiMessages(messages: CloudChefMessage[]): UIMessage[] {
  // SAFETY: `CloudChefMessage` is the AI SDK `UIMessage` shape with a deliberately open part union
  // (see `cloudchef-agent/ai-compat`). Every message reaching this bridge came out of the AI SDK
  // chat store, or out of the durable transcript the agent persisted from that same store.
  return messages as UIMessage[];
}

async function refreshProjectMetadata(
  workspaceId: string,
  accountId: string,
  isActive: () => boolean,
  attempt = 0,
): Promise<void> {
  if (!workspaceId || !isActive()) {
    return;
  }
  try {
    const [, chat] = await Promise.all([
      refreshWorkspaceHistory(accountId),
      executeDataOperation(api.messages.get, { id: workspaceId }),
    ]);
    if (!isActive()) {
      return;
    }
    if (chat?.description) {
      descriptionStore.set(chat.description);
    } else if (attempt < 2) {
      window.setTimeout(
        () => void refreshProjectMetadata(workspaceId, accountId, isActive, attempt + 1),
        (attempt + 1) * 1_000,
      );
    }
  } catch {
    // The title stays as it is until the project is next opened.
  }
}

const filedOutputSchema = z.object({
  output: z.object({ kind: z.literal('cloudflare_request_filed'), approvalId: z.string() }),
});
const decidedOutputSchema = z.object({
  output: z.object({ kind: z.literal('cloudflare_request_final_result'), executionId: z.string() }),
});

/**
 * Notes each change `messages` show waiting for a team's admins in `filed`, and answers those noted earlier that
 * now show a result.
 */
function decidedTeamApprovals(messages: readonly UIMessage[], filed: Set<string>): string[] {
  const decided: string[] = [];
  for (const part of messages.flatMap((message) => message.parts)) {
    const waiting = filedOutputSchema.safeParse(part);
    if (waiting.success) {
      filed.add(waiting.data.output.approvalId);
      continue;
    }
    const result = decidedOutputSchema.safeParse(part);
    if (result.success && filed.has(result.data.output.executionId)) {
      decided.push(result.data.output.executionId);
    }
  }
  return decided;
}
