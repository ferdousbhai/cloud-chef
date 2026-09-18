import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudflareConnectionResult,
  CloudflareOrchestrator,
} from '~/lib/.server/cloudflare/cloudflare-orchestrator';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_SANDBOX_BASE_IMAGE } from '~/workflows/user-workspace-runtime-provisioning';

/** Shaped like a real Cloudflare account id; a registry namespace is derived from it. */
const ACCOUNT_ID = '0af9e0921b880657d84a6c07307f8aef';

const mocks = vi.hoisted(() => ({
  CloudflareConnectionChangedError: class CloudflareConnectionChangedError extends Error {},
  getAuthSession: vi.fn(),
  prepareAuthSession: vi.fn(),
  createAuthSession: vi.fn(),
  upsertCloudflareUser: vi.fn(),
  findConnection: vi.fn(),
  requireActiveConnection: vi.fn(),
  activateConnection: vi.fn(),
  vault: {
    storeOAuthCredential: vi.fn(),
    store: vi.fn(),
    deleteIfUnreferenced: vi.fn(),
  },
}));

vi.mock('~/lib/.server/auth', () => ({
  getAuthSession: mocks.getAuthSession,
  prepareAuthSession: mocks.prepareAuthSession,
  createAuthSession: mocks.createAuthSession,
  upsertCloudflareUser: mocks.upsertCloudflareUser,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-connection-repository', () => ({
  findCloudflareConnectionForUser: mocks.findConnection,
  requireActiveCloudflareConnection: mocks.requireActiveConnection,
  activateCloudflareConnection: mocks.activateConnection,
  CloudflareConnectionChangedError: mocks.CloudflareConnectionChangedError,
}));
vi.mock('~/lib/.server/cloudflare/cloudflare-credential-vault', () => ({
  D1CloudflareCredentialVault: class {
    static fromEnv() {
      return mocks.vault;
    }
  },
}));
import {
  cloudflareConnectionStatusAction,
  cloudflareRuntimeSessionAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
} from './cloudflare-integration';

describe('Cloudflare-only authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareAuthSession.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'f'.repeat(64),
      expiresAt: 2_592_000_100,
      createdAt: 100,
      cookie: 'cloudchef_session=opaque; HttpOnly; Secure',
    });
    mocks.createAuthSession.mockImplementation(async (_env, session) => session.cookie);
    mocks.upsertCloudflareUser.mockResolvedValue({
      id: 'user-1',
      name: 'Person',
      email: 'person@example.com',
      image: null,
    });
    mocks.findConnection.mockResolvedValue(null);
    mocks.requireActiveConnection.mockResolvedValue(activeConnection());
    mocks.vault.storeOAuthCredential.mockResolvedValue('credential-1');
    mocks.vault.deleteIfUnreferenced.mockResolvedValue(true);
    mocks.activateConnection.mockResolvedValue({
      id: 'connection-1',
      userId: 'user-1',
      accountId: ACCOUNT_ID,
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-1',
      grantedCapabilities: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
      requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      oauthScopeProfileVersion: 'core-v1',
      oauthScopeGrantStatus: 'core' as const,
      aiBillingEnabled: true,
      connectedAt: 100,
      updatedAt: 100,
      generation: 1,
    });
  });

  it('requires Cloudflare authentication for connection status', async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection'),
      env: { DB: {} } as Env,
    });
    expect(response.status).toBe(401);
  });

  it('rejects runtime preparation without a same-origin browser request', async () => {
    const response = await cloudflareRuntimeSessionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/runtime-session', { method: 'POST' }),
      env: { DB: {} } as Env,
    });

    expect(response.status).toBe(403);
    expect(mocks.getAuthSession).not.toHaveBeenCalled();
  });

  it('returns only connection metadata needed by settings and the isolated-staging guard', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(activeConnection());

    const response = await cloudflareConnectionStatusAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection'),
      env: { DB: {} } as Env,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: ACCOUNT_ID,
      accountName: 'User Cloudflare',
      oauthScopeGrantStatus: 'core',
    });
  });

  it.each([
    ['absent', null],
    ['stale connection', runtimeRow({ connectionGeneration: 0 })],
    ['stale version', runtimeRow({ runtimeVersion: '0'.repeat(64) })],
    // A row pinned to a different image than the current one, or one that never recorded an image,
    // must re-provision so a base-image bump reaches workspaces that were provisioned before it.
    ['on a superseded image', runtimeRow({ imageDigest: `docker.io/cloudflare/sandbox:x@sha256:${'a'.repeat(64)}` })],
    ['provisioned before the image was recorded', runtimeRow({ imageDigest: null })],
  ])('starts background provisioning for an %s runtime', async (_case, initialRuntime) => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(activeConnection());
    const provision = vi.fn().mockResolvedValue({ status: 'preparing' });
    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([initialRuntime]),
      provision,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'workspace_preparing' });
    expect(provision).toHaveBeenCalledWith({
      env: expect.anything(),
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 1,
      retry: false,
    });
  });

  it('surfaces a durable asynchronous provisioning failure without exposing its private detail', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(activeConnection());
    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([null]),
      provision: vi.fn().mockResolvedValue({
        status: 'error',
        errorCode: 'workspace_plan_required',
        errorMessage: 'private provider detail',
        upgradeUrl: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
      }),
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      code: 'workspace_plan_required',
      error:
        'Cloudflare Containers requires the Workers Paid plan. Enable Workers Paid in Cloudflare, then return here and try again. CloudChef does not change your plan automatically.',
      upgradeUrl: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
    });
    expect(JSON.stringify(body)).not.toContain('private provider detail');
  });

  it('mints an opaque correlation ID and logs it beside the grant it issued', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(activeConnection());

    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([runtimeRow(), runtimeRow()]),
      provision: vi.fn(),
      readAiGatewayCreditStatus: vi.fn().mockResolvedValue('available'),
    });

    const { correlationId } = (await response.json()) as { correlationId?: string };
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'runtime_session_issued', correlationId }));
    // The join key must never be accompanied by the account it was issued for.
    expect(JSON.stringify(info.mock.calls)).not.toContain('user-1');
  });

  it('falls back to an unknown credit status when the optional check fails', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(activeConnection());
    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([runtimeRow(), runtimeRow()]),
      provision: vi.fn(),
      readAiGatewayCreditStatus: vi.fn().mockRejectedValue(new Error('provider detail')),
    });

    await expect(response.json()).resolves.toMatchObject({ aiGatewayCreditStatus: 'unknown' });
  });

  it('does not block runtime access when the credit check stalls', async () => {
    vi.useFakeTimers();
    try {
      mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
      mocks.findConnection.mockResolvedValue(activeConnection());
      const pendingResponse = cloudflareRuntimeSessionAction({
        request: runtimeSessionRequest(),
        env: runtimeEnv([runtimeRow(), runtimeRow()]),
        provision: vi.fn(),
        readAiGatewayCreditStatus: vi.fn(() => new Promise<'available'>(() => undefined)),
      });

      await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(5_000);

      const response = await pendingResponse;
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ aiGatewayCreditStatus: 'unknown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses a current runtime without provisioning', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(activeConnection());
    const provision = vi.fn();
    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([runtimeRow(), runtimeRow()]),
      provision,
    });

    expect(response.status).toBe(200);
    expect(provision).not.toHaveBeenCalled();
  });

  it('returns no capability when automatic provisioning fails', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(activeConnection());
    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([null]),
      provision: vi.fn().mockRejectedValue(new Error('Cloudflare rejected the runtime deployment.')),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      code: 'workspace_preparation_failed',
      error:
        'Cloudflare could not create your workspace. Check the Workers settings for this Cloudflare account, then try again.',
    });
  });

  it('requires reauthorization when the connection is missing a current workspace capability', async () => {
    mocks.getAuthSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findConnection.mockResolvedValue(
      activeConnection(1, ['workers', 'containers', 'd1', 'r2', 'durable_objects', 'workers_ai']),
    );
    const provision = vi.fn();
    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([runtimeRow()]),
      provision,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: 'cloudflare_reauthorization_required',
      error:
        'CloudChef needs updated Cloudflare permissions for this workspace. Reauthorize Cloudflare, approve the requested permissions, then try again.',
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it('starts OAuth before any local session exists and keeps only a same-origin return path', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://cloudchef.build',
          'CF-Connecting-IP': '192.0.2.10',
        },
        body: JSON.stringify({ callbackURL: 'https://cloudchef.build/create/example?tab=code' }),
      }),
      env: database.env,
      orchestrator,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain('cloudchef_oauth_state=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(database.limit).toHaveBeenCalledWith({ key: '192.0.2.10' });
    expect(database.state?.returnTo).toBe('/create/example?tab=code');
    expect(orchestrator.startConnection).toHaveBeenCalledWith({
      returnUrl: expect.stringContaining('/connect/return?state='),
    });
  });

  it('rejects cross-origin OAuth initiation', async () => {
    const orchestrator = fakeOrchestrator();
    const database = oauthDatabase();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(403);
    expect(database.limit).not.toHaveBeenCalled();
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
  });

  it('rate limits OAuth initiation before parsing the body or starting provider work', async () => {
    const database = oauthDatabase({ rateLimitSuccess: false });
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://cloudchef.build',
          'CF-Connecting-IP': '192.0.2.11',
        },
        body: '{not-valid-json',
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(database.limit).toHaveBeenCalledWith({ key: '192.0.2.11' });
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
    expect(database.state).toBeNull();
  });

  it('rejects an oversized OAuth initiation before parsing or provider work', async () => {
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: JSON.stringify({ callbackURL: `https://cloudchef.build/${'a'.repeat(5_000)}` }),
      }),
      env: oauthDatabase().env,
      orchestrator,
    });

    expect(response.status).toBe(413);
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
  });

  it('classifies an invalid OAuth initiation payload as a client request error', async () => {
    const orchestrator = fakeOrchestrator();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: JSON.stringify({ callbackURL: 'not-a-url' }),
      }),
      env: oauthDatabase().env,
      orchestrator,
    });

    expect(response.status).toBe(400);
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
  });

  it('rejects a same-origin callback path that would resolve as a scheme-relative redirect', async () => {
    const database = oauthDatabase();
    const response = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: JSON.stringify({ callbackURL: 'https://cloudchef.build//attacker.example/landing' }),
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(201);
    expect(database.state?.returnTo).toBe('/');
  });

  it('revalidates a persisted return path before constructing the completion redirect', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    database.state!.returnTo = '//attacker.example/landing';
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://cloudchef.build/');
  });

  it('completes OAuth, activates the selected account, and creates the app session', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: JSON.stringify({ callbackURL: 'https://cloudchef.build/settings' }),
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    expect(start.status).toBe(201);
    const state = database.state!.id;
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${state}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://cloudchef.build/settings');
    expect(response.headers.get('set-cookie')).toContain('cloudchef_session=opaque');
    expect(mocks.upsertCloudflareUser).toHaveBeenCalledWith(
      database.env.DB,
      expect.objectContaining({ subject: 'cf-user-1', email: 'person@example.com' }),
      'User Cloudflare',
    );
    expect(mocks.activateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        accountId: ACCOUNT_ID,
        credentialHandle: 'credential-1',
        expectedGeneration: null,
      }),
    );
    expect(mocks.prepareAuthSession).toHaveBeenCalledWith('user-1', expect.any(Request));
    expect(mocks.createAuthSession).toHaveBeenCalledWith(
      database.env,
      expect.objectContaining({ id: 'session-1', tokenHash: 'f'.repeat(64) }),
    );
    expect(database.state?.status).toBe('completed');

    const replay = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${state}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    expect(replay.status).toBe(404);
  });

  it('turns a provider rejection into a safe, retryable settings redirect', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: JSON.stringify({ callbackURL: 'https://cloudchef.build/chat/project?panel=code#preview' }),
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    const callback = new URL('https://cloudchef.build/connect/return');
    callback.searchParams.set('state', database.state!.id);
    callback.searchParams.set('error', 'invalid_scope');
    callback.searchParams.set('error_description', '<script>steal()</script>');

    const response = await completeCloudflareConnectionAction({
      request: new Request(callback, { headers: { cookie: stateCookie } }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://cloudchef.build/settings?continue=%2Fchat%2Fproject%3Fpanel%3Dcode%23preview&cloudflare_authorization=failed#cloudflare',
    );
    expect(response.headers.get('location')).not.toContain('script');
    expect(response.headers.get('set-cookie')).toContain('cloudchef_oauth_state=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(database.state?.status).toBe('error');
    expect(orchestrator.completeConnection).not.toHaveBeenCalled();
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('validates browser state before showing provider-error recovery', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&error=access_denied`),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Cloudflare authorization browser state did not match.',
    });
    expect(database.state?.status).toBe('pending');
    expect(orchestrator.completeConnection).not.toHaveBeenCalled();
  });

  it('recovers when provider rejection persistence commits before acknowledgement fails', async () => {
    const database = oauthDatabase({ providerErrorAfterCommit: new Error('D1 acknowledgement lost') });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&error=access_denied`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    expect(database.state?.status).toBe('error');
    expect(database.exactCompletionRead).toHaveBeenCalledOnce();
  });

  it('rejects an oversized OAuth callback field before provider or persistence work', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(
        `https://cloudchef.build/connect/return?state=${database.state!.id}&code=${'a'.repeat(4_097)}`,
        { headers: { cookie: stateCookie } },
      ),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(400);
    expect(database.state?.status).toBe('pending');
    expect(orchestrator.completeConnection).not.toHaveBeenCalled();
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('finishes the callback when the exact state completion committed before acknowledgement failed', async () => {
    const database = oauthDatabase({
      completionErrorAfterCommit: new Error('state completion acknowledgement failed'),
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    expect(database.state?.status).toBe('completed');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
    expect(mocks.createAuthSession).toHaveBeenCalledTimes(1);
  });

  it('continues when the exact authenticated-user checkpoint committed before acknowledgement failed', async () => {
    const database = oauthDatabase({
      checkpointErrorAfterCommit: new Error('authentication checkpoint acknowledgement failed'),
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(303);
    expect(database.state?.status).toBe('completed');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects an acknowledgement failure for a mismatched authenticated-user checkpoint', async () => {
    const database = oauthDatabase({
      checkpointErrorAfterCommit: new Error('authentication checkpoint acknowledgement failed'),
      checkpointMismatchAfterCommit: true,
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(500);
    expect(database.state?.status).toBe('pending');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('rejects a state completion acknowledgement failure when the committed state does not match exactly', async () => {
    const database = oauthDatabase({
      completionErrorAfterCommit: new Error('state completion acknowledgement failed'),
      completionMismatchAfterCommit: true,
    });
    const orchestrator = fakeOrchestrator();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(500);
    expect(database.state?.status).toBe('completed');
    expect(database.exactCompletionRead).toHaveBeenCalledTimes(1);
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
  });

  it('resumes a session persistence failure without replaying the one-time provider exchange', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    mocks.findConnection.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'connection-1',
      userId: 'user-1',
      accountId: ACCOUNT_ID,
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-1',
      grantedCapabilities: ['workers'],
      requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      oauthScopeProfileVersion: 'core-v1',
      oauthScopeGrantStatus: 'core' as const,
      aiBillingEnabled: false,
      connectedAt: 100,
      updatedAt: 100,
      generation: 1,
    });
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator,
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.createAuthSession.mockRejectedValueOnce(new Error('session persistence failed'));

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(response.status).toBe(500);
    expect(database.state?.status).toBe('pending');
    expect(database.state?.authenticatedUserId).toBe('user-1');
    expect(database.completeStateWrite).not.toHaveBeenCalled();
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);

    const retry = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator,
    });

    expect(retry.status).toBe(303);
    expect(database.state?.status).toBe('completed');
    expect(orchestrator.completeConnection).toHaveBeenCalledTimes(1);
    expect(mocks.activateConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects a callback that was not initiated by the same browser', async () => {
    const database = oauthDatabase();
    await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const state = database.state!.id;

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${state}&code=code-1`),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('browser state') });
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('fails a competing callback and cleans up only through a reference-aware credential delete', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const state = database.state!.id;
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.findConnection
      .mockResolvedValueOnce({ credentialHandle: 'credential-old', generation: 4, status: 'active' })
      .mockResolvedValueOnce({
        id: 'connection-1',
        userId: 'user-1',
        accountId: 'different-account',
        accountName: 'Different account',
        status: 'active',
        credentialHandle: 'credential-winner',
        grantedCapabilities: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
        requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
        grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
        oauthScopeProfileVersion: 'core-v1',
        oauthScopeGrantStatus: 'core' as const,
        aiBillingEnabled: true,
        connectedAt: 101,
        updatedAt: 101,
        generation: 5,
      });
    mocks.activateConnection.mockRejectedValueOnce(new mocks.CloudflareConnectionChangedError());

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${state}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(500);
    expect(mocks.activateConnection).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: 4 }));
    expect(mocks.vault.deleteIfUnreferenced).toHaveBeenCalledWith('credential-1');
    expect(mocks.vault.deleteIfUnreferenced).not.toHaveBeenCalledWith('credential-old');
    expect(database.state?.status).toBe('pending');
    expect(mocks.createAuthSession).not.toHaveBeenCalled();
  });

  it('adopts an equivalent concurrent connection winner after a raced user callback', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.upsertCloudflareUser.mockResolvedValueOnce({
      id: 'user-1',
      name: 'Person',
      email: 'person@example.com',
      image: null,
    });
    mocks.findConnection.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'connection-winner',
      userId: 'user-1',
      accountId: ACCOUNT_ID,
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-winner',
      grantedCapabilities: ['workers', 'd1', 'r2', 'durable_objects', 'workers_ai'],
      requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      oauthScopeProfileVersion: 'core-v1',
      oauthScopeGrantStatus: 'core' as const,
      aiBillingEnabled: true,
      connectedAt: 101,
      updatedAt: 101,
      generation: 1,
    });
    mocks.activateConnection.mockRejectedValueOnce(new mocks.CloudflareConnectionChangedError());

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(database.state?.authenticatedUserId).toBe('user-1');
    expect(database.state?.status).toBe('completed');
    expect(mocks.vault.deleteIfUnreferenced).toHaveBeenCalledWith('credential-1');
    expect(mocks.createAuthSession).toHaveBeenCalledOnce();
  });

  it('cleans up a superseded callback credential only after the new handle is active', async () => {
    const database = oauthDatabase();
    const start = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: '{}',
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });
    const stateCookie = start.headers.get('set-cookie')!.split(';', 1)[0];
    mocks.findConnection.mockResolvedValueOnce({ credentialHandle: 'credential-old', generation: 4, status: 'active' });
    mocks.activateConnection.mockResolvedValueOnce({
      id: 'connection-1',
      userId: 'user-1',
      accountId: ACCOUNT_ID,
      accountName: 'User Cloudflare',
      status: 'active',
      credentialHandle: 'credential-1',
      grantedCapabilities: ['workers'],
      requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      oauthScopeProfileVersion: 'core-v1',
      oauthScopeGrantStatus: 'core' as const,
      aiBillingEnabled: false,
      connectedAt: 100,
      updatedAt: 100,
      generation: 5,
    });

    const response = await completeCloudflareConnectionAction({
      request: new Request(`https://cloudchef.build/connect/return?state=${database.state!.id}&code=code-1`, {
        headers: { cookie: stateCookie },
      }),
      env: database.env,
      orchestrator: fakeOrchestrator(),
    });

    expect(response.status).toBe(303);
    expect(mocks.activateConnection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.vault.deleteIfUnreferenced.mock.invocationCallOrder[0],
    );
    expect(mocks.vault.deleteIfUnreferenced).toHaveBeenCalledWith('credential-old');
    expect(mocks.vault.deleteIfUnreferenced).not.toHaveBeenCalledWith('credential-1');
  });
});

function activeConnection(
  generation = 1,
  grantedCapabilities = ['workers', 'containers', 'd1', 'r2', 'kv', 'durable_objects', 'workers_ai'],
) {
  return {
    id: 'connection-1',
    userId: 'user-1',
    accountId: ACCOUNT_ID,
    accountName: 'User Cloudflare',
    status: 'active' as const,
    credentialHandle: 'credential-1',
    grantedCapabilities,
    requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
    grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
    oauthScopeProfileVersion: 'core-v1',
    oauthScopeGrantStatus: 'core' as const,
    aiBillingEnabled: true,
    connectedAt: 100,
    updatedAt: 100,
    generation,
  };
}

function runtimeRow(
  overrides: {
    connectionGeneration?: number;
    runtimeVersion?: string;
    imageDigest?: string | null;
  } = {},
) {
  return {
    user_id: 'user-1',
    connection_id: 'connection-1',
    connection_generation: overrides.connectionGeneration ?? 1,
    worker_name: 'cloudchef-workspace-test',
    endpoint: 'https://workspace.example',
    runtime_version: overrides.runtimeVersion ?? USER_WORKSPACE_RUNTIME_SHA256,
    image_digest: overrides.imageDigest === undefined ? USER_WORKSPACE_SANDBOX_BASE_IMAGE : overrides.imageDigest,
    created_at: 100,
    updated_at: 100,
  };
}

function runtimeSessionRequest() {
  return new Request('https://cloudchef.build/api/cloudflare/runtime-session', {
    method: 'POST',
    headers: { Origin: 'https://cloudchef.build' },
  });
}

function runtimeEnv(rows: Array<ReturnType<typeof runtimeRow> | null>): Env {
  const queue = [...rows];
  const db = {
    prepare(sql: string) {
      if (!sql.includes('FROM user_computer_runtimes')) {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return {
        bind: () => ({ first: async () => queue.shift() ?? null }),
      };
    },
  } as unknown as D1Database;
  return {
    DB: db,
    CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
  } as unknown as Env;
}

function fakeOrchestrator(): CloudflareOrchestrator {
  return {
    startConnection: vi.fn(async () => ({
      sessionId: 'provider-session',
      authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth?client_id=test',
      expiresAt: Date.now() + 60_000,
    })),
    completeConnection: vi.fn(async () => ({
      user: {
        subject: 'cf-user-1',
        email: 'person@example.com',
        name: 'Person',
        picture: null,
      },
      accountId: ACCOUNT_ID,
      accountName: 'User Cloudflare',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: Date.now() + 3_600_000,
      grantedCapabilities: [
        'workers',
        'd1',
        'r2',
        'durable_objects',
        'workers_ai',
      ] as CloudflareConnectionResult['grantedCapabilities'],
      requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
      oauthScopeProfileVersion: 'core-v1',
      oauthScopeGrantStatus: 'core' as const,
    })),
  };
}

function oauthDatabase(
  options: {
    rateLimitSuccess?: boolean;
    checkpointErrorAfterCommit?: Error;
    checkpointMismatchAfterCommit?: boolean;
    completionErrorAfterCommit?: Error;
    completionMismatchAfterCommit?: boolean;
    providerErrorAfterCommit?: Error;
  } = {},
) {
  type State = {
    id: string;
    providerSessionId: string;
    returnTo: string;
    status: 'pending' | 'completed' | 'expired' | 'error';
    expiresAt: number;
    authenticatedUserId: string | null;
    updatedAt: number;
  };
  let state: State | null = null;
  const limit = vi.fn(async () => ({ success: options.rateLimitSuccess ?? true }));
  const completeStateWrite = vi.fn();
  const exactCompletionRead = vi.fn();
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (!sql.includes('FROM cloudflare_oauth_states') || !state) {
                return null;
              }
              if (sql.includes('status, expires_at, authenticated_user_id, updated_at')) {
                exactCompletionRead(...values);
                if (values[0] !== state.id) {
                  return null;
                }
                return {
                  provider_session_id: state.providerSessionId,
                  return_to: state.returnTo,
                  status: state.status,
                  expires_at: state.expiresAt,
                  authenticated_user_id: state.authenticatedUserId,
                  updated_at: state.updatedAt,
                };
              }
              if (state.status !== 'pending' || values[0] !== state.id) {
                return null;
              }
              return {
                provider_session_id: state.providerSessionId,
                return_to: state.returnTo,
                expires_at: state.expiresAt,
                authenticated_user_id: state.authenticatedUserId,
              };
            },
            run: async () => {
              if (sql.includes('INSERT INTO cloudflare_oauth_states')) {
                state = {
                  id: values[0] as string,
                  providerSessionId: values[1] as string,
                  returnTo: values[2] as string,
                  status: 'pending',
                  expiresAt: values[3] as number,
                  authenticatedUserId: null,
                  updatedAt: values[5] as number,
                };
              } else if (sql.includes('SET authenticated_user_id') && state) {
                const matches =
                  state.status === 'pending' &&
                  state.authenticatedUserId === null &&
                  values[2] === state.id &&
                  values[3] === state.providerSessionId &&
                  values[4] === state.returnTo &&
                  values[5] === state.expiresAt;
                if (!matches) {
                  return { success: true, meta: { changes: 0 } };
                }
                state = {
                  ...state,
                  authenticatedUserId: values[0] as string,
                  updatedAt: (values[1] as number) + (options.checkpointMismatchAfterCommit ? 1 : 0),
                };
                if (options.checkpointErrorAfterCommit) {
                  throw options.checkpointErrorAfterCommit;
                }
              } else if (sql.includes("status = 'completed'") && state) {
                completeStateWrite(...values);
                const matches =
                  state.status === 'pending' &&
                  values[1] === state.id &&
                  values[2] === state.providerSessionId &&
                  values[3] === state.returnTo &&
                  values[4] === state.expiresAt &&
                  values[5] === state.authenticatedUserId;
                if (!matches) {
                  return { success: true, meta: { changes: 0 } };
                }
                state = {
                  ...state,
                  status: 'completed',
                  updatedAt: (values[0] as number) + (options.completionMismatchAfterCommit ? 1 : 0),
                };
                if (options.completionErrorAfterCommit) {
                  throw options.completionErrorAfterCommit;
                }
              } else if (sql.includes("status = 'expired'") && state) {
                state = { ...state, status: 'expired', updatedAt: values[0] as number };
              } else if (sql.includes("status = 'error'") && state) {
                const matches =
                  state.status === 'pending' &&
                  values[1] === state.id &&
                  values[2] === state.providerSessionId &&
                  values[3] === state.returnTo &&
                  values[4] === state.expiresAt &&
                  values[5] === state.authenticatedUserId;
                if (!matches) {
                  return { success: true, meta: { changes: 0 } };
                }
                state = { ...state, status: 'error', updatedAt: values[0] as number };
                if (options.providerErrorAfterCommit) {
                  throw options.providerErrorAfterCommit;
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return {
    env: {
      DB: db,
      CLOUDFLARE_OAUTH_START_RATE_LIMITER: { limit },
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
    } as unknown as Env,
    get state() {
      return state;
    },
    limit,
    completeStateWrite,
    exactCompletionRead,
  };
}
