// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFilesStatus } from '~/lib/stores/workbench.client';
import { WorkspaceFilesNotice } from './WorkspaceFilesNotice';

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

async function show(status: WorkspaceFilesStatus, hasFiles = false) {
  await act(async () => root?.render(<WorkspaceFilesNotice status={status} hasFiles={hasFiles} />));
}

describe('the code view without files', () => {
  it("says why a project's files could not be put in the workspace, and retries on request", async () => {
    const retry = vi.fn();
    await show({ state: 'failed', failure: 'Connect GitHub again in Settings to import this project.', retry });

    expect(container.querySelector('h2')?.textContent).toBe('CloudChef could not open this project.');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Connect GitHub again in Settings to import this project.',
    );
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Try again');
    await act(async () => button?.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('says when the editor could not load files the workspace has', async () => {
    await show({ state: 'presentation-error', failure: null, retry: vi.fn() });

    expect(container.querySelector('h2')?.textContent).toBe("The editor could not load this project's files.");
    expect(container.textContent).toContain('Chat, builds, and previews still work.');
    expect(container.querySelector('button')?.textContent).toBe('Try again');
  });

  it('says when the workspace could not be reached', async () => {
    await show({ state: 'unavailable', failure: null, retry: vi.fn() });

    expect(container.querySelector('h2')?.textContent).toBe('CloudChef could not reach your workspace.');
    expect(container.querySelector('button')?.textContent).toBe('Reconnect');
  });

  it('says the files are on their way while they load', async () => {
    await show({ state: 'connecting', failure: null, retry: null });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading project files…');

    await show({ state: 'reconnecting', failure: null, retry: vi.fn() });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Reconnecting to your workspace…');
  });

  it('says nothing over files it can show, or once the workspace is ready', async () => {
    await show({ state: 'presentation-error', failure: null, retry: vi.fn() }, true);
    expect(container.textContent).toBe('');

    await show({ state: 'ready', failure: null, retry: vi.fn() });
    expect(container.textContent).toBe('');
  });
});
