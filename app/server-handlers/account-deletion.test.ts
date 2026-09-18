import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearAuthSessionCookie: vi.fn(() => 'cloudchef_session=; Path=/; HttpOnly; Max-Age=0'),
  getAuthSession: vi.fn(),
  eraseControlPlaneAccount: vi.fn(),
}));

vi.mock('~/lib/.server/auth', () => ({
  clearAuthSessionCookie: mocks.clearAuthSessionCookie,
  getAuthSession: mocks.getAuthSession,
}));
vi.mock('~/lib/.server/cloudflare/account-deletion', () => ({
  eraseControlPlaneAccount: mocks.eraseControlPlaneAccount,
}));

import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';
import { ACCOUNT_REAUTHENTICATION_WINDOW_MS } from '~/lib/.server/account-reauthentication';
import { deleteAccountAction } from './account-deletion';

const env = {} as Env;
const validBody = {
  confirmation: ACCOUNT_DELETION_CONFIRMATION,
  acknowledgeCloudflareResourcesRetained: true,
};

function deletionRequest(body: unknown, origin = 'https://cloudchef.build'): Request {
  return new Request('https://cloudchef.build/api/account/delete', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function freshSession(createdAt = Date.now()) {
  return {
    session: { id: 'session-1', userId: 'user-1', expiresAt: createdAt + 1_000, createdAt },
    user: { id: 'user-1' },
  };
}

describe('deleteAccountAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    mocks.getAuthSession.mockResolvedValue(freshSession());
    mocks.eraseControlPlaneAccount.mockResolvedValue({ cloudflareAuthorizationRevoked: true });
  });

  it('erases the control plane, expires the cookie, and reports the revocation outcome', async () => {
    const response = await deleteAccountAction({ request: deletionRequest(validBody), env });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'deleted', cloudflareAuthorizationRevoked: true });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.eraseControlPlaneAccount).toHaveBeenCalledWith({ env, userId: 'user-1' });
  });

  it('rejects a cross-origin request', async () => {
    const response = await deleteAccountAction({
      request: deletionRequest(validBody, 'https://attacker.example'),
      env,
    });

    expect(response.status).toBe(403);
    expect(mocks.eraseControlPlaneAccount).not.toHaveBeenCalled();
  });

  it('requires an authenticated session', async () => {
    mocks.getAuthSession.mockResolvedValue(null);

    const response = await deleteAccountAction({ request: deletionRequest(validBody), env });

    expect(response.status).toBe(401);
    expect(mocks.eraseControlPlaneAccount).not.toHaveBeenCalled();
  });

  it('requires a recent Cloudflare re-authentication', async () => {
    mocks.getAuthSession.mockResolvedValue(freshSession(Date.now() - ACCOUNT_REAUTHENTICATION_WINDOW_MS - 1));

    const response = await deleteAccountAction({ request: deletionRequest(validBody), env });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'reauthentication_required' });
    expect(mocks.eraseControlPlaneAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing acknowledgement', { confirmation: ACCOUNT_DELETION_CONFIRMATION }],
    ['an inexact phrase', { ...validBody, confirmation: 'delete my account' }],
    ['an unapproved extra field', { ...validBody, alsoDeleteMyWorkers: true }],
    ['no body fields at all', {}],
  ])('refuses to erase anything with %s', async (_case, body) => {
    const response = await deleteAccountAction({ request: deletionRequest(body), env });

    expect(response.status).toBe(400);
    expect(mocks.eraseControlPlaneAccount).not.toHaveBeenCalled();
  });

  it('reports an unrevoked grant so the user can remove it in Cloudflare', async () => {
    mocks.eraseControlPlaneAccount.mockResolvedValue({ cloudflareAuthorizationRevoked: false });

    const response = await deleteAccountAction({ request: deletionRequest(validBody), env });

    await expect(response.json()).resolves.toEqual({ status: 'deleted', cloudflareAuthorizationRevoked: false });
  });
});
