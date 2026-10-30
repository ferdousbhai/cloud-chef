// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import type { TeamProject } from '~/lib/cloudflare/org-projects.client';
import { refreshSession } from '~/lib/auth-client';
import { cloudflareReauthorizationRequiredStore, resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import {
  ASK_ADMIN_TO_REAUTHORIZE_MESSAGE,
  REAUTHORIZE_CLOUDFLARE_MESSAGE,
} from '~/components/CloudflareReauthorizePrompt';
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
let teamProjects: TeamProject[] = [];
/** The workspace runtime's publish routes, or null where it hasn't been upgraded to have them. */
let deployRoutes: { log: string } | null = null;
/** Whether the control plane refuses a workspace session until Cloudflare is reauthorized. */
let reauthorizationRequired = false;
/** What the workspace runtime answers when a team project is opened, when it fails. */
let openFailure: string | null = null;
const deployRequests: unknown[] = [];
const visibilityRequests: unknown[] = [];
const deleteRequests: unknown[] = [];

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
  if (url === '/api/projects/delete/preview' && init?.method === 'POST') {
    return Response.json({
      sites: ['https://storefront.example.com'],
      workers: ['storefront'],
      buildTriggers: [],
      resources: [{ kind: 'database', id: 'db-1', name: 'shop-data' }],
      kept: [{ kind: 'storage', id: 'shared-files', name: 'shared-files', reason: 'another Worker uses it' }],
      repository: 'r',
    });
  }
  if (url === '/api/projects/delete' && init?.method === 'POST') {
    deleteRequests.push(JSON.parse(String(init.body)));
    return Response.json({ deleted: ['Worker storefront'] });
  }
  if (url === '/api/projects/visibility' && init?.method === 'POST') {
    const body: { projectId: string; visibility: string } = JSON.parse(String(init.body));
    visibilityRequests.push(body);
    return Response.json({ visibility: body.visibility });
  }
  if (url === '/api/cloudflare/runtime-session' && reauthorizationRequired) {
    return Response.json(
      {
        code: 'cloudflare_reauthorization_required',
        error: 'CloudChef needs updated Cloudflare permissions for this workspace.',
      },
      { status: 409 },
    );
  }
  if (url === `${RUNTIME}/v1/data` && openFailure && String(init?.body).includes('messages.openLinkedChat')) {
    return Response.json({ error: openFailure }, { status: 503 });
  }
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
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
  teamProjects = [];
  deployRoutes = null;
  reauthorizationRequired = false;
  openFailure = null;
  cloudflareReauthorizationRequiredStore.set(false);
  deployRequests.length = 0;
  visibilityRequests.length = 0;
  deleteRequests.length = 0;
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

/** The home's projects; `_name` names the person each test renders for. */
async function render(_name: string) {
  await refreshSession();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <ProjectsHome /> }),
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

/** Types into a text box as a person does, so React sees the change. */
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ProjectsHome', () => {
  it("lists the person's own projects, with Open site only once published", async () => {
    context = personal;
    teamProjects = [
      {
        id: 'project-1',
        name: 'Booking site',
        role: 'edit',
        repo: 'r',
        siteUrl: 'https://booking.example.workers.dev',
      },
      { id: 'project-2', name: 'Draft', role: 'edit', repo: 'r' },
    ];
    await render('user-personal');
    await vi.waitFor(() => card('Booking site'));

    expect(document.querySelector('#my-projects')?.textContent).toBe('My projects');
    expect(document.querySelector('#team-projects')).toBeNull();
    expect(card('Booking site').querySelector('button[aria-label="Edit Booking site"]')).not.toBeNull();
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
    teamProjects = [
      { id: 'project-2', name: 'Draft', role: 'edit', repo: 'r', createdAt: '2026-10-01T00:00:00.000Z' },
      { ...uploaded({ state: 'building' }), createdAt: '2026-10-20T00:00:00.000Z' },
    ];
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

  it("shows a team admin the team's projects, with no section of their own", async () => {
    context = teamAdmin;
    teamProjects = [{ id: 'project-1', name: 'Storefront', role: 'edit', repo: 't-project-1' }];
    await render('user-admin');
    await vi.waitFor(() => card('Storefront'));

    expect(document.querySelector('#team-projects')?.textContent).toBe('Team projects');
    expect(document.querySelector('#my-projects')).toBeNull();
    expect(document.querySelector('#team-projects')?.parentElement?.querySelector(ADD)).not.toBeNull();
    expect(card('Storefront').textContent).toContain('Owner');
    expect(await addChoices()).toEqual(['Import from GitHub', 'Upload a ZIP']);
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
    // In a team, a member sees only its projects, and imports none.
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

  it('leaves Explore to the header: the projects home has no link of its own', async () => {
    context = teamMember;
    await render('user-explore-link');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Shared with me'));
    expect(document.querySelector('a[href="/explore"]')).toBeNull();
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
    expect(dialog?.textContent).toContain('Each time it’s published it shows on your page');
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

  it('lets whoever manages a project delete it for good, listing what goes, once its name is typed', async () => {
    context = personal;
    teamProjects = [
      { id: 'project-1', name: 'Storefront', role: 'edit', repo: 'r', visibility: 'private', canManage: true },
      { id: 'project-2', name: 'Notes', role: 'view', repo: 'r', visibility: 'private', canManage: false },
    ];
    await render('user-delete');
    await vi.waitFor(() => card('Notes'));

    expect(await moreChoices('Notes')).not.toContain('Delete');
    await closeMenu();
    expect(await moreChoices('Storefront')).toContain('Delete');
    await choose('Delete');
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    await vi.waitFor(() => expect(dialog()?.textContent).toContain('Database shop-data'));
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('can’t be undone');
    expect(text).toContain('Worker storefront');
    expect(text).toContain('File storage shared-files: another Worker uses it');

    const confirm = () =>
      [...(dialog()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === 'Delete');
    expect(confirm()?.disabled).toBe(true);
    const input = dialog()?.querySelector('input');
    if (!input) {
      throw new Error('No confirmation box');
    }
    await type(input, 'storefront');
    expect(confirm()?.disabled).toBe(true);
    await type(input, 'Storefront');
    expect(confirm()?.disabled).toBe(false);
    expect(deleteRequests).toEqual([]);

    await act(async () => confirm()?.click());
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Storefront'));
    expect(deleteRequests).toEqual([{ projectId: 'project-1', confirm: 'Storefront' }]);
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

  it('asks once to reauthorize Cloudflare when the workspace needs it, instead of saying projects failed', async () => {
    context = personal;
    reauthorizationRequired = true;
    // The home's own call to the workspace (the prompt's model list) is what finds it.
    cloudflareReauthorizationRequiredStore.set(true);
    await render('user-reauthorize');
    await vi.waitFor(() => expect(document.body.textContent).toContain(REAUTHORIZE_CLOUDFLARE_MESSAGE));

    const prompts = document.querySelectorAll('[aria-label="Cloudflare permissions needed"]');
    expect(prompts).toHaveLength(1);
    expect(buttons(document.body)).toContain('Reauthorize Cloudflare');
    // Under the list it blocks, with no failure, empty list or raw refusal beside it.
    expect(
      document
        .querySelector('#my-projects')
        ?.closest('section')
        ?.contains(prompts[0] ?? null),
    ).toBe(true);
    expect(document.body.textContent).not.toContain('could not be loaded');
    expect(document.body.textContent).not.toContain('No projects yet');
    expect(document.body.textContent).not.toContain('updated Cloudflare permissions');
  });

  it("asks a team member to have the team's admin reauthorize when opening a project needs it", async () => {
    context = teamMember;
    teamProjects = [{ id: 'project-1', name: 'Storefront', role: 'edit', repo: 't-project-1' }];
    reauthorizationRequired = true;
    await render('user-member-reauthorize');
    await vi.waitFor(() => card('Storefront'));
    expect(document.body.textContent).not.toContain(ASK_ADMIN_TO_REAUTHORIZE_MESSAGE);
    const failed = vi.spyOn(toast, 'error');

    const edit = card('Storefront').querySelector<HTMLButtonElement>('button[aria-label="Edit Storefront"]');
    await act(async () => edit?.click());

    await vi.waitFor(() => expect(document.body.textContent).toContain(ASK_ADMIN_TO_REAUTHORIZE_MESSAGE));
    expect(document.querySelectorAll('[aria-label="Cloudflare permissions needed"]')).toHaveLength(1);
    expect(buttons(document.body)).not.toContain('Reauthorize Cloudflare');
    expect(failed).not.toHaveBeenCalled();
    failed.mockRestore();
    expect(card('Storefront').querySelector('[role="alert"]')).toBeNull();
  });

  it('says beside Edit why a project could not be opened', async () => {
    context = teamMember;
    teamProjects = [{ id: 'project-1', name: 'Storefront', role: 'edit', repo: 't-project-1' }];
    openFailure = 'The workspace runtime is unavailable.';
    await render('user-member-open-failure');
    await vi.waitFor(() => card('Storefront'));

    const edit = card('Storefront').querySelector<HTMLButtonElement>('button[aria-label="Edit Storefront"]');
    await act(async () => edit?.click());

    await vi.waitFor(() =>
      expect(card('Storefront').querySelector('[role="alert"]')?.textContent).toBe(
        'The workspace runtime is unavailable.',
      ),
    );
    expect(edit?.disabled).toBe(false);
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
