import { z } from 'zod';
import { useAgent } from 'agents/react';
import { useStore } from '@nanostores/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationAgent, ConversationAgentState, BuilderSteeringInput } from '~/agents/conversation-agent';
import { applyChatFrame, chatFrameSchema } from 'cloudchef-agent/chat-frame';
import type { ChatTurnContext } from 'cloudchef-agent/turn-context';
import type { BuilderModelId } from '~/lib/workers-ai-model';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { captureMessage } from '~/lib/telemetry.client';
import { createScopedLogger } from 'cloudchef-agent/utils/logger';
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
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';
import { BuilderWorkspaceSyncController } from '~/lib/stores/builder-workspace-sync.client';
import type { BuilderWorkspaceAgent } from '~/lib/stores/builder-workspace-collection.client';
import { toolActivityStore } from '~/lib/stores/tool-activity.client';
import { toolProgressStore } from '~/lib/stores/tool-progress.client';
import { projectRevertStore } from '~/lib/stores/project-actions.client';
import { agentWorkingStore } from '~/lib/cloudflare/project-presence.client';
import { useQueryClient } from '@tanstack/react-query';
import { conversationsQueryKey } from '~/lib/cloudflare/data-hooks';
import {
  refreshUserRuntimeSession,
  requireUserRuntimeEndpoint,
  resetUserRuntimeSession,
  runtimeSessionNeedsAction,
} from '~/lib/cloudflare/runtime-session';
import { builderModelRequestFields, builderModelStore } from '~/lib/stores/builder-model.client';
import { CONVERSATION_AGENT_QUERY_CACHE_TTL_MS, loadConversationAgentCapability } from './conversation-agent-auth';
import type { CloudflareExecutionDecisionHandler } from 'cloudchef-agent/cloudflare-api';

const logger = createScopedLogger('ConversationAgentChat');

const AGENT_SEND_READY_TIMEOUT_MS = 10_000;
const AGENT_CANCEL_SETTLE_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * How long a send waits for the agent to start the turn: it waits first for a workspace upgrade (up to three
 * minutes) and for a new workspace to be seeded, which may take as long as preparing it.
 */
const AGENT_SEND_TIMEOUT_MS = 35 * 60 * 1000;

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
  onSubchatTitle: (conversationIndex: number, title: string) => void;
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
    () => ({ agentName: args.transcript.agentName, conversationIndex: args.transcript.conversationIndex }),
    [args.transcript.agentName, args.transcript.conversationIndex],
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
  /** Handles the chat frames the agent sends; set each render, so the socket listener reads the newest one. */
  const receiveFrameRef = useRef<(event: MessageEvent, presentationId: string) => void>(() => undefined);
  /** The presentation a socket's frames belong to: one connected for an earlier presentation is not listened to. */
  const framePresentationId = args.presentationId;
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
    // The chat itself: the agent sends the whole chat when the socket connects, then what changed.
    onMessage: (event: MessageEvent) => receiveFrameRef.current(event, framePresentationId),
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
      const generatedTitle = state.generatedConversationTitle;
      if (!generatedTitle || generatedSubchatTitleUpdatedAtRef.current === generatedTitle.updatedAt) {
        return;
      }
      generatedSubchatTitleUpdatedAtRef.current = generatedTitle.updatedAt;
      args.onSubchatTitle(generatedTitle.conversationIndex, generatedTitle.title);
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
  // oxlint-disable-next-line react/exhaustive-deps -- deliberate re-key
  const workspaceGateRef = useMemo(() => ({ current: createAsyncGate() }), [args.presentationId]);
  const [messages, setMessages] = useState<CloudChefMessage[]>(args.initialMessages);
  const [busy, setBusy] = useState(false);
  /** A message is on its way to the agent, which has not started its turn yet. */
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<Error | null>(null);
  const messagesRef = useRef<CloudChefMessage[]>(messages);
  const busyRef = useRef(false);
  const initialMessagesRef = useRef(args.initialMessages);
  const stopBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const finishRun = (finished: readonly CloudChefMessage[]) => {
    toolProgressStore.clear();
    // Record final tool outputs before stopping any provider-ended incomplete calls.
    const last = finished.at(-1);
    if (last?.role === 'assistant') {
      toolActivityStore.finishTurn(last);
    }
    if (!conversationAgent.state?.turnError) {
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
  };
  const receiveFrame = (event: MessageEvent, presentationId: string) => {
    const text = z.string().safeParse(event.data).data;
    if (presentationId !== args.presentationId || activePresentationRef.current !== args.presentationId || !text) {
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const frame = chatFrameSchema.safeParse(data);
    if (!frame.success) {
      return;
    }
    const next = applyChatFrame(messagesRef.current, frame.data);
    messagesRef.current = next;
    setMessages(next);
    for (const progress of frame.data.progress) {
      toolProgressStore.record(progress);
    }
    const wasBusy = busyRef.current;
    busyRef.current = frame.data.busy;
    setBusy(frame.data.busy);
    if (frame.data.busy) {
      setSending(false);
      toolActivityStore.resumeTurn(next.at(-1));
    } else if (wasBusy) {
      finishRun(next);
    }
  };
  useLayoutEffect(() => {
    messagesRef.current = messages;
    initialMessagesRef.current = args.initialMessages;
    receiveFrameRef.current = receiveFrame;
  });
  const turnError = conversationAgent.state?.turnError ?? null;
  const error = useMemo(() => sendError ?? (turnError ? new Error(turnError) : undefined), [sendError, turnError]);
  useEffect(() => {
    if (!turnError || activePresentationRef.current !== args.presentationId) {
      return;
    }
    captureMessage('Failed to process chat request', { level: 'error' });
    recordChatFailure(turnError.trim().length === 0);
    toolActivityStore.abortActive();
    toolProgressStore.clear();
    if (turnError.includes(WORKERS_PAID_REQUIRED_MARKER)) {
      showWorkersPaidRequiredToast();
    }
  }, [turnError, args.presentationId]);
  const status: 'submitted' | 'streaming' | 'ready' | 'error' = sending
    ? 'submitted'
    : busy
      ? messages.at(-1)?.role === 'assistant'
        ? 'streaming'
        : 'submitted'
      : error
        ? 'error'
        : 'ready';

  // The gate holder is a per-presentation mutable cell made during render (above), not a value React tracks:
  // a send started before this effect runs must wait on the new presentation's gate, so it is written here.
  /* oxlint-disable react/immutability */
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
  /* eslint-enable react/immutability */

  const retryWorkspacePresentation = useCallback(() => setWorkspaceAttemptId((id) => id + 1), []);
  // Read during render on purpose: a presentation from a gate this render no longer holds is stale (see above).
  // oxlint-disable-next-line react/refs
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

  /**
   * Sends the person's message: the agent records the turn and hands it to pi-durable, then streams the run back as
   * chat frames. Resolves once the agent has started the turn; a refusal (no access, a model the account doesn't
   * allow) rejects with the agent's own words.
   */
  const sendMessage = useCallback(
    async (
      message: { text: string },
      options?: { body?: { turnContext?: ChatTurnContext; modelId?: BuilderModelId } },
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
      setSendError(null);
      setSending(true);
      try {
        const request = conversationAgent.call(
          'sendMessage',
          [
            {
              text: message.text,
              turnContext: options?.body?.turnContext,
              // The model, and the effort the person chose for it; none at all means the provider's default.
              ...builderModelRequestFields(options?.body?.modelId ?? builderModelStore.get()),
              transcript,
              requestId: crypto.randomUUID(),
            },
          ],
          { timeout: AGENT_SEND_TIMEOUT_MS },
        );
        onRequestStart?.();
        await request;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        setSendError(failure);
        captureMessage('Failed to process chat request', { level: 'error' });
        logger.error('Chat request failed', failure);
        // A failure that arrived with nothing to say gives the user nothing to act on, so it is the one that gets
        // backed off; a refusal that named its reason is reported and retried at will.
        recordChatFailure(failure.message.trim().length === 0);
        if (failure.message.includes(WORKERS_PAID_REQUIRED_MARKER)) {
          showWorkersPaidRequiredToast();
        }
        throw failure;
      } finally {
        setSending(false);
      }
    },
    [assertCurrentPresentation, conversationAgent, transcript, workspaceGateRef],
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

  // The others on the project see when this person's agent is working: only that it is, nothing of what it does.
  useEffect(() => {
    agentWorkingStore.set(busy);
  }, [busy]);
  useEffect(() => () => agentWorkingStore.set(false), [conversationAgent]);

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
      // The command that asked for the change is still waiting for this decision, and carries on with its result.
      return conversationAgent.call(method, [{ executionId }], { timeout: 2 * 60_000 });
    },
    [conversationAgent],
  );

  // A change filed for the team's admins: once one of them decides it while this chat is open, the agent carries on
  // from the result. Only a decision seen arriving here does that, once.
  const filedApprovalsRef = useRef(new Set<string>());
  useEffect(() => {
    const decided = decidedTeamApprovals(messages, filedApprovalsRef.current);
    if (decided.length === 0 || status !== 'ready') {
      return;
    }
    for (const approvalId of decided) {
      filedApprovalsRef.current.delete(approvalId);
    }
    sendMessage({
      text: 'A team admin decided the Cloudflare change I asked for; its result is in that command. Continue from it.',
    }).catch((error: Error) => logger.warn('Unable to continue after a team admin decided', error));
  }, [messages, status, sendMessage]);

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
    toolActivityStore.abortActive();
    toolProgressStore.clear();
    // The agent aborts the run; what it did stays in the chat, which the agent's frames bring up to date.
    const cancellation = conversationAgent
      .call('cancelActiveTurn', [], { timeout: AGENT_CANCEL_SETTLE_TIMEOUT_MS })
      .then(() => workspaceControllerRef.current?.pull())
      .then(() => undefined)
      .catch((error) => {
        logger.error('Failed to stop the active builder turn', error);
        captureMessage('Failed to process chat request', { level: 'error' });
      });
    stopBarrierRef.current = cancellation;
  }, [conversationAgent]);

  useEffect(() => {
    if (previousSubchatIndexRef.current === currentSubchatIndex) {
      return;
    }
    previousSubchatIndexRef.current = currentSubchatIndex;
    toolActivityStore.abortActive();
    toolProgressStore.clear();
    messagesRef.current = initialMessagesRef.current;
    setMessages(initialMessagesRef.current);
  }, [currentSubchatIndex]);

  return {
    messages,
    error,
    status,
    isRecovering: false,
    upgradeWaiting,
    stop,
    sendMessage,
    steerMessage,
    streamStatus: status,
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

/** A command's changes filed for the team's admins: each one waiting, or what they decided. */
const commandChangesSchema = z.object({ output: z.object({ cloudflareChanges: z.array(z.unknown()) }) });
const filedChangeSchema = z.object({ kind: z.literal('cloudflare_request_filed'), approvalId: z.string() });
const decidedChangeSchema = z.object({ kind: z.literal('cloudflare_request_final_result'), executionId: z.string() });

/**
 * Notes each change `messages` show waiting for a team's admins in `filed`, and answers those noted earlier that
 * now show a result.
 */
function decidedTeamApprovals(messages: readonly CloudChefMessage[], filed: Set<string>): string[] {
  const decided: string[] = [];
  for (const part of messages.flatMap((message) => message.parts)) {
    for (const change of commandChangesSchema.safeParse(part).data?.output.cloudflareChanges ?? []) {
      const waiting = filedChangeSchema.safeParse(change);
      if (waiting.success) {
        filed.add(waiting.data.approvalId);
        continue;
      }
      const result = decidedChangeSchema.safeParse(change);
      if (result.success && filed.has(result.data.executionId)) {
        decided.push(result.data.executionId);
      }
    }
  }
  return decided;
}
