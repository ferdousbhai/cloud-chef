// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import { refreshSession } from '~/lib/auth-client';
import { UserRuntimeSessionError } from '~/lib/cloudflare/runtime-session';
import { RequestError } from '~/lib/json-request';
import { ProjectLoadError } from './ExistingChat.client';
import {
  ASK_ADMIN_TO_REAUTHORIZE_MESSAGE,
  CloudflareReauthorizePrompt,
  needsCloudflareReauthorization,
  REAUTHORIZE_CLOUDFLARE_MESSAGE,
} from './CloudflareReauthorizePrompt';

const personal: WorkspaceContext = { kind: 'personal', connectionId: 'connection-1', accountName: null };
const teamMember: WorkspaceContext = {
  kind: 'organization',
  connectionId: 'connection-2',
  accountName: null,
  orgId: 'org-1',
  orgName: 'Acme',
  role: 'member',
  draftsAllowed: true,
};
const teamAdmin: WorkspaceContext = { ...teamMember, role: 'admin' };

const startSchema = z.object({ callbackURL: z.string(), organizationId: z.string().optional() });

let context: WorkspaceContext = personal;
const starts: z.infer<typeof startSchema>[] = [];
const assign = vi.fn();
let root: Root | undefined;

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
  if (url === '/api/cloudflare/connection/start' && init?.method === 'POST') {
    starts.push(startSchema.parse(JSON.parse(String(init.body))));
    return Response.json({ authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?client_id=cloudchef' });
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(server));
  window.history.replaceState(null, '', '/chat/chat-1');
  vi.stubGlobal('location', { ...window.location, assign, href: window.location.href, origin: window.location.origin });
  starts.length = 0;
  assign.mockClear();
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

function buttons(): string[] {
  return Array.from(document.querySelectorAll('button'), (button) => button.textContent?.trim() ?? '');
}

async function click(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`No ${label} button`);
  }
  await act(async () => button.click());
}

describe('the Cloudflare reauthorization prompt', () => {
  it('knows the refusal however it arrives', () => {
    expect(
      needsCloudflareReauthorization(new UserRuntimeSessionError('m', 'cloudflare_reauthorization_required')),
    ).toBe(true);
    expect(needsCloudflareReauthorization(new RequestError('m', 409, 'cloudflare_reauthorization_required'))).toBe(
      true,
    );
    expect(needsCloudflareReauthorization(new UserRuntimeSessionError('m', 'workspace_plan_required'))).toBe(false);
    expect(needsCloudflareReauthorization(new Error('cloudflare_reauthorization_required'))).toBe(false);
  });

  it("reauthorizes the person's own Cloudflare account with its one button, back to the same page", async () => {
    context = personal;
    await render(<CloudflareReauthorizePrompt />);

    expect(document.body.textContent).toBe(`${REAUTHORIZE_CLOUDFLARE_MESSAGE}Reauthorize Cloudflare`);
    expect(buttons()).toEqual(['Reauthorize Cloudflare']);
    await click('Reauthorize Cloudflare');

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(expect.stringContaining('dash.cloudflare.com')));
    expect(starts).toEqual([{ callbackURL: `${window.location.origin}/chat/chat-1` }]);
  });

  it("reauthorizes the team's Cloudflare account for a team admin", async () => {
    context = teamAdmin;
    await render(<CloudflareReauthorizePrompt />);
    await click('Reauthorize Cloudflare');

    await vi.waitFor(() => expect(starts).toEqual([{ callbackURL: expect.any(String), organizationId: 'org-1' }]));
  });

  it("tells a team member who isn't an admin who can approve them, with no button", async () => {
    context = teamMember;
    await render(<CloudflareReauthorizePrompt />);

    expect(document.body.textContent).toBe(ASK_ADMIN_TO_REAUTHORIZE_MESSAGE);
    expect(buttons()).toEqual([]);
  });

  it('is what opening a project shows when the workspace needs it, without the raw refusal', async () => {
    context = personal;
    await render(
      <ProjectLoadError
        error={
          new UserRuntimeSessionError(
            'CloudChef needs updated Cloudflare permissions for this workspace.',
            'cloudflare_reauthorization_required',
          )
        }
        onRetry={vi.fn()}
      />,
    );

    expect(document.body.textContent).toBe(`${REAUTHORIZE_CLOUDFLARE_MESSAGE}Reauthorize Cloudflare`);
    await click('Reauthorize Cloudflare');
    await vi.waitFor(() => expect(starts).toHaveLength(1));
  });
});
