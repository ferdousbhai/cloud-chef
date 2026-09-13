// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idleBuilderPreviewState, type BuilderPreviewState } from '~/agents/builder-preview-types';

vi.mock('~/lib/stores/workbench.client', async () => {
  const { atom, map } = await import('nanostores');
  const { idleBuilderPreviewState: idleState } = await import('~/agents/builder-preview-types');
  let workspaceId: string | null = null;
  let previewRequest: (() => Promise<BuilderPreviewState>) | null = null;
  const previewState = atom(idleState());

  return {
    workbenchStore: {
      previewState,
      showWorkbench: atom(false),
      selectedFile: atom<string | undefined>(undefined),
      currentDocument: atom(undefined),
      unsavedFiles: atom(new Set()),
      files: map({}),
      currentView: atom<'code' | 'preview'>('code'),
      followingStreamedCode: atom(true),
      activateWorkspace(nextWorkspaceId: string) {
        workspaceId = nextWorkspaceId;
        previewRequest = null;
        previewState.set(idleState());
      },
      getActiveWorkspaceId: () => workspaceId,
      isWorkspaceActive: (candidate: string) => workspaceId === candidate,
      connectPreview(actions: { request: () => Promise<BuilderPreviewState> }) {
        previewRequest = actions.request;
        return () => {
          if (previewRequest === actions.request) {
            previewRequest = null;
          }
        };
      },
      requestPreview: () => {
        if (!previewRequest) {
          throw new Error('The remote preview connection is not ready.');
        }
        return previewRequest();
      },
      updatePreview: vi.fn((state: BuilderPreviewState) => previewState.set(state)),
      flushPendingEditorChange: vi.fn(),
      saveCurrentDocument: vi.fn(),
      setDocuments: vi.fn(),
      setDocumentContent: vi.fn(),
      setCurrentDocumentScrollPosition: vi.fn(),
      setSelectedFile: vi.fn(),
      resetCurrentDocument: vi.fn(),
    },
  };
});
import { ChatIdProvider } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { useWorkbenchController } from './useWorkbenchController';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  workbenchStore.activateWorkspace(`test-cleanup-${Date.now()}`);
  document.body.replaceChildren();
});

describe('useWorkbenchController preview requests', () => {
  it('does not expose a pending request from another workspace in the same chat', async () => {
    const oldPreview = deferred<BuilderPreviewState>();
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectPreview({ request: () => oldPreview.promise });

    const controller = await mountController();

    let request: Promise<void> | undefined;
    await act(async () => {
      request = controller()!.onPreviewRequest();
      await Promise.resolve();
    });
    expect(controller()?.previewRequesting).toBe(true);

    await act(async () => workbenchStore.activateWorkspace('account:chat--transcript-1-0'));

    expect(controller()?.projectId).toBe('chat');
    expect(controller()?.previewRequesting).toBe(false);

    await act(async () => {
      oldPreview.resolve(idleBuilderPreviewState());
      await request;
    });
    expect(controller()?.previewRequesting).toBe(false);
  });

  it('invalidates a pending manual preview request on unmount', async () => {
    const pendingPreview = deferred<BuilderPreviewState>();
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectPreview({ request: () => pendingPreview.promise });

    const controller = await mountController();

    let request!: Promise<void>;
    act(() => {
      request = controller()!.onPreviewRequest();
    });
    await act(async () => root?.unmount());
    root = undefined;

    await act(async () => {
      pendingPreview.resolve(idleBuilderPreviewState());
      await request;
    });

    expect(workbenchStore.updatePreview).not.toHaveBeenCalled();
  });

  it('requests a new immutable preview after a saved workspace change', async () => {
    const requestPreview = vi.fn(() => Promise.resolve(idleBuilderPreviewState()));
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectPreview({ request: requestPreview });

    const controller = await mountController();

    act(() => controller()!.onFileSave());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workbenchStore.saveCurrentDocument).toHaveBeenCalled();
    expect(requestPreview).toHaveBeenCalledOnce();
  });

  it('does not continue a pending save into preview after unmount', async () => {
    const pendingSave = deferred<void>();
    const requestPreview = vi.fn(() => Promise.resolve(idleBuilderPreviewState()));
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectPreview({ request: requestPreview });
    vi.mocked(workbenchStore.saveCurrentDocument).mockReturnValueOnce(pendingSave.promise);

    const controller = await mountController();

    act(() => controller()!.onFileSave());
    await act(async () => root?.unmount());
    root = undefined;
    await act(async () => {
      pendingSave.resolve();
      await pendingSave.promise;
      await Promise.resolve();
    });

    expect(requestPreview).not.toHaveBeenCalled();
    expect(workbenchStore.updatePreview).not.toHaveBeenCalled();
  });
});

/** Mounts the hook and returns an accessor, since the harness reassigns on every render. */
async function mountController() {
  let controller: ReturnType<typeof useWorkbenchController> | undefined;
  function Harness() {
    controller = useWorkbenchController();
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <ChatIdProvider chatId="chat">
        <Harness />
      </ChatIdProvider>,
    ),
  );
  return () => controller;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
