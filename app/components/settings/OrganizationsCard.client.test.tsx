// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import { refreshSession } from '~/lib/auth-client';
import { OrganizationsCard } from './OrganizationsCard.client';

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
    hosting: 'cloudchef',
    ownerUserId: 'user-1',
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
  hosting: 'own',
  ownerUserId: null,
  connection: { accountName: 'Studio account', active: true },
  members: null,
  invites: null,
};

let organizations: (ReturnType<typeof ownSpace> | typeof studio)[] = [];
/** Whether the session says Sam is alone in their space. */
let solo = true;
let root: Root | undefined;

async function server(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url === '/api/auth/session') {
    const context: WorkspaceContext = {
      connectionId: 'connection-1',
      accountName: 'CloudChef',
      orgId: 'space-1',
      orgName: 'Sam’s space',
      role: 'admin',
      draftsAllowed: true,
      hosting: 'cloudchef',
      solo,
      personal: false,
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

describe('the spaces a person builds in, in Settings', () => {
  it('lists the one made for them as Personal while they are alone in it, beside the ones they were invited into', async () => {
    solo = true;
    organizations = [ownSpace([]), studio];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Studio'));
    const headings = Array.from(document.querySelectorAll('h3'), (heading) => heading.textContent);
    expect(headings).toEqual(['Personal', 'Studio']);
    expect(text()).toContain('Run by CloudChef');
    expect(text()).not.toContain('team');
  });

  it('offers, alone in it, to invite someone and says what that adds, with no list of people', async () => {
    solo = true;
    organizations = [ownSpace([])];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Only you so far.'));
    expect(text()).toContain('$30 a month to your subscription');
    expect(document.querySelector('ul')?.hidden).toBe(true);
  });

  it('says a space on a Cloudflare account of its own costs nothing here for its people', async () => {
    solo = true;
    organizations = [{ ...ownSpace([]), hosting: 'own', connection: { accountName: 'Sam’s account', active: true } }];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Only you so far.'));
    expect(text()).toContain('Nothing to pay CloudChef for them.');
    expect(text()).not.toContain('$30');
  });

  it('goes by its name once someone has joined, and lists them, its owner unchanged', async () => {
    solo = false;
    organizations = [ownSpace([gia])];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Gia'));
    expect(document.querySelector('h3')?.textContent).toBe('Sam’s space');
    expect(text()).toContain('Owner');
    expect(text()).not.toContain('Only you so far.');
    expect(document.querySelector('ul')?.hidden).toBe(false);
  });
});
