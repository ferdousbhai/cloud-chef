// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import { refreshSession } from '~/lib/auth-client';
import { OrganizationsCard, OwnSpacePeople } from './OrganizationsCard.client';

const usage = { turns: 0, inputTokens: 0, outputTokens: 0 };
const sam = { userId: 'user-1', name: 'Sam', email: 'sam@example.com', pausedAt: null, draftsAllowed: true, usage };
const gia = { ...sam, userId: 'user-2', name: 'Gia', email: 'gia@example.com', role: 'member' };

/** Sam's own space, which CloudChef runs, with the people given beside Sam. */
function ownSpace(others: (typeof gia)[]) {
  return {
    orgId: 'space-1',
    orgName: 'Sam’s space',
    role: 'admin',
    pausedAt: null,
    managed: true,
    connection: { accountName: 'CloudChef', active: true },
    members: [{ ...sam, role: 'admin' }, ...others],
    invites: [],
    github: [],
    projects: [],
  };
}

const studio = {
  ...ownSpace([]),
  orgId: 'org-2',
  orgName: 'Studio',
  role: 'member',
  managed: false,
  members: null,
  invites: null,
};

let organizations: (ReturnType<typeof ownSpace> | typeof studio)[] = [];
let root: Root | undefined;

async function server(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url === '/api/auth/session') {
    const context: WorkspaceContext = {
      kind: 'organization',
      connectionId: 'connection-1',
      accountName: 'CloudChef',
      orgId: 'space-1',
      orgName: 'Sam’s space',
      role: 'admin',
      draftsAllowed: true,
      managed: true,
      solo: true,
    };
    const session: CloudflareAuthSession = {
      session: { id: 'session-1', userId: 'user-1', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
      user: { id: 'user-1', name: 'Sam', email: 'sam@example.com', image: null, username: 'sam' },
      context,
      contexts: [context],
    };
    return Response.json(session);
  }
  if (url === '/api/organizations') {
    return Response.json({ organizations });
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(server));
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render(element: ReactElement) {
  await refreshSession();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => element }),
    history: createMemoryHistory(),
  });
  await router.load();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(<RouterProvider router={router} />));
}

const text = () => document.body.textContent ?? '';

describe('a space of the person’s own that CloudChef runs, in Settings', () => {
  it('is not listed among their teams, which are the teams they are in', async () => {
    organizations = [ownSpace([]), studio];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Studio'));
    expect(text()).not.toContain('Sam’s space');
  });

  it('says they are in no team when their own space is all they have', async () => {
    organizations = [ownSpace([])];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain("You're not in a team yet."));
    expect(text()).not.toContain('Sam’s space');
  });

  it('offers, alone in it, to invite someone and says what that adds, with no list of people or team name', async () => {
    organizations = [ownSpace([])];
    await render(<OwnSpacePeople />);

    await vi.waitFor(() => expect(text()).toContain('Only you so far.'));
    expect(text()).toContain('$30 a month to your subscription');
    expect(text()).not.toContain('Sam’s space');
    expect(text()).not.toContain('team');
    expect(document.querySelector('ul')?.hidden).toBe(true);
  });

  it('lists the people in it once someone has joined, and the name they see it by', async () => {
    organizations = [ownSpace([gia])];
    await render(<OwnSpacePeople />);

    await vi.waitFor(() => expect(text()).toContain('Gia'));
    expect(text()).toContain('They see your space as Sam’s space.');
    expect(text()).not.toContain('Only you so far.');
    expect(document.querySelector('ul')?.hidden).toBe(false);
  });
});
