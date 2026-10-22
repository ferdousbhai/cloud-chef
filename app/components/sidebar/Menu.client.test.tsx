// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedEditsGuard } from '~/lib/hooks/useUnsavedEditsGuard';
import { AGENT_GC_GRACE_PERIOD_MS } from '~/lib/cloudflare/data/agent-gc.server';
import { RemoveProjectNotice, removeProject } from './Menu.client';

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/chat/open-chat');
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

async function renderChatWithUnsavedEdits() {
  const rootRoute = createRootRoute({
    component: function ChatWithUnsavedEdits() {
      useUnsavedEditsGuard(true);
      return null;
    },
  });
  const router = createRouter({ routeTree: rootRoute, history: createBrowserHistory() });
  await router.load();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<RouterProvider router={router} />));
}

describe('removeProject', () => {
  it('asks before deleting the open chat over unsaved edits, and deletes nothing when the person stays', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderChatWithUnsavedEdits();
    const remove = vi.fn(async () => undefined);

    await removeProject('user-a', 'open-chat', 'open-chat', remove);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('not saved'));
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes another chat without asking, since the open one and its edits stay', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderChatWithUnsavedEdits();
    const remove = vi.fn(async () => undefined);

    await removeProject('user-a', 'other-chat', 'open-chat', remove);

    expect(confirm).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('user-a', 'other-chat');
  });
});

describe('RemoveProjectNotice', () => {
  it('says what removal deletes and after how long, and links the privacy notice', async () => {
    const rootRoute = createRootRoute({ component: () => <RemoveProjectNotice title="Recipe box" /> });
    const router = createRouter({ routeTree: rootRoute, history: createBrowserHistory() });
    await router.load();
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root?.render(<RouterProvider router={router} />));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Recipe box');
    // The grace period the cleanup sweeps wait, as the notice states it.
    expect(text).toContain(`${AGENT_GC_GRACE_PERIOD_MS / 60_000}-minute grace period`);
    expect(text).toMatch(/live site, databases, stored files, and\s+workspace are deleted/);
    expect(document.querySelector('a[href="/privacy"]')?.textContent).toBe('Privacy notice');
  });
});
