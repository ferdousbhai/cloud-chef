// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectImportResult } from '~/lib/cloudflare/data-api';
import type { GitHubRepository } from '~/lib/github-app.client';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { ImportFromGitHubDialog } from './ImportFromGitHubDialog.client';

const RUNTIME = 'https://runtime.example.workers.dev';

let installed: GitHubRepository[] | null;
let imported: ProjectImportResult;
const requests: { url: string; body: string | null }[] = [];

/** CloudChef's routes and the workspace runtime, as the dialog reaches them. */
async function server(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  requests.push({ url, body: init?.body ? String(init.body) : null });
  if (url.startsWith('/api/organizations/github/repositories')) {
    return installed
      ? Response.json({ repositories: installed })
      : Response.json({ error: 'Connect GitHub first.' }, { status: 409 });
  }
  if (url === '/api/organizations/github/start') {
    // A fragment, which the test document can follow without leaving the page.
    return Response.json({ installUrl: '#github-install' });
  }
  if (url === '/api/projects/project-1/workers-builds/switch') {
    return Response.json({
      instruction: 'Connect the repository in the dashboard.',
      url: 'https://dash.cloudflare.com/',
    });
  }
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (url === `${RUNTIME}/v1/data`) {
    return Response.json({ result: imported });
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(server));
  resetUserRuntimeSession();
  requests.length = 0;
  installed = null;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render(orgId: string | null, onOpenProject: (initialId: string) => void = () => undefined) {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root?.render(<ImportFromGitHubDialog orgId={orgId} onOpenProject={onOpenProject} onClose={() => undefined} />),
  );
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Checking which repositories'));
}

async function typeAddress(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[inputmode="url"]');
  await act(async () => {
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

async function submit() {
  await act(async () => document.querySelector('form')?.requestSubmit());
}

function buttonWithText(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text),
  );
}

function dataRequestBodies() {
  return requests.filter(({ url }) => url === `${RUNTIME}/v1/data`).map(({ body }) => JSON.parse(body ?? 'null'));
}

describe('ImportFromGitHubDialog', () => {
  it('imports a pasted repository address and opens the project', async () => {
    imported = { projectId: 'chat-9', initialId: 'chat-9' };
    const onOpenProject = vi.fn();
    await render(null, onOpenProject);

    await typeAddress('https://github.com/acme/storefront.git');
    await submit();

    await vi.waitFor(() => expect(onOpenProject).toHaveBeenCalledWith('chat-9'));
    expect(dataRequestBodies()).toEqual([
      { path: 'projects.import', args: { url: 'https://github.com/acme/storefront' } },
    ]);
  });

  it('offers to install the GitHub App for private repositories', async () => {
    await render('org-1');

    await act(async () => buttonWithText('Install the CloudChef GitHub App')?.click());

    expect(requests[0]?.url).toBe('/api/organizations/github/repositories?orgId=org-1');
    const start = requests.find(({ url }) => url === '/api/organizations/github/start');
    expect(JSON.parse(start?.body ?? 'null')).toMatchObject({ orgId: 'org-1' });
    expect(JSON.parse(start?.body ?? 'null').callbackURL).toContain('import=github');
  });

  it('lists the repositories the installed App can read', async () => {
    installed = [{ id: 1, fullName: 'acme/private-site', defaultBranch: 'main', private: true }];
    await render(null);

    expect(requests[0]?.url).toBe('/api/organizations/github/repositories');
    expect([...document.querySelectorAll('option')].map((option) => option.textContent)).toContain(
      'acme/private-site (private)',
    );
  });

  it('switches Workers Builds to the project repository when it built from GitHub', async () => {
    imported = { projectId: 'project-1', initialId: 'chat-1', workersBuildsFromGitHub: true };
    const onOpenProject = vi.fn();
    await render(null, onOpenProject);

    await typeAddress('github.com/acme/storefront');
    await submit();
    await vi.waitFor(() => expect(buttonWithText('Go live from CloudChef')).toBeDefined());
    expect(onOpenProject).not.toHaveBeenCalled();

    await act(async () => buttonWithText('Go live from CloudChef')?.click());

    await vi.waitFor(() => expect(document.body.textContent).toContain('Connect the repository in the dashboard.'));
    expect(document.querySelector('a[href="https://dash.cloudflare.com/"]')).not.toBeNull();

    await act(async () => buttonWithText('Open project')?.click());
    expect(onOpenProject).toHaveBeenCalledWith('chat-1');
  });
});
