// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/stores/workbench.client', async () => {
  const { atom, map } = await import('nanostores');
  let workspaceId: string | null = null;
  const linkedProject = atom<{ repository: string; defaultBranch: string } | null>(null);
  const conversationClosed = atom(false);

  return {
    workbenchStore: {
      showWorkbench: atom(false),
      selectedFile: atom<string | undefined>(undefined),
      currentDocument: atom(undefined),
      unsavedFiles: atom(new Set()),
      files: map({}),
      currentView: atom<'code' | 'preview'>('code'),
      followingStreamedCode: atom(true),
      linkedProject,
      linkedSite: atom(null),
      conversationClosed,
      activateWorkspace(nextWorkspaceId: string) {
        workspaceId = nextWorkspaceId;
        linkedProject.set(null);
        conversationClosed.set(false);
      },
      getActiveWorkspaceId: () => workspaceId,
      isWorkspaceActive: (candidate: string) => workspaceId === candidate,
      flushPendingEditorChange: vi.fn(),
      saveCurrentDocument: vi.fn(() => Promise.resolve()),
      setDocuments: vi.fn(),
      setDocumentContent: vi.fn(),
      setCurrentDocumentScrollPosition: vi.fn(),
      setSelectedFile: vi.fn(),
      resetCurrentDocument: vi.fn(),
    },
  };
});
import { WorkspaceIdProvider } from '~/lib/stores/workspaceId';
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

describe('useWorkbenchController saves', () => {
  it("saves the project's file and shows which project it is", async () => {
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.linkedProject.set({ repository: 'ada/site', defaultBranch: 'main' });

    const controller = await mountController();

    act(() => controller()!.onFileSave());
    await act(async () => {
      await Promise.resolve();
    });

    expect(workbenchStore.saveCurrentDocument).toHaveBeenCalled();
    expect(controller()!.linkedProject).toEqual({ repository: 'ada/site', defaultBranch: 'main' });
  });

  it('never saves a file in a conversation a newer one continues', async () => {
    workbenchStore.activateWorkspace('account:chat--transcript-0-0');
    workbenchStore.conversationClosed.set(true);

    const controller = await mountController();

    act(() => controller()!.onFileSave());
    await act(async () => {
      await Promise.resolve();
    });

    expect(workbenchStore.saveCurrentDocument).not.toHaveBeenCalled();
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
      <WorkspaceIdProvider workspaceId="chat">
        <Harness />
      </WorkspaceIdProvider>,
    ),
  );
  return () => controller;
}
