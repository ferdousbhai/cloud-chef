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
  resetUserRuntimeSession: vi.fn(),
  saveAs: vi.fn(),
}));

vi.mock('file-saver', () => ({ default: { saveAs: mocks.saveAs } }));

vi.mock('~/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({
      data: {
        user: { id: 'user-1', email: 'user@example.com' },
        contexts: [{ kind: 'personal', connectionId: 'connection-1', accountName: null }],
      },
      isPending: false,
    }),
  },
  createCloudflareReturnURL: mocks.createCloudflareReturnURL,
  requestEmailSignInLink: vi.fn(),
  signInWithCloudflare: mocks.signInWithCloudflare,
  signInWithGoogle: vi.fn(),
}));
vi.mock('~/lib/cloudflare/runtime-session', () => ({ resetUserRuntimeSession: mocks.resetUserRuntimeSession }));

import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { AccountDataCard } from './AccountDataCard.client';

let root: Root | undefined;
const fetchMock = vi.fn();
const clearQueries = vi.spyOn(queryClient, 'clear');

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
    // Named as Settings names it, not by the export's key.
    expect(alert?.textContent).toContain('could not read your sign-in sessions,');
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
    expect(document.body.textContent).toContain('Sign in again to confirm it is you, then download again');

    await act(async () => button('Reconnect Cloudflare').click());
    expect(mocks.signInWithCloudflare).toHaveBeenCalledOnce();
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
      new Response(
        JSON.stringify({ status: 'deleted', cloudflareAuthorizationRevoked: false, workspacesLeftIn: ['Acme'] }),
        { status: 200 },
      ),
    );
    await render();
    await openDeletionPanel();
    await fillConfirmation();

    await act(async () => button('Permanently delete').click());
    expect(document.body.textContent).toContain(
      "Your workspace couldn't be deleted from the Cloudflare account of Acme",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/delete',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      acknowledgeCloudflareResourcesRetained: true,
    });
    expect(clearQueries).toHaveBeenCalledOnce();
    expect(mocks.resetUserRuntimeSession).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Cloudflare did not confirm that CloudChef’s access was removed');
    expect(document.body.textContent).toContain('still in the Cloudflare accounts they were deployed to');
  });

  /** What the server answers an erasure with. */
  type DeletionAnswer = {
    cloudflareAuthorizationRevoked: boolean | null;
    cloudflareAuthorizationsKept?: { teams: string[]; someoneElsesOwnSpace: boolean }[];
    workspacesLeftIn: string[];
  };

  async function deleteAnswering(answer: DeletionAnswer) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'deleted', ...answer }), { status: 200 }));
    await render();
    await openDeletionPanel();
    await fillConfirmation();
    await act(async () => button('Permanently delete').click());
    return document.body.textContent ?? '';
  }

  it('says the Cloudflare access was kept for a team still building in the account, not that it was removed', async () => {
    const text = await deleteAnswering({
      cloudflareAuthorizationRevoked: null,
      cloudflareAuthorizationsKept: [{ teams: ["Sara's sites"], someoneElsesOwnSpace: false }],
      workspacesLeftIn: [],
    });

    expect(text).toContain("because the team Sara's sites still builds there with it");
    expect(text).not.toContain('encrypted credentials');
    expect(text).not.toContain('Cloudflare did not confirm');
    expect(text).not.toContain('Cloudflare confirmed');
  });

  it("says the access was kept for someone else's own space without saying whose, and asks nothing of the person", async () => {
    const text = await deleteAnswering({
      cloudflareAuthorizationRevoked: null,
      cloudflareAuthorizationsKept: [{ teams: [], someoneElsesOwnSpace: true }],
      workspacesLeftIn: [],
    });

    expect(text).toContain("because someone else's own space still builds there with it");
    expect(text).not.toContain('encrypted credentials');
    expect(text).not.toContain('Cloudflare did not confirm');
    expect(text).not.toContain('Remove it yourself');
  });

  it('says both when access was kept in one account and removing it from another went unconfirmed', async () => {
    const text = await deleteAnswering({
      cloudflareAuthorizationRevoked: false,
      cloudflareAuthorizationsKept: [{ teams: ['Acme', "Sara's sites"], someoneElsesOwnSpace: true }],
      workspacesLeftIn: [],
    });

    expect(text).toContain(
      "because the team Acme, the team Sara's sites and someone else's own space still build there with it",
    );
    expect(text).toContain('Cloudflare did not confirm that CloudChef’s access was removed');
  });

  it('says Cloudflare confirmed the access was removed when it did', async () => {
    const text = await deleteAnswering({ cloudflareAuthorizationRevoked: true, workspacesLeftIn: [] });

    expect(text).toContain('encrypted credentials');
    expect(text).toContain('Cloudflare confirmed that CloudChef’s access was removed');
  });

  it('offers a Cloudflare reconnect when the session is not freshly re-authenticated', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: 'reauthentication_required', error: 'Reconnect Cloudflare.' }), {
          status: 401,
        }),
    );
    await render();
    await openDeletionPanel();
    await fillConfirmation();

    await act(async () => button('Permanently delete').click());
    expect(document.body.textContent).toContain('Sign in again to confirm it is you');
    // Signed in again in another tab, the person deletes from here without starting over.
    await act(async () => button('Permanently delete').click());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => button('Reconnect Cloudflare').click());
    expect(mocks.signInWithCloudflare).toHaveBeenCalledOnce();
  });
});
