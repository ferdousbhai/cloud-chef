// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';

/** What the hook passes `useAgent`: the socket's message handler is how chat frames arrive. */
type AgentOptions = { onMessage?: (event: MessageEvent) => void };

const mocks = vi.hoisted(() => {
  const controller = { dispose: vi.fn(), pull: vi.fn(async () => undefined) };
  const workbench = {
    connectSite: vi.fn(() => vi.fn()),
  };
  return {
    agent: { state: {} as { turnError?: string | null }, call: vi.fn() },
    agentOptions: [] as AgentOptions[],
    executeDataOperation: vi.fn(),
    finishToolTurn: vi.fn(),
    resumeToolTurn: vi.fn(),
    recordChatFailure: vi.fn(),
    recordToolProgress: vi.fn(),
    resetChatRetryState: vi.fn(),
    abortToolActivity: vi.fn(),
    clearToolProgress: vi.fn(),
    showWorkersPaidRequiredToast: vi.fn(),
    controller,
    initializeWorkspace: vi.fn(async () => controller),
    waitForSocket: vi.fn(async () => undefined),
    workbench,
    workspacePreparing: { value: false },
    refreshRuntimeSession: vi.fn(async () => ({})),
    resetRuntimeSession: vi.fn(),
    /** The refusal the double of `runtimeSessionNeedsAction` says waits on the person. */
    refusalNeedingAction: new Error('CloudChef needs updated Cloudflare permissions for this workspace.'),
  };
});

vi.mock('agents/react', () => ({
  useAgent: (options: AgentOptions) => {
    mocks.agentOptions.push(options);
    return mocks.agent;
  },
}));
vi.mock('@nanostores/react', () => ({ useStore: (store: { get: () => unknown }) => store.get() }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('~/lib/cloudflare/runtime-session', () => ({
  requireUserRuntimeEndpoint: () => 'https://runtime.example.com',
  refreshUserRuntimeSession: mocks.refreshRuntimeSession,
  resetUserRuntimeSession: mocks.resetRuntimeSession,
  runtimeSessionNeedsAction: (error: Error) => error === mocks.refusalNeedingAction,
}));
vi.mock('~/lib/stores/builder-workspace-sync.client', () => ({
  BuilderWorkspaceSyncController: { initialize: mocks.initializeWorkspace },
}));
vi.mock('~/lib/stores/workbench.client', () => ({ workbenchStore: mocks.workbench }));
vi.mock('./agent-connection', () => ({ waitForAgentSocketOpen: mocks.waitForSocket }));
vi.mock('./conversation-agent-auth', () => ({
  CONVERSATION_AGENT_QUERY_CACHE_TTL_MS: 1_000,
  loadConversationAgentCapability: vi.fn(),
}));
vi.mock('~/lib/telemetry.client', () => ({ captureMessage: vi.fn() }));
vi.mock('~/lib/cloudflare/workspace-history-db', () => ({ refreshChatHistory: vi.fn() }));
vi.mock('~/lib/cloudflare/client', () => ({ executeDataOperation: mocks.executeDataOperation }));
vi.mock('~/lib/cloudflare/data-api', () => ({ api: { messages: { get: {} } } }));
vi.mock('~/lib/cloudflare/data-hooks', () => ({ subchatQueryKey: vi.fn(() => []) }));
vi.mock('~/lib/workers-paid.client', () => ({
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

// Pins a browser timeout to the runtime's derived container connect ceiling; the runtime is
// outside the ~/ alias, and the dependency direction (runtime imports app) forbids exporting
// the ceiling through app code.
// oxlint-disable-next-line no-restricted-imports -- test-only cross-boundary derivation pin
import { CONTAINER_CONNECT_TIMEOUT_MS } from '../../../user-workspace-runtime/src/container-toolchain';
import {
  useConversationAgentChat,
  WORKSPACE_PREPARE_TIMEOUT_MS,
  WORKSPACE_RECONNECT_ATTEMPTS,
  WORKSPACE_RECONNECT_DELAYS_MS,
} from './useConversationAgentChat';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.agent.call.mockReset();
  mocks.agent.state = {};
  mocks.initializeWorkspace.mockClear();
  mocks.controller.dispose.mockClear();
  mocks.controller.pull.mockClear();
  mocks.resumeToolTurn.mockClear();
  mocks.agentOptions.length = 0;
  mocks.executeDataOperation.mockReset();
  mocks.finishToolTurn.mockClear();
  mocks.recordChatFailure.mockClear();
  mocks.recordToolProgress.mockClear();
  mocks.resetChatRetryState.mockClear();
  mocks.abortToolActivity.mockClear();
  mocks.clearToolProgress.mockClear();
  mocks.showWorkersPaidRequiredToast.mockClear();
  mocks.waitForSocket.mockReset();
  mocks.waitForSocket.mockResolvedValue(undefined);
  mocks.workbench.connectSite.mockClear();
  mocks.refreshRuntimeSession.mockReset();
  mocks.refreshRuntimeSession.mockResolvedValue({});
  mocks.resetRuntimeSession.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('useConversationAgentChat workspace preparation', () => {
  it('shows the chat the agent sends, and follows a run from its frames to its end', async () => {
    mocks.agent.call.mockResolvedValue({ initialized: true });
    const user: CloudChefMessage = { id: '1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] };
    const working: CloudChefMessage = {
      id: '1-a',
      role: 'assistant',
      parts: [{ type: 'dynamic-tool', toolName: 'exec', toolCallId: 'call-1', state: 'input-available' }],
    };
    let current: ReturnType<typeof useConversationAgentChat> | undefined;
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function Harness() {
      current = useConversationAgentChat(chatArgs('restored-workspace'));
      return null;
    }
    await act(async () => root?.render(<Harness />));

    await act(async () =>
      receive({ from: 0, keepParts: 0, messages: [user, working], busy: true, progress: [progress('call-1')] }),
    );
    expect(current?.messages).toEqual([user, working]);
    expect(current?.streamStatus).toBe('streaming');
    expect(mocks.resumeToolTurn).toHaveBeenCalledWith(working);
    expect(mocks.recordToolProgress).toHaveBeenCalledWith(progress('call-1'));

    const done = { type: 'text', text: 'Done.', state: 'done' };
    await act(async () =>
      receive({ from: 1, keepParts: 1, messages: [{ ...working, parts: [done] }], busy: false, progress: [] }),
    );
    expect(current?.messages[1]?.parts).toEqual([working.parts[0], done]);
    expect(current?.streamStatus).toBe('ready');
    expect(mocks.finishToolTurn).toHaveBeenCalledWith({ ...working, parts: [working.parts[0], done] });
    expect(mocks.resetChatRetryState).toHaveBeenCalled();
  });

  it('gives prepareWorkspace at least the container connect ceiling instead of the SDK default', async () => {
    // The agents SDK applies a 30-second default RPC timeout. Preparing the workspace can wait
    // on the full toolchain bootstrap after a container restart, so the explicit budget must
    // cover the connect ceiling the runtime derives, or a recovering workspace becomes an
    // unresumable chat (observed in production during the first end-to-end build).
    expect(WORKSPACE_PREPARE_TIMEOUT_MS).toBeGreaterThanOrEqual(CONTAINER_CONNECT_TIMEOUT_MS);
    mocks.agent.call.mockImplementation(async (method: string) => {
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
      useConversationAgentChat(chatArgs('workspace-timeout'));
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
        return <span>{useConversationAgentChat(chatArgs('workspace-release')).workspacePresentationState}</span>;
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
        return <span>{useConversationAgentChat(chatArgs('workspace-down')).workspacePresentationState}</span>;
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

  it("shows why a project's files could not be put in the workspace, and retries only when asked", async () => {
    vi.useFakeTimers();
    try {
      const failure = 'Connect GitHub again in Settings to import this project.';
      // The agent's first answer, then the one the person's retry gets.
      const answers = [{ initialized: false, failure }, { initialized: true }];
      mocks.agent.call.mockImplementation(async (method: string) => {
        if (method === 'prepareWorkspace') {
          return answers.shift();
        }
        throw new Error(`Unexpected agent call: ${method}`);
      });

      let currentChat: ReturnType<typeof useConversationAgentChat> | undefined;
      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      function Harness() {
        currentChat = useConversationAgentChat(chatArgs('workspace-import-refused'));
        return (
          <span>
            {currentChat.workspacePresentationState}: {currentChat.workspaceFailure}
          </span>
        );
      }
      await act(async () => root?.render(<Harness />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_RECONNECT_ATTEMPTS * 30_000);
      });

      // Said at once and not retried: reconnecting would only get the same answer.
      expect(container.textContent).toBe(`failed: ${failure}`);
      expect(prepareWorkspaceCalls()).toHaveLength(1);
      expect(mocks.refreshRuntimeSession).not.toHaveBeenCalled();
      expect(mocks.initializeWorkspace).not.toHaveBeenCalled();
      await expect(currentChat!.sendMessage({ text: 'build it' })).rejects.toThrow(failure);

      await act(async () => currentChat!.retryWorkspacePresentation());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(prepareWorkspaceCalls()).toHaveLength(2);
      expect(container.textContent).toBe('ready: ');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands a session refusal only the person can act on back to the chat instead of reconnecting', async () => {
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'prepareWorkspace') {
        throw new Error('Connection closed');
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });
    mocks.refreshRuntimeSession.mockRejectedValue(mocks.refusalNeedingAction);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function Harness() {
      return <span>{useConversationAgentChat(chatArgs('workspace-reauthorize')).workspacePresentationState}</span>;
    }
    await act(async () => root?.render(<Harness />));

    await vi.waitFor(() => expect(mocks.resetRuntimeSession).toHaveBeenCalledOnce());
  });

  it('keeps reconnecting through a session refusal that may pass', async () => {
    vi.useFakeTimers();
    try {
      mocks.agent.call.mockImplementation(async (method: string) => {
        if (method === 'prepareWorkspace') {
          throw new Error('Connection closed');
        }
        throw new Error(`Unexpected agent call: ${method}`);
      });
      mocks.refreshRuntimeSession.mockRejectedValue(new Error('CloudChef could not reach your workspace.'));

      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      function Harness() {
        return <span>{useConversationAgentChat(chatArgs('workspace-flaky')).workspacePresentationState}</span>;
      }
      await act(async () => root?.render(<Harness />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WORKSPACE_RECONNECT_DELAYS_MS[0]);
      });

      expect(prepareWorkspaceCalls()).toHaveLength(2);
      expect(mocks.resetRuntimeSession).not.toHaveBeenCalled();
      expect(container.textContent).toBe('reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles stale send admission without activating the old workspace when the presentation switches', async () => {
    const oldPreparation = deferred<{ initialized: boolean }>();
    const newPreparation = deferred<{ initialized: boolean }>();
    const preparations = [oldPreparation.promise, newPreparation.promise];
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'prepareWorkspace') {
        const preparation = preparations.shift();
        if (!preparation) {
          throw new Error('Unexpected workspace preparation');
        }
        return preparation;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useConversationAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useConversationAgentChat(chatArgs(presentationId));
      return <span>{currentChat.workspacePresentationState}</span>;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    const staleSend = currentChat!.sendMessage({ text: 'build it' }).then(
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

describe('useConversationAgentChat stale presentation operations', () => {
  it('ignores chat frames once its presentation was superseded', async () => {
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    function Harness({ presentationId }: { presentationId: string }) {
      useConversationAgentChat(chatArgs(presentationId));
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness presentationId="workspace-old" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));
    const staleOptions = mocks.agentOptions.at(-1)!;

    await act(async () => root?.render(<Harness presentationId="workspace-new" />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(2));
    mocks.controller.pull.mockClear();
    mocks.agentOptions.length = 0;

    await act(async () =>
      receive({ from: 0, keepParts: 0, messages: [], busy: true, progress: [progress('tool-1')] }, staleOptions),
    );

    expect(mocks.recordToolProgress).not.toHaveBeenCalled();
    expect(mocks.resumeToolTurn).not.toHaveBeenCalled();
    expect(mocks.finishToolTurn).not.toHaveBeenCalled();
    expect(mocks.controller.pull).not.toHaveBeenCalled();
  });

  it('sends a message as one call to the agent, with the turn context, the model and the transcript', async () => {
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'sendMessage') {
        return { accepted: true };
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });
    let currentChat: ReturnType<typeof useConversationAgentChat> | undefined;
    function Harness() {
      currentChat = useConversationAgentChat(chatArgs('workspace-1'));
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));
    const started = vi.fn();

    await act(async () =>
      currentChat!.sendMessage(
        { text: 'build it' },
        { body: { turnContext: { version: 1, content: 'src/app.ts' } } },
        started,
      ),
    );

    const [, [input]] = mocks.agent.call.mock.calls.find(([method]) => method === 'sendMessage')!;
    expect(input).toMatchObject({
      text: 'build it',
      turnContext: { version: 1, content: 'src/app.ts' },
      transcript: { agentName: 'agent-1', subchatIndex: 0 },
      modelId: expect.any(String),
    });
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("shows a refused message's reason as the chat's error", async () => {
    mocks.agent.call.mockImplementation(async (method: string) => {
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      throw new Error("This model isn't allowed in this account.");
    });
    let currentChat: ReturnType<typeof useConversationAgentChat> | undefined;
    function Harness() {
      currentChat = useConversationAgentChat(chatArgs('workspace-1'));
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));
    await vi.waitFor(() => expect(prepareWorkspaceCalls()).toHaveLength(1));

    await act(async () => settle(currentChat!.sendMessage({ text: 'build it' })));

    expect(currentChat?.error?.message).toBe("This model isn't allowed in this account.");
    expect(currentChat?.streamStatus).toBe('error');
    expect(mocks.recordChatFailure).toHaveBeenCalledWith(false);
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
      if (method === 'prepareWorkspace') {
        return { initialized: true };
      }
      if (method === 'steerActiveTurn') {
        return undefined;
      }
      throw new Error(`Unexpected agent call: ${method}`);
    });

    let currentChat: ReturnType<typeof useConversationAgentChat> | undefined;
    function Harness({ presentationId }: { presentationId: string }) {
      currentChat = useConversationAgentChat(chatArgs(presentationId));
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
});

function chatArgs(presentationId: string) {
  return {
    accountId: 'account-1',
    chatInitialId: 'chat-1',
    initialMessages: [],
    onSubchatTitle: vi.fn(),
    presentationId,
    transcript: { agentName: 'agent-1', subchatIndex: 0 },
  };
}

function prepareWorkspaceCalls() {
  return mocks.agent.call.mock.calls.filter(([method]) => method === 'prepareWorkspace');
}

/** A chat frame from the agent, as its socket delivers it. */
function receive(
  frame: { from: number; keepParts: number; messages: CloudChefMessage[]; busy: boolean; progress: unknown[] },
  options: AgentOptions | undefined = mocks.agentOptions.at(-1),
) {
  options?.onMessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'cloudchef_chat', ...frame }) }));
}

function progress(toolCallId: string) {
  return { toolCallId, toolName: 'exec', result: { stdout: 'working' } };
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
