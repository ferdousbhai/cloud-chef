// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProjectCommit } from '~/lib/cloudflare/data-api';
import { resetUserRuntimeSession } from '~/lib/cloudflare/runtime-session';
import { projectRevertStore } from '~/lib/stores/project-actions.client';
import { ProjectHistoryDialog } from './ProjectHistoryDialog.client';

const RUNTIME = 'https://runtime.example.workers.dev';
const FIRST = 'a'.repeat(40);
const SECOND = 'b'.repeat(40);
const commits: ProjectCommit[] = [
  {
    hash: FIRST,
    message: 'Add a booking form\n\nCloudChef-Revision: 1234',
    author: { name: 'Ada', email: 'ada@example.com' },
    committedAt: Math.floor(Date.now() / 1_000) - 3_600,
  },
  {
    hash: SECOND,
    message: 'First publish',
    author: { name: '', email: 'grace@example.com' },
    committedAt: Math.floor(Date.now() / 1_000) - 86_400,
  },
];

const dataRequestSchema = z.object({ path: z.string(), args: z.record(z.string(), z.unknown()) });
const dataRequests: z.infer<typeof dataRequestSchema>[] = [];
const archiveRequests: string[] = [];

/** The workspace runtime as the browser reaches it: a session, the data operations, and the archive route. */
async function runtime(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === '/api/cloudflare/runtime-session') {
    return Response.json({ endpoint: RUNTIME, token: 'runtime-token', expiresAt: Date.now() + 3_600_000 });
  }
  if (url === `${RUNTIME}/v1/data`) {
    const request = dataRequestSchema.parse(JSON.parse(String(init?.body)));
    dataRequests.push(request);
    if (request.path === 'projects.history') {
      return Response.json({ result: commits });
    }
    if (request.path === 'projects.fork') {
      return Response.json({ result: { initialId: 'chat-2' } });
    }
  }
  if (url.startsWith(`${RUNTIME}/v1/projects/archive?`)) {
    archiveRequests.push(url.slice(RUNTIME.length));
    return new Response(new Blob(['zip']), { headers: { 'Content-Type': 'application/zip' } });
  }
  return Response.json({ error: 'Not here.' }, { status: 404 });
}

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(runtime));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:archive' });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  resetUserRuntimeSession();
  dataRequests.length = 0;
  archiveRequests.length = 0;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  projectRevertStore.set(null);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function render(props: { canRevert: boolean; canFork: boolean; onOpenProject?: (initialId: string) => void }) {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root?.render(
      <ProjectHistoryDialog
        project={{ chatInitialId: 'chat-1' }}
        name="Booking site"
        onClose={() => undefined}
        onOpenProject={props.onOpenProject ?? (() => undefined)}
        canRevert={props.canRevert}
        canFork={props.canFork}
      />,
    ),
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain('Add a booking form'));
}

function labelled(name: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!found) {
    throw new Error(`No button labelled ${name}`);
  }
  return found;
}

describe('ProjectHistoryDialog', () => {
  it('lists each commit by its first line, author and short hash', async () => {
    await render({ canRevert: true, canFork: true });

    expect(dataRequests[0]).toEqual({
      path: 'projects.history',
      args: { chatInitialId: 'chat-1', limit: 30, offset: 0 },
    });
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('CloudChef-Revision');
    expect(text).toContain('Ada');
    expect(text).toContain('grace@example.com');
    expect(text).toContain('aaaaaaa');
  });

  it('reverts the open workspace only after confirming', async () => {
    const revert = vi.fn(async () => ({ changed: true }));
    projectRevertStore.set(revert);
    await render({ canRevert: true, canFork: false });

    await act(async () => labelled('Restore aaaaaaa').click());
    expect(revert).not.toHaveBeenCalled();
    // The confirmation's own button, in the dialog opened over the list.
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (candidate) => candidate.textContent?.trim() === 'Restore' && !candidate.hasAttribute('aria-label'),
    );
    await act(async () => confirm.at(-1)?.click());

    expect(revert).toHaveBeenCalledWith(FIRST);
    expect(document.querySelector('button[aria-label^="Make a copy"]')).toBeNull();
  });

  it('points to the project for reverting when it is not open here', async () => {
    await render({ canRevert: true, canFork: true });

    expect(document.querySelector('button[aria-label^="Restore"]')).toBeNull();
    expect(document.body.textContent).toContain('Open the project to go back to a version');
  });

  it('forks from a commit and opens the new project', async () => {
    const onOpenProject = vi.fn();
    await render({ canRevert: false, canFork: true, onOpenProject });

    await act(async () => labelled('Make a copy from bbbbbbb').click());

    await vi.waitFor(() => expect(onOpenProject).toHaveBeenCalledWith('chat-2'));
    expect(dataRequests.at(-1)).toEqual({ path: 'projects.fork', args: { chatInitialId: 'chat-1', commit: SECOND } });
  });

  it("downloads a commit's files from the archive route", async () => {
    await render({ canRevert: false, canFork: false });

    await act(async () => labelled('Download ZIP of aaaaaaa').click());

    await vi.waitFor(() => expect(archiveRequests).toEqual([`/v1/projects/archive?chat=chat-1&ref=${FIRST}`]));
  });
});
