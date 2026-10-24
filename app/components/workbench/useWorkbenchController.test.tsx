// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuilderDeploymentState } from '~/agents/builder-deployment-command';

vi.mock('~/lib/stores/workbench.client', async () => {
  const { atom, map } = await import('nanostores');
  const { emptyAppSiteState } = await import('~/lib/common/app-site');
  let workspaceId: string | null = null;
  let publish: (() => Promise<BuilderDeploymentState>) | null = null;
  const siteState = atom(emptyAppSiteState());
  const linkedProject = atom<{ repository: string; defaultBranch: string; archived?: boolean } | null>(null);

  return {
    workbenchStore: {
      siteState,
      showWorkbench: atom(false),
      selectedFile: atom<string | undefined>(undefined),
      currentDocument: atom(undefined),
      unsavedFiles: atom(new Set()),
      files: map({}),
      currentView: atom<'code' | 'preview'>('code'),
      followingStreamedCode: atom(true),
      linkedProject,
      activateWorkspace(nextWorkspaceId: string) {
        workspaceId = nextWorkspaceId;
        publish = null;
        siteState.set(emptyAppSiteState());
        linkedProject.set(null);
      },
      getActiveWorkspaceId: () => workspaceId,
      isWorkspaceActive: (candidate: string) => workspaceId === candidate,
      connectSite(actions: { publish: () => Promise<BuilderDeploymentState> }) {
        publish = actions.publish;
        return () => {
          if (publish === actions.publish) {
            publish = null;
          }
        };
      },
      publishSite: () => {
        if (!publish) {
          throw new Error('The connection to the builder is not ready.');
        }
        return publish();
      },
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

const deploying: BuilderDeploymentState = { status: 'deploying', workspaceRevision: 1, revision: 'a'.repeat(64) };

describe('useWorkbenchController publish requests', () => {
  it('does not expose a pending request from another workspace in the same chat', async () => {
    const oldPublish = deferred<BuilderDeploymentState>();
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectSite({ publish: () => oldPublish.promise });

    const controller = await mountController();

    let request: Promise<void> | undefined;
    await act(async () => {
      request = controller()!.onPublishRequest();
      await Promise.resolve();
    });
    expect(controller()?.publishRequesting).toBe(true);

    await act(async () => workbenchStore.activateWorkspace('account:chat--transcript-1-0'));

    expect(controller()?.projectId).toBe('chat');
    expect(controller()?.publishRequesting).toBe(false);

    await act(async () => {
      oldPublish.resolve(deploying);
      await request;
    });
    expect(controller()?.publishRequesting).toBe(false);
  });

  it('publishes the app after a saved workspace change', async () => {
    const publish = vi.fn(() => Promise.resolve(deploying));
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectSite({ publish });

    const controller = await mountController();

    act(() => controller()!.onFileSave());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workbenchStore.saveCurrentDocument).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("saves a GitHub project's file without asking CloudChef to publish what its pipeline builds", async () => {
    const publish = vi.fn(() => Promise.resolve(deploying));
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectSite({ publish });
    workbenchStore.linkedProject.set({ repository: 'ada/site', defaultBranch: 'main' });

    const controller = await mountController();

    act(() => controller()!.onFileSave());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workbenchStore.saveCurrentDocument).toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(controller()!.linkedProject).toEqual({ repository: 'ada/site', defaultBranch: 'main' });
  });

  it('never saves a file of a GitHub project conversation a newer one took over', async () => {
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.linkedProject.set({ repository: 'ada/site', defaultBranch: 'main', archived: true });

    const controller = await mountController();

    act(() => controller()!.onFileSave());
    await act(async () => {
      await Promise.resolve();
    });

    expect(workbenchStore.saveCurrentDocument).not.toHaveBeenCalled();
  });

  it('does not continue a pending save into publishing after unmount', async () => {
    const pendingSave = deferred<void>();
    const publish = vi.fn(() => Promise.resolve(deploying));
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.connectSite({ publish });
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

    expect(publish).not.toHaveBeenCalled();
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
