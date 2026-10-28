import { chatStore } from './workspaceId';
import { workbenchStore } from './workbench.client';

const workspaceSurfaces = ['chat', 'code', 'preview', 'terminal'] as const;
export type WorkspaceSurface = (typeof workspaceSurfaces)[number];

export function currentWorkspaceSurface(): WorkspaceSurface {
  return workbenchStore.showWorkbench.get() ? workbenchStore.currentView.get() : 'chat';
}

export function selectWorkspaceSurface(surface: WorkspaceSurface): void {
  chatStore.setKey('showChat', true);
  if (surface === 'chat') {
    workbenchStore.showWorkbench.set(false);
    return;
  }
  workbenchStore.currentView.set(surface);
  workbenchStore.showWorkbench.set(true);
}

export function adjacentWorkspaceSurface(
  surface: WorkspaceSurface,
  direction: 'previous' | 'next',
): WorkspaceSurface | null {
  const offset = direction === 'next' ? 1 : -1;
  return workspaceSurfaces[workspaceSurfaces.indexOf(surface) + offset] ?? null;
}
