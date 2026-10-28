// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceIdProvider } from '~/lib/stores/workspaceId';
import { description as descriptionStore } from '~/lib/stores/description';
import { HistoryItem } from './HistoryItem';

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/chat/open-chat');
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  descriptionStore.set(undefined);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('HistoryItem', () => {
  it('names a project with no title yet "Untitled project", not after the open chat', async () => {
    descriptionStore.set('Open chat title');
    const item = { id: 'untitled', initialId: 'untitled', timestamp: new Date(0).toISOString() };
    const rootRoute = createRootRoute({
      component: () => (
        <WorkspaceIdProvider workspaceId="open-chat">
          <HistoryItem item={item} handleDeleteClick={() => undefined} onNavigate={() => undefined} />
        </WorkspaceIdProvider>
      ),
    });
    const router = createRouter({ routeTree: rootRoute, history: createBrowserHistory() });
    await router.load();
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root?.render(<RouterProvider router={router} />));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Untitled project');
    expect(text).not.toContain('Open chat title');
  });
});
