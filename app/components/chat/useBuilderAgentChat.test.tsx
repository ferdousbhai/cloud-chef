// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';

type ChatCallbacks = {
  onData: (part: { type: string; data?: unknown }) => void;
  onError: (error: Error) => void;
  onFinish: (result: { finishReason: string; message: CloudChefMessage }) => void;
};

const mocks = vi.hoisted(() => {
  const controller = { dispose: vi.fn(), pull: vi.fn() };
  const chat = {
    messages: [] as CloudChefMessage[],
    status: 'ready' as const,
    isRecovering: false,
    isStreaming: false,
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    stop: vi.fn(),
  };
  const previewRequests: Array<() => Promise<unknown>> = [];
  const workbench = {
    connectPreview: vi.fn((actions: { request: () => Promise<unknown> }) => {
      previewRequests.push(actions.request);
      return vi.fn();
    }),
    updatePreview: vi.fn(),
  };
  return {
    agent: { state: {} as { transcript?: unknown }, call: vi.fn() },
    chat,
    chatCallbacks: [] as ChatCallbacks[],
    executeDataOperation: vi.fn(),
    finishToolTurn: vi.fn(),
    resumeToolTurn: vi.fn(),
    loadSnapshot: vi.fn(async (args: { read: () => Promise<unknown> }) => args.read()),
    recordChatFailure: vi.fn(),
    recordToolProgress: vi.fn(),
    reconcileMessages: vi.fn(async (args: { localMessages: CloudChefMessage[] }) => args.localMessages),
    resetChatRetryState: vi.fn(),
    abortToolActivity: vi.fn(),
    clearToolProgress: vi.fn(),
    showCloudflareAiFundingRequiredToast: vi.fn(),
    showWorkersPaidRequiredToast: vi.fn(),
    controller,
    initializeWorkspace: vi.fn(async () => controller),
    previewRequests,
    waitForSocket: vi.fn(async () => undefined),
    workbench,
    workspacePreparing: { value: false },
    refreshRuntimeSession: vi.fn(async () => ({})),
  };
});

vi.mock('@cloudflare/ai-chat/react', () => ({
  useAgentChat: (callbacks: ChatCallbacks) => {
    mocks.chatCallbacks.push(callbacks);
    return mocks.chat;
  },
}));
vi.mock('agents/react', () => ({ useAgent: () => mocks.agent }));
vi.mock('@nanostores/react', () => ({ useStore: (store: { get: () => unknown }) => store.get() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('~/lib/cloudflare/runtime-session', () => ({
  requireUserRuntimeEndpoint: () => 'https://runtime.example.com',
  refreshUserRuntimeSession: mocks.refreshRuntimeSession,
}));
vi.mock('~/lib/stores/builder-workspace-sync.client', () => ({
  BuilderWorkspaceSyncController: { initialize: mocks.initializeWorkspace },
}));
vi.mock('~/lib/stores/workbench.client', () => ({ workbenchStore: mocks.workbench }));
vi.mock('./agent-connection', () => ({ waitForAgentSocketOpen: mocks.waitForSocket }));
vi.mock('./builder-agent-auth', () => ({
  BUILDER_AGENT_QUERY_CACHE_TTL_MS: 1_000,
  loadBuilderAgentCapability: vi.fn(),
}));
vi.mock('~/lib/telemetry.client', () => ({ captureMessage: vi.fn() }));
vi.mock('~/lib/cloudflare/chat-history-db', () => ({ refreshChatHistory: vi.fn() }));
vi.mock('~/lib/cloudflare/client', () => ({ executeDataOperation: mocks.executeDataOperation }));
vi.mock('~/lib/cloudflare/data-api', () => ({ api: { messages: { get: {} } } }));
vi.mock('~/lib/cloudflare/data-hooks', () => ({ subchatQueryKey: vi.fn(() => []) }));
vi.mock('~/lib/workers-paid.client', () => ({
  showCloudflareAiFundingRequiredToast: mocks.showCloudflareAiFundingRequiredToast,
  showWorkersPaidRequiredToast: mocks.showWorkersPaidRequiredToast,
}));
vi.mock('~/lib/stores/tool-activity.client', () => ({
  toolActivityStore: {
    abortActive: mocks.abortToolActivity,
    finishTurn: mocks.finishToolTurn,
    resumeTurn: mocks.resumeToolTurn,
  },
}));
vi.mock('~/lib/stores/tool-progress.client', () => ({
  toolProgressStore: {
    clear: mocks.clearToolProgress,
    record: mocks.recordToolProgress,
  },
}));
vi.mock('./chat-retry', () => ({
  recordChatFailure: mocks.recordChatFailure,
  resetChatRetryState: mocks.resetChatRetryState,
}));
vi.mock('./chat-send-reconciliation', () => ({
  loadAuthoritativeTranscriptSnapshot: mocks.loadSnapshot,
  reconcileMessagesForSend: mocks.reconcileMessages,
}));

// Pins a browser timeout to the runtime's derived container connect ceiling; the runtime is
// outside the ~/ alias, and the dependency direction (runtime imports app) forbids exporting
// the ceiling through app code.
// eslint-disable-next-line no-restricted-imports -- test-only cross-boundary derivation pin
import { CONTAINER_CONNECT_TIMEOUT_MS } from '../../../user-workspace-runtime/src/container-toolchain';
import {
  useBuilderAgentChat,
  WORKSPACE_PREPARE_TIMEOUT_MS,
  WORKSPACE_RECONNECT_ATTEMPTS,
  WORKSPACE_RECONNECT_DELAYS_MS,
} from './useBuilderAgentChat';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.agent.call.mockReset();
  mocks.agent.state = {};
  mocks.initializeWorkspace.mockClear();
  mocks.controller.dispose.mockClear();
  mocks.controller.pull.mockClear();
  mocks.chat.messages = [];
  mocks.chat.isStreaming = false;
  mocks.chat.isRecovering = false;
  mocks.resumeToolTurn.mockClear();
  mocks.chat.sendMessage.mockClear();
  mocks.chat.setMessages.mockClear();
  mocks.chatCallbacks.length = 0;
  mocks.executeDataOperation.mockReset();
  mocks.finishToolTurn.mockClear();
  mocks.loadSnapshot.mockReset();
  mocks.loadSnapshot.mockImplementation(async (args: { read: () => Promise<unknown> }) => args.read());
  mocks.recordChatFailure.mockClear();
  mocks.recordToolProgress.mockClear();
  mocks.reconcileMessages.mockReset();
  mocks.reconcileMessages.mockImplementation(async (args: { localMessages: CloudChefMessage[] }) => args.localMessages);
  mocks.resetChatRetryState.mockClear();
  mocks.abortToolActivity.mockClear();
  mocks.clearToolProgress.mockClear();
  mocks.showCloudflareAiFundingRequiredToast.mockClear();
  mocks.showWorkersPaidRequiredToast.mockClear();
  mocks.previewRequests.length = 0;
  mocks.waitForSocket.mockReset();
  mocks.waitForSocket.mockResolvedValue(undefined);
  mocks.workbench.connectPreview.mockClear();
  mocks.workbench.updatePreview.mockClear();
  mocks.refreshRuntimeSession.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('useBuilderAgentChat workspace preparation', () => {
  it('reattaches tool activity when the SDK restores an active response', async () => {
    mocks.agent.call.mockResolvedValue({ initialized: true });
    const message: CloudChefMessage = { id: 'restored', role: 'assistant', parts: [] };
    mocks.chat.messages = [message];
    mocks.chat.isStreaming = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function Harness() {
      useBuilderAgentChat(chatArgs('restored-workspace'));
      return null;
    }
    await act(async () => root?.render(<Harness />));
    expect(mocks.resumeToolTurn).toHaveBeenCalledWith(message);
  });

  it('gives prepareWorkspace at least the container connect ceiling instead of the SDK default', async () => {
    // The agents SDK applies a 30-second default RPC timeout. Preparing the workspace can wait
    // on the full toolchain bootstrap after a container restart, so the explicit budget must
    // cover the connect ceiling the runtime derives, or a recovering workspace becomes an
    // unresumable chat (observed in production during the first end-to-end build).
    expect(WORKSPACE_PREPARE_TIMEOUT_MS).toBeGreaterThanOrEqual(CONTAINER_CONNECT_TIMEOUT_MS);
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'getTranscriptSnapshot') {
        return { checkpoint: null, messages: [] };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function Harness() {
      useBuilderAgentChat(chatArgs('workspace-timeout'));
      return null;
    }
    await act(async () => root?.render(<Harness />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));
    const [, , options] = prepareWorkspaceCalls()[0] as [string, unknown[], { timeout?: number }];
    expect(options?.timeout).toBe(WORKSPACE_PREPARE_TIMEOUT_MS);
  });

  it('recovers an open chat when a release makes the runtime refuse, then answer', async () => {
    // What a control-plane release looks like from an already-open chat: the runtime session
    // request answers `409 workspace_preparing` while the new image builds, so the socket and
    // `prepareWorkspace` both fail — and then, ~40 seconds later, they simply work again.
    vi.useFakeTimers();
    try {
      let preparation = 0;
      mocks.agent.call.mockImplementation(async (method: string) => {
        if (method === 'getPreviewState') {
          return {};
        }
        if (method === 'prepareWorkspace') {
          preparation += 1;
          if (preparation === 1) {
            throw new Error('workspace_preparing');
          }
          return { initialized: true };
        }
        if (method === 'getTranscriptSnapshot') {
          return { checkpoint: null, messages: [] };
        }
        throw new Error(`Unexpected agent call: ${method}`);
      });

      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      function Harness() {
        return <span>{useBuilderAgentChat(chatArgs('workspace-release')).workspacePresentationState}</span>;
      }
      await act(async () => root?.render(<Harness />));

      // The refused attempt reports itself instead of holding "Loading project files…" forever.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.textContent).toBe('reconnecting');
      expect(mocks.refreshRuntimeSession).toHaveBeenCalledTimes(1);
      expect(mocks.initializeWorkspace).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_RECONNECT_DELAYS_MS[0]);
      });

      expect(prepareWorkspaceCalls()).toHaveLength(2);
      expect(mocks.initializeWorkspace).toHaveBeenCalledWith(
        mocks.agent,
        expect.objectContaining({ workspaceId: 'workspace-release' }),
      );
      expect(container.textContent).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on a bounded budget instead of retrying a workspace forever', async () => {
    vi.useFakeTimers();
    try {
      mocks.agent.call.mockImplementation(async (method: string) => {
        if (method === 'getPreviewState') {
          return {};
        }
        if (method === 'prepareWorkspace') {
          throw new Error('workspace_preparing');
        }
        if (method === 'getTranscriptSnapshot') {
          return { checkpoint: null, messages: [] };
        }
        throw new Error(`Unexpected agent call: ${method}`);
      });

      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      function Harness() {
        return <span>{useBuilderAgentChat(chatArgs('workspace-down')).workspacePresentationState}</span>;
      }
      await act(async () => root?.render(<Harness />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_RECONNECT_ATTEMPTS * 30_000);
      });

      expect(prepareWorkspaceCalls()).toHaveLength(WORKSPACE_RECONNECT_ATTEMPTS);
      expect(container.textContent).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles stale send admission without activating the old workspace when the presentation switches', async () => {
    const oldPreparation = deferred<{ initialized: boolean }>();
    const newPreparation = deferred<{ initialized: boolean }>();
    const preparations = [oldPreparation.promise, newPreparation.promise];
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        const preparation = preparations.shift();
        if (!preparation) {
          throw new Error('Unexpected workspace preparation');
        }
        return preparation;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useBuilderAgentChat(chatArgs(presentationId));
      return <span>{currentChat.workspacePresentationState}</span>;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    const staleSend = currentChat!.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'build it' }] }).then(
      () => null,
      (error: unknown) => error,
    );

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(2));
    await expect(staleSend).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace initialization was superseded.' }),
    );

    await act(async () => oldPreparation.resolve({ initialized: true }));
    expect(mocks.initializeWorkspace).not.toHaveBeenCalled();

    await act(async () => newPreparation.resolve({ initialized: true }));
    await vi.waitFor(() =>
      expect(mocks.initializeWorkspace).toHaveBeenCalledWith(
        mocks.agent,
        expect.objectContaining({ workspaceId: 'workspace-new' }),
      ),
    );
    expect(mocks.initializeWorkspace).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('ready');
  });
});

describe('useBuilderAgentChat stale presentation operations', () => {
  it('ignores stream callbacks retained by a superseded presentation', async () => {
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    function Harness({ presentationId }: { presentationId: string }) {
      useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));
    const staleCallbacks = mocks.chatCallbacks.at(-1)!;

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(2));
    mocks.controller.pull.mockClear();

    staleCallbacks.onData({
      type: 'data-tool-progress',
      data: { toolCallId: 'tool-1', toolName: 'write', result: 'done' },
    });
    staleCallbacks.onError(new Error('stale failure'));
    staleCallbacks.onFinish({
      finishReason: 'stop',
      message: { id: 'assistant-1', role: 'assistant', parts: [] },
    });
    await Promise.resolve();

    expect(mocks.recordToolProgress).not.toHaveBeenCalled();
    expect(mocks.clearToolProgress).not.toHaveBeenCalled();
    expect(mocks.abortToolActivity).not.toHaveBeenCalled();
    expect(mocks.finishToolTurn).not.toHaveBeenCalled();
    expect(mocks.recordChatFailure).not.toHaveBeenCalled();
    expect(mocks.resetChatRetryState).not.toHaveBeenCalled();
    expect(mocks.showCloudflareAiFundingRequiredToast).not.toHaveBeenCalled();
    expect(mocks.showWorkersPaidRequiredToast).not.toHaveBeenCalled();
    expect(mocks.executeDataOperation).not.toHaveBeenCalled();
    expect(mocks.controller.pull).not.toHaveBeenCalled();
  });

  it('does not apply terminal transcript reconciliation after the presentation switches', async () => {
    const checkpoint = {
      agentName: 'agent-1',
      generation: 1,
      subchatIndex: 0,
      digest: 'a'.repeat(64),
      messageCount: 1,
      revision: 1,
    };
    const localMessages: CloudChefMessage[] = [
      { id: 'local-1', role: 'user', parts: [{ type: 'text', text: 'local' }] },
    ];
    const durableMessages: CloudChefMessage[] = [
      { id: 'durable-1', role: 'user', parts: [{ type: 'text', text: 'durable' }] },
    ];
    const reconciliation = deferred<CloudChefMessage[]>();
    mocks.chat.messages = localMessages;
    mocks.agent.state = { transcript: checkpoint };
    mocks.reconcileMessages.mockImplementationOnce(async () => reconciliation.promise);
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'getTranscriptSnapshot') {
        return { checkpoint, messages: durableMessages };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    function Harness({ presentationId }: { presentationId: string }) {
      useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(mocks.reconcileMessages).toHaveBeenCalledTimes(1));

    mocks.agent.state = {};
    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await act(async () => reconciliation.resolve(durableMessages));

    expect(mocks.chat.setMessages).not.toHaveBeenCalled();
  });

  it('does not send after the presentation switches during transcript reconciliation', async () => {
    const oldSnapshot = deferred<{ checkpoint: null; messages: CloudChefMessage[] }>();
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'getTranscriptSnapshot') {
        return oldSnapshot.promise;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    const staleSend = settle(currentChat!.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'build it' }] }));
    await vi.waitFor(() => expect(transcriptSnapshotCalls()).toHaveLength(1));

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await act(async () => oldSnapshot.resolve({ checkpoint: null, messages: [] }));

    await expect(staleSend).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace initialization was superseded.' }),
    );
    expect(mocks.chat.sendMessage).not.toHaveBeenCalled();
  });

  it('does not steer after the presentation switches while the socket becomes ready', async () => {
    const oldSendSocket = deferred<void>();
    let socketCall = 0;
    mocks.waitForSocket.mockImplementation(async () => {
      socketCall += 1;
      if (socketCall === 2) {
        await oldSendSocket.promise;
      }
    });
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        return {};
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'steerActiveTurn') {
        return undefined;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useBuilderAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    const staleSteer = settle(currentChat!.steerMessage({ text: 'change course' }));
    await vi.waitFor(() => expect(mocks.waitForSocket).toHaveBeenCalledTimes(2));

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await act(async () => oldSendSocket.resolve());

    await expect(staleSteer).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace initialization was superseded.' }),
    );
    expect(mocks.agent.call.mock.calls.filter(([method]) => method === 'steerActiveTurn')).toHaveLength(0);
  });

  it('ignores preview get and request responses from a superseded presentation', async () => {
    const oldGet = deferred<{ presentation: string }>();
    const oldRequest = deferred<{ presentation: string }>();
    let getCall = 0;
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'getPreviewState') {
        getCall += 1;
        return getCall === 1 ? oldGet.promise : { presentation: 'new' };
      }
      if (method === 'requestPreview') {
        return oldRequest.promise;
      }
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    function Harness({ presentationId }: { presentationId: string }) {
      useBuilderAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(mocks.previewRequests).toHaveLength(1));
    const staleRequest = mocks.previewRequests[0]();

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await vi.waitFor(() => expect(mocks.previewRequests).toHaveLength(2));
    await act(async () => {
      oldGet.resolve({ presentation: 'old-get' });
      oldRequest.resolve({ presentation: 'old-request' });
      await Promise.all([oldGet.promise, staleRequest]);
    });

    expect(mocks.workbench.updatePreview).toHaveBeenCalledWith({ presentation: 'new' });
    expect(mocks.workbench.updatePreview).not.toHaveBeenCalledWith({ presentation: 'old-get' });
    expect(mocks.workbench.updatePreview).not.toHaveBeenCalledWith({ presentation: 'old-request' });
  });
});

function chatArgs(presentationId: string) {
  return {
    accountId: 'account-1',
    chatInitialId: 'chat-1',
    initialMessages: [],
    onSubchatTitle: vi.fn(),
    presentationId,
    transcript: { agentName: 'agent-1', generation: 1, subchatIndex: 0 },
  };
}

function prepareWorkspaceCalls() {
  return mocks.agent.call.mock.calls.filter(([method]) => method === 'prepareWorkspace');
}

function transcriptSnapshotCalls() {
  return mocks.agent.call.mock.calls.filter(([method]) => method === 'getTranscriptSnapshot');
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
