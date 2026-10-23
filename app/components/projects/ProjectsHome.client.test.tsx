// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import type { ChatHistorySummary } from '~/lib/cloudflare/data-api';
import type { TeamProject } from '~/lib/cloudflare/org-projects.client';
import { refreshSession } from '~/lib/auth-client';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { ProjectsHome } from './ProjectsHome.client';

const RUNTIME = 'https://runtime.example.workers.dev';
const personal: WorkspaceContext = { kind: 'personal', connectionId: 'connection-1', accountName: null };
const teamMember: WorkspaceContext = {
  kind: 'organization',
  connectionId: 'connection-2',
  accountName: null,
  orgId: 'org-1',
  orgName: 'Acme',
  role: 'member',
  draftsAllowed: false,
};

let context: WorkspaceContext = personal;
let ownProjects: ChatHistorySummary[] = [];
let teamProjects: TeamProject[] = [];

/** CloudChef's routes and the workspace runtime, as the home reaches them. */
async function server(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url === '/api/auth/session') {
    const session: CloudflareAuthSession = {
      session: { id: 'session-1', userId: 'user-1', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
      user: { id: 'user-1', name: 'Ada', email: 'ada@example.com', image: null },
      context,
      contexts: [context],
    };
    return Response.json(session);
  }
  if (url === '/api/org-projects') {
    return Response.json({ projects: teamProjects });
  }
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (url === `${RUNTIME}/v1/data`) {
    return Response.json({ result: ownProjects });
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

class InertObserver {
  observe = () => undefined;
  disconnect = () => undefined;
}

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(server));
  vi.stubGlobal('IntersectionObserver', InertObserver);
  vi.stubGlobal('ResizeObserver', InertObserver);
  resetUserRuntimeSession();
  ownProjects = [];
  teamProjects = [];
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The home's projects for `userId`; each test uses its own, since the project list is cached per person. */
async function render(userId: string) {
  await refreshSession();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ProjectsHome userId={userId} /> }),
    history: createMemoryHistory(),
  });
  await router.load();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<RouterProvider router={router} />));
}

function card(title: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('li')].find((item) =>
    item.querySelector('h3')?.textContent?.includes(title),
  );
  if (!found) {
    throw new Error(`No card for ${title}`);
  }
  return found;
}

describe('ProjectsHome', () => {
  it("lists the person's own projects, with Open site only once published", async () => {
    context = personal;
    ownProjects = [
      {
        id: 'chat-1',
        initialId: 'chat-1',
        description: 'Booking site',
        timestamp: new Date().toISOString(),
        productionUrl: 'https://booking.example.workers.dev',
      },
      { id: 'chat-2', initialId: 'chat-2', description: 'Draft', timestamp: new Date().toISOString() },
    ];
    await render('user-personal');
    await vi.waitFor(() => card('Booking site'));

    expect(document.querySelector('#my-projects')?.textContent).toBe('My projects');
    expect(document.querySelector('#team-projects')).toBeNull();
    expect(card('Booking site').querySelector('a[href="/chat/chat-1"]')?.textContent).toContain('Edit');
    expect(card('Booking site').querySelector('a[href="https://booking.example.workers.dev"]')).not.toBeNull();
    expect(card('Draft').textContent).toContain('Not published yet');
    expect(card('Draft').textContent).not.toContain('Open site');
    expect(document.body.textContent).toContain('Import from GitHub');
  });

  it('shows a member the team projects shared with them, with Edit only where they can edit', async () => {
    context = teamMember;
    teamProjects = [
      { id: 'project-1', name: 'Storefront', role: 'edit', repo: 't-project-1' },
      { id: 'project-2', name: 'Docs', role: 'view', repo: 't-project-2', siteUrl: 'https://docs.example.com' },
    ];
    await render('user-member');
    await vi.waitFor(() => card('Docs'));

    expect(document.querySelector('#team-projects')?.textContent).toBe('Shared with me');
    // A member limited to the team's projects has none of their own, and imports none.
    expect(document.querySelector('#my-projects')).toBeNull();
    expect(document.body.textContent).not.toContain('Import from GitHub');
    expect(card('Storefront').querySelector('button[aria-label="Edit Storefront"]')).not.toBeNull();
    expect(card('Storefront').textContent).toContain('Can edit');
    expect(card('Docs').querySelector('button[aria-label="Edit Docs"]')).toBeNull();
    expect(card('Docs').textContent).toContain('Can view');
    expect(card('Docs').textContent).toContain('Open site');
  });
});
