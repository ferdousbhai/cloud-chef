// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnsavedEditsGuard } from '~/lib/hooks/useUnsavedEditsGuard';
import { OrgProjectsList } from './OrgProjectsList.client';

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

/** The sidebar's team projects in a chat whose editor holds edits not yet saved. */
async function renderInChatWithUnsavedEdits() {
  const rootRoute = createRootRoute({
    component: function ChatWithUnsavedEdits() {
      useUnsavedEditsGuard(true);
      return <OrgProjectsList userId="user-a" query="" onNavigate={() => undefined} />;
    },
  });
  const router = createRouter({ routeTree: rootRoute, history: createBrowserHistory() });
  await router.load();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<RouterProvider router={router} />));
  await act(async () => Promise.resolve());
}

function projectButton() {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Site'));
  if (!button) {
    throw new Error('The project is not listed.');
  }
  return button;
}

describe('OrgProjectsList', () => {
  it('asks before opening a project over unsaved edits, and leaves every project usable when the person stays', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ projects: [{ id: 'project-a', name: 'Site', role: 'edit', repo: 't-project-a' }] }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderInChatWithUnsavedEdits();

    await act(async () => projectButton().click());

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('not saved'));
    // Nothing reached the workspace: the current conversation is neither archived nor left.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(projectButton().disabled).toBe(false);
    expect(projectButton().textContent).not.toContain('Opening');
  });
});
