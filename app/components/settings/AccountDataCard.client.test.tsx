// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const mocks = vi.hoisted(() => ({
  createCloudflareReturnURL: vi.fn(() => 'https://cloudchef.build/settings'),
  signInWithCloudflare: vi.fn(),
  disposeClientCollections: vi.fn(async () => undefined),
  resetUserRuntimeSession: vi.fn(),
  saveAs: vi.fn(),
}));

vi.mock('file-saver', () => ({ default: { saveAs: mocks.saveAs } }));

vi.mock('~/lib/auth-client', () => ({
  createCloudflareReturnURL: mocks.createCloudflareReturnURL,
  signInWithCloudflare: mocks.signInWithCloudflare,
}));
vi.mock('~/lib/cloudflare/client-collections', () => ({
  disposeClientCollections: mocks.disposeClientCollections,
}));
vi.mock('~/lib/cloudflare/runtime-session', () => ({ resetUserRuntimeSession: mocks.resetUserRuntimeSession }));

import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';
import { AccountDataCard } from './AccountDataCard.client';

let root: Root | undefined;
const fetchMock = vi.fn();

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<AccountDataCard />));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  if (!found) {
    throw new Error(`No button labelled ${label}`);
  }
  return found;
}

// jsdom's Blob has no text(), so the saved bytes are read back the way a browser would.
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function openDeletionPanel() {
  await act(async () => button('Delete account data').click());
}

async function fillConfirmation() {
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const phrase = document.querySelector<HTMLInputElement>('input[aria-label="Deletion confirmation phrase"]')!;
  await act(async () => {
    checkbox.click();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      phrase,
      ACCOUNT_DELETION_CONFIRMATION,
    );
    phrase.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AccountDataCard', () => {
  it('saves the export exactly as the server sent it', async () => {
    const exported = JSON.stringify({ schemaVersion: 1, status: 'complete', unavailableSections: [] });
    fetchMock.mockResolvedValue(new Response(exported, { status: 200 }));
    await render();

    await act(async () => button('Download account data').click());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/export',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    const [blob, filename] = mocks.saveAs.mock.calls[0] as [Blob, string];
    expect(filename).toBe('cloudchef-account-export.json');
    expect(blob.type).toBe('application/json');
    await expect(readBlob(blob)).resolves.toBe(exported);
    expect(document.body.textContent).toContain('Saved cloudchef-account-export.json');
  });

  it('warns that a partial export is not a complete copy and names the section that failed', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'incomplete', unavailableSections: ['authSessions'] }), { status: 200 }),
    );
    await render();

    await act(async () => button('Download account data').click());

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('authSessions');
    expect(alert?.textContent).toContain('not a complete copy');
    // The partial file is still saved, because it is still the user's data.
    expect(mocks.saveAs).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('Saved cloudchef-account-export.json.');
  });

  it('offers a Cloudflare reconnect before exporting when the session is not freshly re-authenticated', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'reauthentication_required', error: 'Reconnect Cloudflare.' }), {
        status: 401,
      }),
    );
    await render();

    await act(async () => button('Download account data').click());
    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Confirm it is you in Cloudflare, then download again');

    await act(async () => button('Reconnect Cloudflare').click());
    expect(mocks.signInWithCloudflare).toHaveBeenCalledOnce();
  });

  it('shows export reconnect failures beside the export action', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'reauthentication_required' }), { status: 401 }));
    mocks.signInWithCloudflare.mockRejectedValueOnce(new Error('Connection unavailable.'));
    await render();
    await act(async () => button('Download account data').click());
    await act(async () => button('Reconnect Cloudflare').click());
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('Connection unavailable.');
    expect(
      alert.compareDocumentPosition(button('Delete account data')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('reports an unreachable server instead of saving an empty file', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await render();

    await act(async () => button('Download account data').click());

    expect(mocks.saveAs).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Unable to reach CloudChef');
  });

  it('requires the exact phrase and the retained-resources acknowledgement before deleting', async () => {
    await render();

    await openDeletionPanel();
    expect(button('Permanently delete').disabled).toBe(true);

    await fillConfirmation();
    expect(button('Permanently delete').disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('erases the control plane, clears local caches, and reports an unrevoked grant', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'deleted', cloudflareAuthorizationRevoked: false }), { status: 200 }),
    );
    await render();
    await openDeletionPanel();
    await fillConfirmation();

    await act(async () => button('Permanently delete').click());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/delete',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      acknowledgeCloudflareResourcesRetained: true,
    });
    expect(mocks.disposeClientCollections).toHaveBeenCalledOnce();
    expect(mocks.resetUserRuntimeSession).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Cloudflare did not confirm the revocation');
    expect(document.body.textContent).toContain('still in your Cloudflare account');
  });

  it('offers a Cloudflare reconnect when the session is not freshly re-authenticated', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'reauthentication_required', error: 'Reconnect Cloudflare.' }), {
        status: 401,
      }),
    );
    await render();
    await openDeletionPanel();
    await fillConfirmation();

    await act(async () => button('Permanently delete').click());
    expect(document.body.textContent).toContain('Confirm it is you in Cloudflare');

    await act(async () => button('Reconnect Cloudflare').click());
    expect(mocks.signInWithCloudflare).toHaveBeenCalledOnce();
  });
});
