import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearAuthSessionCookie: vi.fn(),
  deleteAuthSession: vi.fn(),
  getAuthSession: vi.fn(),
}));

vi.mock('~/lib/.server/auth', () => mocks);

import { authSessionAction, signOutAction } from './auth';

function testEnv(): Env {
  // SAFETY: the session and sign-out handlers under test read no binding off `env`; every
  // collaborator they touch is mocked at the module boundary.
  return {} as Env;
}

describe('auth handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearAuthSessionCookie.mockReturnValue('cloudchef_session=; Path=/; HttpOnly; Max-Age=0');
    mocks.deleteAuthSession.mockResolvedValue(undefined);
    mocks.getAuthSession.mockResolvedValue(null);
  });

  it('returns session state without allowing it to be cached', async () => {
    const request = new Request('https://cloudchef.build/api/auth/session');
    const env = testEnv();
    const response = await authSessionAction({ request, env });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toBeNull();
    expect(mocks.getAuthSession).toHaveBeenCalledWith(env, request);
  });

  it('rejects sign-out requests from another origin', async () => {
    const response = await signOutAction({
      request: new Request('https://cloudchef.build/api/auth/sign-out', {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
      }),
      env: testEnv(),
    });

    expect(response.status).toBe(403);
    expect(mocks.deleteAuthSession).not.toHaveBeenCalled();
  });

  it('deletes the server session and expires the browser cookie', async () => {
    const request = new Request('https://cloudchef.build/api/auth/sign-out', {
      method: 'POST',
      headers: { Origin: 'https://cloudchef.build' },
    });
    const env = testEnv();
    const response = await signOutAction({ request, env });

    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.deleteAuthSession).toHaveBeenCalledWith(env, request);
    expect(mocks.clearAuthSessionCookie).toHaveBeenCalledWith(request);
  });
});
