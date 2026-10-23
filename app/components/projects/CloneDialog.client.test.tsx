// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCloneAccess } from '~/lib/cloudflare/data-api';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { CloneDialog } from './CloneDialog.client';

const RUNTIME = 'https://runtime.example.workers.dev';
const COMMAND =
  'git clone https://x:secret@example.artifacts.cloudflare.net/git/cloudchef/t-project-1.git booking-site';

let access: ProjectCloneAccess;
const bodies: string[] = [];

async function runtime(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (url === `${RUNTIME}/v1/data`) {
    bodies.push(String(init?.body));
    return Response.json({ result: access });
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

async function render() {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root?.render(<CloneDialog project={{ orgProjectId: 'project-1' }} name="Booking site" onClose={() => undefined} />),
  );
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('Making a clone command'));
}

describe('CloneDialog', () => {
  it('shows the command, copies it, and says until when it works', async () => {
    access = {
      remote: 'https://example.artifacts.cloudflare.net/git/cloudchef/t-project-1.git',
      token: 'secret',
      expiresAt: Date.now() + 3_600_000,
      command: COMMAND,
    };
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await render();

    expect(JSON.parse(bodies[0] ?? 'null')).toEqual({
      path: 'projects.cloneAccess',
      args: { orgProjectId: 'project-1' },
    });
    expect(document.querySelector('[aria-label="Clone command"]')?.textContent).toBe(COMMAND);
    expect(document.body.textContent).toMatch(/Anyone with this command can download the code until .+\./);

    const copy = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Copy');
    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith(COMMAND);
    expect(document.body.textContent).toContain('Copied');
  });

  it('offers a new command once the token has expired', async () => {
    access = {
      remote: 'https://example.artifacts.cloudflare.net/git/cloudchef/t-project-1.git',
      token: 'secret',
      expiresAt: Date.now() - 1_000,
      command: COMMAND,
    };
    await render();

    expect(document.body.textContent).toContain('This command has expired.');
    expect(document.querySelector('[aria-label="Clone command"]')).toBeNull();
  });
});
