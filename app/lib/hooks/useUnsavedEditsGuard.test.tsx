// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedEditsGuard } from './useUnsavedEditsGuard';

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/chat/a');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function renderGuardedChat(editsAtRisk: boolean) {
  const rootRoute = createRootRoute({
    component: function GuardedChat() {
      useUnsavedEditsGuard(editsAtRisk);
      return <Outlet />;
    },
  });
  const chatRoute = createRoute({ getParentRoute: () => rootRoute, path: '/chat/$id' });
  const router = createRouter({ routeTree: rootRoute.addChildren([chatRoute]), history: createBrowserHistory() });
  await router.load();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<RouterProvider router={router} />));
  return router;
}

function pageUnloadIsHeld() {
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  return unload.defaultPrevented;
}

describe('useUnsavedEditsGuard', () => {
  it('asks before leaving the project with unsaved edits, and stays when the person cancels', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const router = await renderGuardedChat(true);

    // A blocked navigation's promise never settles.
    await act(async () => void router.navigate({ to: '/chat/$id', params: { id: 'b' } }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('not saved'));
    expect(router.state.location.pathname).toBe('/chat/a');
    expect(pageUnloadIsHeld()).toBe(true);

    confirm.mockReturnValue(true);
    await act(async () => router.navigate({ to: '/chat/$id', params: { id: 'b' } }));
    expect(router.state.location.pathname).toBe('/chat/b');
  });

  it('lets navigation within the same chat through without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const router = await renderGuardedChat(true);

    await act(async () => router.navigate({ to: '/chat/$id', params: { id: 'a' }, hash: 'files' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.hash).toBe('files');
  });

  it('holds nothing back without edits at risk', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const router = await renderGuardedChat(false);

    await act(async () => router.navigate({ to: '/chat/$id', params: { id: 'b' } }));

    expect(confirm).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe('/chat/b');
    expect(pageUnloadIsHeld()).toBe(false);
  });
});
