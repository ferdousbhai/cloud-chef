import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  exportControlPlaneAccount: vi.fn(),
}));

vi.mock('~/lib/.server/auth', () => ({ getAuthSession: mocks.getAuthSession }));
vi.mock('~/lib/.server/cloudflare/account-export', () => ({
  exportControlPlaneAccount: mocks.exportControlPlaneAccount,
}));

import { ACCOUNT_REAUTHENTICATION_WINDOW_MS } from '~/lib/.server/account-reauthentication';
import { exportAccountAction } from './account-export';

const env = {} as Env;

const completeExport = {
  schemaVersion: 1,
  exportedAt: '2026-08-18T00:00:00.000Z',
  status: 'complete',
  unavailableSections: [],
  rowLimitPerSection: 200,
  covers: 'Every record the CloudChef control plane stores for this account, and nothing else.',
  omits: ['Chats, transcripts, project files, and deployment records.'],
  sections: { account: { status: 'exported', account: { id: 'user-1' } } },
};

function exportRequest(origin = 'https://cloudchef.build'): Request {
  return new Request('https://cloudchef.build/api/account/export', { method: 'POST', headers: { origin } });
}

function freshSession(createdAt = Date.now()) {
  return {
    session: { id: 'session-1', userId: 'user-1', expiresAt: createdAt + 1_000, createdAt },
    user: { id: 'user-1' },
  };
}

describe('exportAccountAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    mocks.getAuthSession.mockResolvedValue(freshSession());
    mocks.exportControlPlaneAccount.mockResolvedValue(completeExport);
  });

  it('returns the operator-held records for the authenticated account and never caches them', async () => {
    const response = await exportAccountAction({ request: exportRequest(), env });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(completeExport);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.exportControlPlaneAccount).toHaveBeenCalledWith({ env, userId: 'user-1' });
  });

  it('rejects a cross-origin request', async () => {
    const response = await exportAccountAction({ request: exportRequest('https://attacker.example'), env });

    expect(response.status).toBe(403);
    expect(mocks.exportControlPlaneAccount).not.toHaveBeenCalled();
  });

  it('requires an authenticated session', async () => {
    mocks.getAuthSession.mockResolvedValue(null);

    const response = await exportAccountAction({ request: exportRequest(), env });

    expect(response.status).toBe(401);
    expect(mocks.exportControlPlaneAccount).not.toHaveBeenCalled();
  });

  it('requires a recent Cloudflare re-authentication before disclosing the account in bulk', async () => {
    mocks.getAuthSession.mockResolvedValue(freshSession(Date.now() - ACCOUNT_REAUTHENTICATION_WINDOW_MS - 1));

    const response = await exportAccountAction({ request: exportRequest(), env });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'reauthentication_required' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.exportControlPlaneAccount).not.toHaveBeenCalled();
  });

  it('returns a partial export that says which section failed rather than one that looks whole', async () => {
    mocks.exportControlPlaneAccount.mockResolvedValue({
      ...completeExport,
      status: 'incomplete',
      unavailableSections: ['authSessions'],
      sections: {
        ...completeExport.sections,
        authSessions: { status: 'unavailable', error: 'CloudChef could not read this section.' },
      },
    });

    const response = await exportAccountAction({ request: exportRequest(), env });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'incomplete',
      unavailableSections: ['authSessions'],
    });
  });

  it('records the export without writing the exported records to the log', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await exportAccountAction({ request: exportRequest(), env });

    expect(info).toHaveBeenCalledWith({
      event: 'control_plane_account_exported',
      exportedAt: completeExport.exportedAt,
      status: 'complete',
      unavailableSections: [],
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('user-1');
  });
});
