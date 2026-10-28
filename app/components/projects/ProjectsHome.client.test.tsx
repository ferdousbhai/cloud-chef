// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import type { WorkspaceSummary } from '~/lib/cloudflare/data-api';
import type { App, TeamProject } from '~/lib/cloudflare/org-projects.client';
import { refreshSession } from '~/lib/auth-client';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { toast } from 'sonner';
import { ProjectsHome, PUBLISHING_REFRESH_MS } from './ProjectsHome.client';

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
const teamAdmin: WorkspaceContext = { ...teamMember, connectionId: 'connection-3', role: 'admin', draftsAllowed: true };

let context: WorkspaceContext = personal;
let ownProjects: WorkspaceSummary[] = [];
let teamProjects: TeamProject[] = [];
let apps: App[] = [];
/** The workspace runtime's publish routes, or null where it hasn't been upgraded to have them. */
let deployRoutes: { log: string } | null = null;
const deployRequests: unknown[] = [];
const visibilityRequests: unknown[] = [];
const copyRequests: unknown[] = [];
const removeRequests: unknown[] = [];

/** CloudChef's routes and the workspace runtime, as the home reaches them. */
async function server(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === '/api/auth/session') {
    const session: CloudflareAuthSession = {
      session: { id: 'session-1', userId: 'user-1', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
      user: { id: 'user-1', name: 'Ada', email: 'ada@example.com', image: null, username: 'ada' },
      context,
      contexts: [context],
    };
    return Response.json(session);
  }
  if (url === '/api/org-projects') {
    return Response.json({ projects: teamProjects });
  }
  if (url === '/api/projects/copy' && init?.method === 'POST') {
    copyRequests.push(JSON.parse(String(init.body)));
    return Response.json(
      { projectId: 'app-9', initialId: 'chat-9', fullName: 'ada/booking-site-copy' },
      { status: 201 },
    );
  }
  if (url === '/api/organizations/projects/unlink' && init?.method === 'POST') {
    removeRequests.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 204 });
  }
  if (url === '/api/apps') {
    return Response.json({ apps });
  }
  if (url === '/api/projects/visibility' && init?.method === 'POST') {
    const body: { projectId: string; visibility: string } = JSON.parse(String(init.body));
    visibilityRequests.push(body);
    return Response.json({ visibility: body.visibility });
  }
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (url === `${RUNTIME}/v1/data`) {
    return Response.json({ result: ownProjects });
  }
  if (deployRoutes && url === `${RUNTIME}/v1/projects/deploy` && init?.method === 'POST') {
    deployRequests.push(JSON.parse(String(init.body)));
    return Response.json({ deploymentId: 'deployment-2' }, { status: 202 });
  }
  if (deployRoutes && url === `${RUNTIME}/v1/projects/deploy-log?project=project-1&deployment=deployment-1`) {
    return new Response(deployRoutes.log, { headers: { 'Content-Type': 'text/plain' } });
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
  apps = [];
  deployRoutes = null;
  deployRequests.length = 0;
  visibilityRequests.length = 0;
  copyRequests.length = 0;
  removeRequests.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
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

const ADD = 'button[aria-label="Add an existing project"]';

/** Opens the "Add an existing project" menu and returns its choices. */
async function addChoices(): Promise<string[]> {
  return menuChoices(document.querySelector<HTMLButtonElement>(ADD));
}

/** Opens a card's "More" menu and returns its choices. */
async function moreChoices(title: string): Promise<string[]> {
  return menuChoices(card(title).querySelector<HTMLButtonElement>('button[aria-label^="More for "]'));
}

async function menuChoices(trigger: HTMLButtonElement | null): Promise<string[]> {
  if (!trigger) {
    throw new Error('No menu button');
  }
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  });
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '');
}

async function closeMenu() {
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
}

async function choose(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!item) {
    throw new Error(`No ${label} choice`);
  }
  await act(async () => item.click());
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
    // Adding code made elsewhere is one control beside the projects' heading, with no count or divider.
    expect(document.querySelector('#my-projects')?.parentElement?.querySelector(ADD)).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+ projects?\b/);
    expect(await addChoices()).toEqual(['Import from GitHub', 'Upload a ZIP']);
  });

  it("lists a project uploaded to the person's own account among their projects, with how its publishing went", async () => {
    context = personal;
    ownProjects = [{ id: 'chat-1', initialId: 'chat-1', description: 'Draft', timestamp: '2026-10-01T00:00:00.000Z' }];
    teamProjects = [{ ...uploaded({ state: 'building' }), lastCommitAt: '2026-10-20T00:00:00.000Z' }];
    await render('user-personal-upload');
    await vi.waitFor(() => card('Storefront'));

    expect(document.querySelector('#team-projects')).toBeNull();
    expect(card('Storefront').textContent).toContain('Publishing…');
    // Newest first, and with no team to share it with.
    expect([...document.querySelectorAll('li h3')].map((title) => title.textContent)).toEqual(['Storefront', 'Draft']);
    expect(card('Storefront').textContent).not.toMatch(/Owner|Can edit/);
  });

  it('says in one line that a person has no projects yet', async () => {
    context = personal;
    await render('user-empty');
    await vi.waitFor(() => expect(document.body.textContent).toContain('No projects yet.'));

    expect(document.querySelector('#my-projects')?.textContent).toBe('My projects');
    expect(document.querySelector(ADD)).not.toBeNull();
  });

  it("shows a team admin the team's projects first, with no empty section of their own", async () => {
    context = teamAdmin;
    teamProjects = [{ id: 'project-1', name: 'Storefront', role: 'edit', repo: 't-project-1' }];
    await render('user-admin');
    await vi.waitFor(() => card('Storefront'));
    // The admin's own list, empty, has finished loading too.
    await vi.waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === `${RUNTIME}/v1/data`)).toBe(true),
    );
    await act(async () => undefined);

    expect(document.querySelector('#team-projects')?.textContent).toBe('Team projects');
    expect(document.querySelector('#my-projects')).toBeNull();
    expect(document.querySelector('#team-projects')?.parentElement?.querySelector(ADD)).not.toBeNull();
    expect(card('Storefront').textContent).toContain('Owner');
    expect(await addChoices()).toEqual(['Import from GitHub', 'Upload a ZIP']);
  });

  it("lists a team admin's own projects after the team's once they have some", async () => {
    context = teamAdmin;
    teamProjects = [{ id: 'project-1', name: 'Storefront', role: 'edit', repo: 't-project-1' }];
    ownProjects = [{ id: 'chat-3', initialId: 'chat-3', description: 'Sketch', timestamp: new Date().toISOString() }];
    await render('user-admin-drafts');
    await vi.waitFor(() => card('Sketch'));

    const headings = [...document.querySelectorAll('h2')].map((heading) => heading.textContent);
    expect(headings).toEqual(['Team projects', 'My projects']);
    expect(document.querySelectorAll(ADD)).toHaveLength(1);
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
    expect(document.querySelector(ADD)).toBeNull();
    expect(card('Storefront').querySelector('button[aria-label="Edit Storefront"]')).not.toBeNull();
    expect(card('Storefront').textContent).toContain('Can edit');
    expect(card('Docs').querySelector('button[aria-label="Edit Docs"]')).toBeNull();
    expect(card('Docs').textContent).toContain('Can view');
    expect(card('Docs').textContent).toContain('Open site');
  });

  it('shows an uploaded project being published, asks again every few seconds, and stops once it is done', async () => {
    context = teamAdmin;
    teamProjects = [
      uploaded({ state: 'building' }),
      { id: 'project-2', name: 'Docs', role: 'edit', repo: 't-project-2', deploysWith: 'workers_builds' },
    ];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await render('user-publishing');
    await vi.waitFor(() => card('Storefront'));

    expect(card('Storefront').textContent).toContain('Publishing…');
    // A project Workers Builds publishes says nothing of CloudChef's publishing.
    expect(card('Docs').textContent).toContain('Not published yet');
    expect(card('Docs').textContent).not.toContain('Publishing');

    const listed = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/org-projects').length;
    const before = listed();
    teamProjects = [{ ...uploaded({ state: 'deploying' }), siteUrl: 'https://storefront.example.com' }];
    await act(async () => vi.advanceTimersByTimeAsync(PUBLISHING_REFRESH_MS));
    expect(listed()).toBe(before + 1);
    // The site stays in view while its next version is published.
    expect(card('Storefront').textContent).toContain('Updating…');
    expect(card('Storefront').textContent).toContain('Open site');

    const announced = vi.spyOn(toast, 'success');
    teamProjects = [{ ...uploaded({ state: 'succeeded' }), siteUrl: 'https://storefront.example.com' }];
    await act(async () => vi.advanceTimersByTimeAsync(PUBLISHING_REFRESH_MS));
    expect(listed()).toBe(before + 2);
    expect(card('Storefront').textContent).not.toContain('Updating…');
    // Once it ends, it is said once, wherever the person is looking.
    expect(announced).toHaveBeenCalledTimes(1);
    expect(announced).toHaveBeenCalledWith(
      'Storefront is live.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open site' }) }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(PUBLISHING_REFRESH_MS * 3));
    expect(listed()).toBe(before + 2);
  });

  it('shows a running publish’s step, and its progress as it happens', async () => {
    context = teamAdmin;
    deployRoutes = { log: '$ npm ci\nadded 312 packages' };
    teamProjects = [uploaded({ state: 'building', step: 'installing', stepStartedAt: Date.now() - 5_000 })];
    await render('user-progress');
    await vi.waitFor(() => card('Storefront'));

    expect(card('Storefront').textContent).toContain('Installing the project’s packages…');
    await click(card('Storefront'), 'Show progress');
    await vi.waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('added 312 packages'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Progress');
  });

  it("says an uploaded project didn't publish, tries again, and shows what happened", async () => {
    context = teamAdmin;
    deployRoutes = { log: 'npm run build\nError: Cannot find module "./missing"' };
    teamProjects = [uploaded({ state: 'failed', failureStage: 'build', reason: 'The build stopped with an error.' })];
    await render('user-failed');
    await vi.waitFor(() => card('Storefront'));

    expect(card('Storefront').textContent).toContain("Didn't publish. The build stopped with an error.");

    await click(card('Storefront'), 'Show what happened');
    await vi.waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('Cannot find module'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('What happened');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')?.click());

    await click(card('Storefront'), 'Try again');
    await vi.waitFor(() => expect(card('Storefront').textContent).toContain('Waiting to start…'));
    expect(deployRequests).toEqual([{ orgProjectId: 'project-1', deploymentId: 'deployment-1' }]);
    expect(card('Storefront').textContent).not.toContain("Didn't publish");
  });

  it('says the workspace is being updated when its runtime has no publish log yet', async () => {
    context = teamMember;
    teamProjects = [{ ...uploaded({ state: 'failed', reason: null }), role: 'view' }];
    await render('user-old-runtime');
    await vi.waitFor(() => card('Storefront'));

    // Someone who may only view the project can see what happened, but not publish it again.
    expect(buttons(card('Storefront'))).not.toContain('Try again');
    await click(card('Storefront'), 'Show what happened');
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
        'Your workspace is being updated. Try again in a few minutes.',
      ),
    );
  });

  it('offers to publish to the Worker the project names when that name was taken, after saying what it replaces', async () => {
    context = teamAdmin;
    deployRoutes = { log: '' };
    teamProjects = [
      {
        ...uploaded({
          state: 'succeeded',
          reason: 'A Worker named storefront was already in the account, so this went to storefront-1111.',
          workerName: 'storefront-1111',
          wantedWorkerName: 'storefront',
        }),
        siteUrl: 'https://storefront-1111.example.workers.dev',
      },
    ];
    await render('user-wanted-worker');
    await vi.waitFor(() => card('Storefront'));

    expect(card('Storefront').textContent).toContain('A Worker named storefront was already in the account');
    await click(card('Storefront'), 'Use the existing Worker instead');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Whatever the Worker named storefront runs now is replaced',
    );
    expect(deployRequests).toEqual([]);
    await click(document.querySelector<HTMLElement>('[role="dialog"]')!, 'Replace it');
    await vi.waitFor(() => expect(card('Storefront').textContent).toContain('Updating…'));
    expect(deployRequests).toEqual([{ orgProjectId: 'project-1', deploymentId: 'deployment-1', toWantedWorker: true }]);
  });

  it('offers Explore beside the projects, whether or not the person may add any', async () => {
    context = teamMember;
    teamProjects = [{ id: 'project-1', name: 'Storefront', role: 'edit', repo: 't-project-1' }];
    await render('user-member-explore');
    await vi.waitFor(() => card('Storefront'));

    expect(document.querySelector('#team-projects')?.parentElement?.querySelector('a[href="/explore"]')).not.toBeNull();
  });

  it('offers to make a project public or private only to someone who manages it, and a copy to everyone', async () => {
    context = teamAdmin;
    teamProjects = [
      { id: 'project-1', name: 'Storefront', role: 'edit', repo: 'r', visibility: 'private', canManage: true },
      {
        id: 'project-2',
        name: 'Docs',
        role: 'edit',
        repo: 'r',
        visibility: 'public',
        canManage: true,
        fullName: 'acme/docs',
      },
      { id: 'project-3', name: 'Notes', role: 'view', repo: 'r', visibility: 'public', canManage: false },
    ];
    await render('user-visibility-menu');
    await vi.waitFor(() => card('Notes'));

    const storefront = await moreChoices('Storefront');
    expect(storefront).toContain('Make public');
    expect(storefront).toContain('Make a copy');
    expect(storefront).not.toContain('Make private');
    await closeMenu();
    const docs = await moreChoices('Docs');
    expect(docs).toContain('Make private');
    expect(docs).not.toContain('Make public');
    await closeMenu();
    const notes = await moreChoices('Notes');
    expect(notes).toContain('Make a copy');
    expect(notes).not.toContain('Make public');
    expect(notes).not.toContain('Make private');

    // A public project says so, and its address on CloudChef is its second line.
    expect(card('Docs').textContent).toContain('Public');
    expect(card('Docs').textContent).toContain('acme/docs');
    // Its menu goes by that address too, since a copy can share its name.
    expect(card('Docs').querySelector('button[aria-label="More for acme/docs"]')).not.toBeNull();
    expect(card('Storefront').textContent).not.toContain('Public');
  });

  it('says what making a project public means before doing it', async () => {
    context = personal;
    teamProjects = [
      { id: 'project-1', name: 'Storefront', role: 'edit', repo: 'r', visibility: 'private', canManage: true },
    ];
    await render('user-make-public');
    await vi.waitFor(() => card('Storefront'));

    await moreChoices('Storefront');
    await choose('Make public');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Anyone signed in to CloudChef will be able to find it in Explore');
    expect(visibilityRequests).toEqual([]);

    await click(dialog!, 'Make public');
    await vi.waitFor(() => expect(card('Storefront').textContent).toContain('Public'));
    expect(visibilityRequests).toEqual([{ projectId: 'project-1', visibility: 'public' }]);

    // Making it private again needs no question.
    await moreChoices('Storefront');
    await choose('Make private');
    await vi.waitFor(() => expect(card('Storefront').textContent).not.toContain('Public'));
    expect(visibilityRequests).toEqual([
      { projectId: 'project-1', visibility: 'public' },
      { projectId: 'project-1', visibility: 'private' },
    ]);
  });

  it('lets whoever manages a project remove it from CloudChef, after saying its site and code stay', async () => {
    context = personal;
    teamProjects = [
      { id: 'project-1', name: 'Storefront', role: 'edit', repo: 'r', visibility: 'private', canManage: true },
      { id: 'project-2', name: 'Notes', role: 'view', repo: 'r', visibility: 'private', canManage: false },
    ];
    await render('user-remove');
    await vi.waitFor(() => card('Notes'));

    expect(await moreChoices('Notes')).not.toContain('Remove');
    await closeMenu();
    expect(await moreChoices('Storefront')).toContain('Remove');
    await choose('Remove');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Its site and its code stay in your Cloudflare account');
    expect(removeRequests).toEqual([]);

    await click(dialog!, 'Remove');
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Storefront'));
    expect(removeRequests).toEqual([{ projectId: 'project-1' }]);
  });

  it('opens Make a copy with the project’s name', async () => {
    context = teamAdmin;
    teamProjects = [{ id: 'project-1', name: 'Storefront', role: 'view', repo: 'r' }];
    await render('user-copy');
    await vi.waitFor(() => card('Storefront'));

    await moreChoices('Storefront');
    await choose('Make a copy');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.querySelector('input')?.value).toBe('Storefront');
    expect(dialog?.textContent).toContain('Acme');
  });

  it('gives an app made in a chat the same public and copy choices, once CloudChef has recorded it', async () => {
    context = personal;
    const at = new Date().toISOString();
    ownProjects = [
      { id: 'chat-1', initialId: 'chat-1', description: 'Booking site', timestamp: at },
      { id: 'chat-2', initialId: 'chat-2', description: 'Garden club', timestamp: at },
      { id: 'chat-3', initialId: 'chat-3', description: 'Just made', timestamp: at },
    ];
    apps = [
      { id: 'chat-1', fullName: 'ada/booking-site', visibility: 'private' },
      { id: 'chat-2', fullName: 'ada/garden-club', visibility: 'public' },
    ];
    await render('user-app-menu');
    await vi.waitFor(() => expect(card('Garden club').textContent).toContain('ada/garden-club'));

    expect(card('Garden club').textContent).toContain('Public');
    expect(card('Booking site').textContent).toContain('ada/booking-site');
    expect(card('Booking site').textContent).not.toContain('Public');
    const booking = await moreChoices('Booking site');
    expect(booking).toEqual(['History', 'Clone', 'Download ZIP', 'Make public', 'Make a copy']);
    await closeMenu();
    const garden = await moreChoices('Garden club');
    expect(garden).toContain('Make private');
    expect(garden).not.toContain('Make public');
    await closeMenu();
    // Not recorded yet: nothing to make public or copy.
    expect(await moreChoices('Just made')).toEqual(['History', 'Clone', 'Download ZIP']);
  });

  it('asks before making an app public, and makes it private again without asking', async () => {
    context = personal;
    ownProjects = [
      { id: 'chat-1', initialId: 'chat-1', description: 'Booking site', timestamp: new Date().toISOString() },
    ];
    apps = [{ id: 'chat-1', fullName: 'ada/booking-site', visibility: 'private' }];
    await render('user-app-make-public');
    await vi.waitFor(() => expect(card('Booking site').textContent).toContain('ada/booking-site'));

    await moreChoices('Booking site');
    await choose('Make public');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Make Booking site public?');
    expect(dialog?.textContent).toContain('Anyone signed in to CloudChef will be able to find it in Explore');
    expect(visibilityRequests).toEqual([]);

    await click(dialog!, 'Make public');
    await vi.waitFor(() => expect(card('Booking site').textContent).toContain('Public'));
    expect(visibilityRequests).toEqual([{ projectId: 'chat-1', visibility: 'public' }]);

    await moreChoices('Booking site');
    await choose('Make private');
    await vi.waitFor(() => expect(card('Booking site').textContent).not.toContain('Public'));
    expect(visibilityRequests).toEqual([
      { projectId: 'chat-1', visibility: 'public' },
      { projectId: 'chat-1', visibility: 'private' },
    ]);
  });

  it('makes a copy of an app and opens it', async () => {
    context = personal;
    ownProjects = [
      { id: 'chat-1', initialId: 'chat-1', description: 'Booking site', timestamp: new Date().toISOString() },
    ];
    apps = [{ id: 'chat-1', fullName: 'ada/booking-site', visibility: 'private' }];
    await render('user-app-copy');
    await vi.waitFor(() => expect(card('Booking site').textContent).toContain('ada/booking-site'));

    await moreChoices('Booking site');
    await choose('Make a copy');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.querySelector('input')?.value).toBe('Booking site');
    expect(dialog?.textContent).toContain('Personal');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    await click(dialog!, 'Make a copy');
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/chat/chat-9'));
    expect(copyRequests).toEqual([{ projectId: 'chat-1', name: 'Booking site' }]);
  });

  it("says an uploaded project is code only, or isn't published yet", async () => {
    context = teamAdmin;
    teamProjects = [
      uploaded({ state: 'not_deployable', reason: 'There is no app here to publish.' }),
      { ...uploaded(null), id: 'project-2', name: 'Notes' },
    ];
    await render('user-code-only');
    await vi.waitFor(() => card('Notes'));

    expect(card('Storefront').textContent).toContain('Code only');
    expect(card('Storefront').textContent).toContain('There is no app here to publish.');
    expect(card('Notes').textContent).toContain('Not published yet');
  });
});

/** A team project CloudChef publishes itself, with its newest publish. */
function uploaded(deployment: Partial<NonNullable<TeamProject['deployment']>> | null): TeamProject {
  return {
    id: 'project-1',
    name: 'Storefront',
    role: 'edit',
    repo: 't-project-1',
    deploysWith: 'cloudchef',
    deployment: deployment
      ? { id: 'deployment-1', state: 'queued', failureStage: null, reason: null, updatedAt: Date.now(), ...deployment }
      : null,
  };
}

function buttons(within: HTMLElement): string[] {
  return [...within.querySelectorAll('button')].map((button) => button.textContent ?? '');
}

async function click(within: HTMLElement, label: string) {
  const button = [...within.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!button) {
    throw new Error(`No ${label} button`);
  }
  await act(async () => button.click());
}
