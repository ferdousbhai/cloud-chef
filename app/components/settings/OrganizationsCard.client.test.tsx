// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import { refreshSession } from '~/lib/auth-client';
import { OrganizationsCard } from './OrganizationsCard.client';

const usage = { turns: 0, inputTokens: 0, outputTokens: 0 };
const sam = { userId: 'user-1', name: 'Sam', email: 'sam@example.com', pausedAt: null, usage };
const gia = { ...sam, userId: 'user-2', name: 'Gia', email: 'gia@example.com', role: 'member' };

const emptyAccess: { userId: string; role: string }[] = [];
const shop = {
  id: 'project-1',
  name: 'Shop',
  repo: 't-shop',
  createdFrom: 'chat',
  deploysWith: 'cloudchef',
  importRepoFullName: null,
  access: emptyAccess,
};

const noProjects: (typeof shop)[] = [];

/** Sam's own space, with the people given beside Sam. */
function ownSpace(others: (typeof gia)[]) {
  return {
    orgId: 'space-1',
    orgName: 'Sam’s space',
    role: 'admin',
    pausedAt: null,
    ownerUserId: 'user-1',
    connection: { accountName: 'Sam’s account', active: true },
    members: [{ ...sam, role: 'admin' }, ...others],
    github: [],
    projects: noProjects,
  };
}

const studio = {
  ...ownSpace([]),
  orgId: 'org-2',
  orgName: 'Studio',
  role: 'member',
  ownerUserId: null,
  connection: { accountName: 'Studio account', active: true },
  members: null,
};

let organizations: (ReturnType<typeof ownSpace> | (typeof studio & { owner?: { name: string; image: null } }))[] = [];
/** Whether the session says Sam is alone in their space. */
let solo = true;
let root: Root | undefined;

async function server(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url === '/api/auth/session') {
    const context: WorkspaceContext = {
      connectionId: 'connection-1',
      accountName: 'Sam’s account',
      orgId: 'space-1',
      orgName: 'Sam’s space',
      role: 'admin',
      draftsAllowed: true,
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

describe('the people on a person’s projects, in Settings', () => {
  it('names no account: their own shows its people and Cloudflare, another’s shows whose projects they are on', async () => {
    solo = true;
    organizations = [ownSpace([]), { ...studio, owner: { name: 'Ada', image: null }, projects: [shop] }];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Ada'));
    expect(document.querySelectorAll('h3')).toHaveLength(0);
    expect(text()).not.toContain('Sam’s space');
    expect(text()).not.toContain('Studio');
    expect(text()).toContain('Shared Shop with you');
    expect(text()).toContain('CloudflareSam’s account');
    expect(text()).not.toContain('team');
  });

  it('says, with nobody else on their projects, that sharing a project is how someone joins', async () => {
    solo = true;
    organizations = [{ ...ownSpace([]), connection: { accountName: 'Sam@example.com’s Account', active: true } }];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Nobody else yet.'));
    // A Cloudflare account named after an address is only said to be connected.
    expect(text()).toContain('CloudflareConnected');
    expect(text().toLowerCase()).not.toContain('sam@example.com');
    expect(text()).toContain('share it with them from its menu');
    expect(document.querySelector('ul')).toBeNull();
    // Never their own row: they know they are there.
    expect(text()).not.toContain('sam@example.com');
  });

  it('lists the people on their projects by face and name, with what each may do in plain words', async () => {
    solo = false;
    organizations = [
      {
        ...ownSpace([gia, { ...gia, userId: 'user-3', name: 'Kim', email: 'kim@example.com', role: 'admin' }]),
        projects: [{ ...shop, access: [{ userId: 'user-2', role: 'view' }] }],
      },
    ];
    await render(<OrganizationsCard />);

    await vi.waitFor(() => expect(text()).toContain('Gia'));
    expect(text()).toContain('Shop · can view');
    expect(text()).toContain('Can do everything');
    expect(text()).not.toContain('Admin');
    expect(document.querySelectorAll('[aria-label^="Manage "], [title^="Manage "]').length).toBe(2);
  });
});
