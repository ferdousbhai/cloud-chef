// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { CloneDialog } from './CloneDialog.client';

const RUNTIME = 'https://runtime.example.workers.dev';
const TEAM_PROJECT = '11111111-1111-4111-8111-111111111111';
const bodies: string[] = [];

async function runtime(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (url === `${RUNTIME}/v1/data`) {
    bodies.push(String(init?.body));
    return Response.json({ result: { projectId: TEAM_PROJECT } });
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(runtime));
  resetUserRuntimeSession();
  bodies.length = 0;
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
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root?.render(element));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Finding its address'));
}

const command = (label: string) => document.querySelector(`[aria-label="${label}"]`)?.textContent;

describe('CloneDialog', () => {
  it('clones a project by its name through CloudChef, with no token in the command, and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await render(
      <CloneDialog
        project={{ orgProjectId: TEAM_PROJECT }}
        name="Booking site"
        fullName="sara/booking-site"
        onClose={() => undefined}
      />,
    );

    // A team project's own id needs no asking.
    expect(bodies).toEqual([]);
    expect(command('cloudchef command')).toBe('cloudchef repo clone sara/booking-site');
    expect(command('git command')).toBe(`git clone ${window.location.origin}/sara/booking-site.git`);
    expect(document.body.textContent).not.toContain('artifacts');

    const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy the cloudchef command"]');
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith('cloudchef repo clone sara/booking-site');
    expect(document.body.textContent).toContain('Copied');
  });

  it('asks which project a chat works on, and clones it by its id when it has no name', async () => {
    await render(<CloneDialog project={{ chatInitialId: 'chat-1' }} name="Booking site" onClose={() => undefined} />);

    expect(JSON.parse(bodies[0] ?? 'null')).toEqual({ path: 'projects.gitAddress', args: { chatInitialId: 'chat-1' } });
    expect(command('cloudchef command')).toBe(`cloudchef repo clone ${TEAM_PROJECT}`);
    expect(command('git command')).toBe(`git clone ${window.location.origin}/git/${TEAM_PROJECT}.git`);
  });
});
