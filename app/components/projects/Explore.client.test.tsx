// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import type { PublicProject } from '~/lib/cloudflare/org-projects.client';
import { refreshSession } from '~/lib/auth-client';
import { CopyProjectDialog } from './CopyProjectDialog.client';
import { Explore } from './Explore.client';

const personal: WorkspaceContext = { kind: 'personal', connectionId: 'connection-1', accountName: null };
const team: WorkspaceContext = {
  kind: 'organization',
  connectionId: 'connection-2',
  accountName: null,
  orgId: 'org-1',
  orgName: 'Acme',
  role: 'member',
  draftsAllowed: true,
};

let context: WorkspaceContext = personal;
let publicProjects: PublicProject[] = [];
let copyAnswer: () => Response | Promise<Response> = () => Response.json({ error: 'Not here.' }, { status: 404 });
const copyRequests: unknown[] = [];

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
  if (url === '/api/explore') {
    return Response.json({ projects: publicProjects });
  }
  if (url === '/api/projects/copy' && init?.method === 'POST') {
    copyRequests.push(JSON.parse(String(init.body)));
    return copyAnswer();
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

/**
 * Observers that report a card on screen only when a test says it has scrolled into view. They hand the
 * thumbnail only what it reads of each entry.
 */
const watched: { element: Element; show: () => void }[] = [];

class TestIntersectionObserver {
  constructor(private readonly _callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe = (element: Element) => watched.push({ element, show: () => this._callback([{ isIntersecting: true }]) });
  disconnect = () => undefined;
}

class TestResizeObserver {
  constructor(private readonly _callback: (entries: { contentRect: { width: number } }[]) => void) {}
  observe = () => this._callback([{ contentRect: { width: 320 } }]);
  disconnect = () => undefined;
}

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(server));
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  context = personal;
  publicProjects = [];
  copyRequests.length = 0;
  watched.length = 0;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render(element: ReactNode) {
  await refreshSession();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(element));
}

function project(overrides: Partial<PublicProject>): PublicProject {
  return {
    id: 'project-1',
    name: 'Storefront',
    fullName: 'ada/storefront',
    owner: { username: 'ada', name: 'Ada Lovelace' },
    siteUrl: 'https://storefront.example.com',
    siteFrameable: true,
    createdAt: '2026-10-20T00:00:00.000Z',
    copiedFrom: null,
    ...overrides,
  };
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

async function click(within: HTMLElement, label: string) {
  const button = [...within.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!button) {
    throw new Error(`No ${label} button`);
  }
  await act(async () => button.click());
}

describe('Explore', () => {
  it('says how to make a project public when there are none', async () => {
    await render(<Explore />);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'No public projects yet. Make one of yours public from its card’s menu.',
      ),
    );
    expect(document.querySelector('li')).toBeNull();
  });

  it('shows each public project by its address, who made it, where it was copied from, and its site', async () => {
    publicProjects = [
      project({ copiedFrom: { fullName: 'grace/shop' } }),
      project({ id: 'project-2', name: 'Notes', fullName: null, siteUrl: null, siteFrameable: null }),
    ];
    await render(<Explore />);
    await vi.waitFor(() => card('Notes'));

    const storefront = card('ada/storefront');
    expect(storefront.textContent).toContain('By Ada Lovelace');
    expect(storefront.textContent).toContain('Copied from grace/shop');
    expect(storefront.querySelector('a[href="https://storefront.example.com"]')?.textContent).toContain('Open site');
    expect(storefront.querySelector('button[aria-label="Make a copy of ada/storefront"]')).not.toBeNull();
    // Without an address, a project goes by its name; without a site, it has none to open.
    expect(card('Notes').textContent).not.toContain('Copied from');
    expect(card('Notes').textContent).toContain('Not published yet');
    expect(card('Notes').textContent).not.toContain('Open site');
  });

  it('loads a site only once its card scrolls into view', async () => {
    publicProjects = [project({}), project({ id: 'project-2', name: 'Notes', fullName: 'ada/notes' })];
    await render(<Explore />);
    await vi.waitFor(() => card('ada/notes'));

    expect(document.querySelectorAll('iframe')).toHaveLength(0);
    const first = watched.find(({ element }) => card('ada/storefront').contains(element));
    await act(async () => first?.show());
    expect(card('ada/storefront').querySelector('iframe')?.getAttribute('src')).toBe('https://storefront.example.com');
    expect(card('ada/notes').querySelector('iframe')).toBeNull();
  });

  it('makes a copy from a card and opens it', async () => {
    publicProjects = [project({})];
    copyAnswer = () =>
      Response.json({ projectId: 'project-9', initialId: 'chat-9', fullName: 'me/storefront' }, { status: 201 });
    const opened = vi.fn();
    await render(<Explore onOpenProject={opened} />);
    await vi.waitFor(() => card('ada/storefront'));

    await click(card('ada/storefront'), 'Make a copy');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('input')?.value).toBe('Storefront');
    await click(dialog, 'Make a copy');
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('chat-9'));
    expect(copyRequests).toEqual([{ projectId: 'project-1', name: 'Storefront' }]);
  });
});

describe('Make a copy', () => {
  it('names the account the copy goes into, says it is working, and opens the copy', async () => {
    context = team;
    let answer: (response: Response) => void = () => undefined;
    copyAnswer = () => new Promise((resolve) => (answer = resolve));
    const opened = vi.fn();
    await render(
      <CopyProjectDialog project={{ id: 'project-1', name: 'Storefront' }} onOpenProject={opened} onClose={vi.fn()} />,
    );

    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog().textContent).toContain('Acme');
    const input = dialog().querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'My shop');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(dialog(), 'Make a copy');

    // Copying the whole history takes a while: the dialog says so, and stays open with nothing to press.
    expect(dialog().textContent).toContain('Making your copy…');
    expect(dialog().querySelector('button')).toBeNull();
    expect(copyRequests).toEqual([{ projectId: 'project-1', name: 'My shop' }]);

    await act(async () =>
      answer(Response.json({ projectId: 'project-9', initialId: 'chat-9', fullName: null }, { status: 201 })),
    );
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('chat-9'));
  });

  it('says why a copy could not be made, and lets the person try again', async () => {
    copyAnswer = () => Response.json({ error: 'This project is no longer public.' }, { status: 403 });
    const opened = vi.fn();
    await render(
      <CopyProjectDialog project={{ id: 'project-1', name: 'Storefront' }} onOpenProject={opened} onClose={vi.fn()} />,
    );

    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog().textContent).toContain('Personal');
    await click(dialog(), 'Make a copy');
    await vi.waitFor(() =>
      expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('This project is no longer public.'),
    );
    expect(opened).not.toHaveBeenCalled();
    expect([...dialog().querySelectorAll('button')].map((button) => button.textContent)).toContain('Make a copy');
  });
});
