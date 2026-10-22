import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudflareConnectionResult,
  CloudflareOrchestrator,
} from '~/lib/.server/cloudflare/cloudflare-orchestrator';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_SANDBOX_BASE_IMAGE } from '~/workflows/user-workspace-runtime-provisioning';
import { cloudflareConnectMessageText } from '~/lib/cloudflare/authorization-recovery';

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
  findCloudflareConnectionForOwner: mocks.findConnection,
  findActiveCloudflareConnection: mocks.findConnection,
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

/**
 * Where a return from Cloudflare that could not finish sends the browser: Settings, saying why. The
 * answer is the message Settings shows for the code in the URL.
 */
function returnFailure(response: Response): string | null {
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.pathname).toBe('/settings');
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  const code = location.searchParams.get('cloudflare_message');
  expect(code).toMatch(/^[a-z_]+$/);
  return code === null ? null : cloudflareConnectMessageText(code);
}

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
    // Signed out unless a test says otherwise.
    mocks.getAuthSession.mockResolvedValue(null);
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
    mocks.getAuthSession.mockResolvedValue(signedInSession);
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
    // A runtime speaking another protocol cannot serve this release's browser, so it waits for the upgrade.
    ['incompatible', runtimeRow({ runtimeVersion: '0'.repeat(64), protocolVersion: 2 })],
  ])('starts background provisioning for an %s runtime', async (_case, initialRuntime) => {
    mocks.getAuthSession.mockResolvedValue(signedInSession);
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
      isReady: expect.any(Function),
    });
  });

  it.each([
    ['from an earlier release', runtimeRow({ runtimeVersion: '0'.repeat(64) })],
    ['recorded with the current protocol', runtimeRow({ runtimeVersion: '0'.repeat(64), protocolVersion: 1 })],
    // A row pinned to a different image than the current one, or one that never recorded an image,
    // is upgraded so a base-image bump reaches workspaces that were provisioned before it.
    ['on a superseded image', runtimeRow({ imageDigest: `docker.io/cloudflare/sandbox:x@sha256:${'a'.repeat(64)}` })],
    ['provisioned before the image was recorded', runtimeRow({ imageDigest: null })],
  ])(
    'keeps a runtime %s working while its upgrade waits for nothing to be running in it',
    async (_case, initialRuntime) => {
      mocks.getAuthSession.mockResolvedValue(signedInSession);
      mocks.findConnection.mockResolvedValue(activeConnection());
      const provision = vi.fn().mockResolvedValue({ status: 'preparing' });
      const env = runtimeEnv([initialRuntime]);
      const response = await cloudflareRuntimeSessionAction({
        request: runtimeSessionRequest(),
        env,
        provision,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        endpoint: 'https://workspace.example',
        token: expect.any(String),
      });
      expect(provision).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 1 }),
      );
      // The session counts as use, so a runtime too old to report its activity is not upgraded under it.
      expect(sessionsRecorded(env)).toBe(1);
    },
  );

  it('keeps an earlier runtime working when its upgrade cannot be started', async () => {
    mocks.getAuthSession.mockResolvedValue(signedInSession);
    mocks.findConnection.mockResolvedValue(activeConnection());
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([runtimeRow({ runtimeVersion: '0'.repeat(64) })]),
      provision: vi.fn().mockRejectedValue(new Error('Workflows is unavailable')),
    });

    expect(response.status).toBe(200);
    error.mockRestore();
  });

  it('surfaces a durable asynchronous provisioning failure without exposing its private detail', async () => {
    mocks.getAuthSession.mockResolvedValue(signedInSession);
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
    mocks.getAuthSession.mockResolvedValue(signedInSession);
    mocks.findConnection.mockResolvedValue(activeConnection());

    const response = await cloudflareRuntimeSessionAction({
      request: runtimeSessionRequest(),
      env: runtimeEnv([runtimeRow(), runtimeRow()]),
      provision: vi.fn(),
    });

    const { correlationId } = (await response.json()) as { correlationId?: string };
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'runtime_session_issued', correlationId }));
    // The join key must never be accompanied by the account it was issued for.
    expect(JSON.stringify(info.mock.calls)).not.toContain('user-1');
  });

  it('sends a tab that opened in another account back to reload, rather than into the new one', async () => {
    mocks.getAuthSession.mockResolvedValue(signedInSession);
    mocks.findConnection.mockResolvedValue(activeConnection());
    const response = await cloudflareRuntimeSessionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/runtime-session', {
        method: 'POST',
        headers: { Origin: 'https://cloudchef.build', 'CloudChef-Workspace': 'organization-connection' },
      }),
      env: runtimeEnv([null]),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'workspace_switched' });
  });

  it('reuses a current runtime without provisioning', async () => {
    mocks.getAuthSession.mockResolvedValue(signedInSession);
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
    mocks.getAuthSession.mockResolvedValue(signedInSession);
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
    mocks.getAuthSession.mockResolvedValue(signedInSession);
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

  it('asks for a recent sign-in before attaching a Cloudflare login to a signed-in account', async () => {
    const database = oauthDatabase();
    const orchestrator = fakeOrchestrator();
    // Signed in by email an hour ago, with no Cloudflare login yet: a borrowed session must not attach one.
    mocks.getAuthSession.mockResolvedValue({
      ...signedInSession,
      session: { ...signedInSession.session, createdAt: Date.now() - 60 * 60_000 },
    });
    const response = await startCloudflareConnectionAction({
      request: new Request('https://cloudchef.build/api/cloudflare/connection/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cloudchef.build' },
        body: JSON.stringify({ callbackURL: 'https://cloudchef.build/settings' }),
      }),
      env: database.env,
      orchestrator,
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'reauthentication_required' });
    expect(orchestrator.startConnection).not.toHaveBeenCalled();
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
        owner: { kind: 'user', userId: 'user-1' },
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
    expect(returnFailure(replay)).toBe(
      'That Cloudflare authorization was already finished, or is no longer known. Connect Cloudflare again if you need to.',
    );
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

    expect(returnFailure(response)).toBe(
      'That Cloudflare authorization was started in another browser or tab. Connect Cloudflare again from here.',
    );
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

    expect(returnFailure(response)).toBe('That Cloudflare authorization couldn’t be read. Connect Cloudflare again.');
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

    expect(returnFailure(response)).toBe('Cloudflare couldn’t be connected just now. Try again.');
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

    expect(returnFailure(response)).toBe('Cloudflare couldn’t be connected just now. Try again.');
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

    expect(returnFailure(response)).toBe('Cloudflare couldn’t be connected just now. Try again.');
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

    expect(returnFailure(response)).toContain('another browser or tab');
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

    expect(returnFailure(response)).toBe('Cloudflare couldn’t be connected just now. Try again.');
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

/** Signed in, building in their own Cloudflare account. */
const signedInSession = {
  session: { id: 'session-1', userId: 'user-1', expiresAt: Date.now() + 60_000, createdAt: Date.now() },
  user: { id: 'user-1' },
  context: { kind: 'personal', connectionId: 'connection-1', accountName: 'User Cloudflare' },
};

function activeConnection(
  generation = 1,
  grantedCapabilities = ['workers', 'containers', 'd1', 'r2', 'kv', 'durable_objects', 'workers_ai'],
) {
  return {
    id: 'connection-1',
    userId: 'user-1',
    orgId: null,
    accountId: ACCOUNT_ID,
    accountName: 'User Cloudflare',
    status: 'active' as const,
    credentialHandle: 'credential-1',
    grantedCapabilities,
    requestedOAuthScopes: ['workers-scripts.write', 'd1.write'],
    grantedOAuthScopes: ['workers-scripts.write', 'd1.write'],
    oauthScopeProfileVersion: 'core-v1',
    oauthScopeGrantStatus: 'core' as const,
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
    protocolVersion?: number | null;
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
    protocol_version: overrides.protocolVersion ?? null,
    last_session_at: 100,
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

const recordedSessions = new WeakMap<Env, { count: number }>();

function runtimeEnv(rows: Array<ReturnType<typeof runtimeRow> | null>): Env {
  const queue = [...rows];
  const sessions = { count: 0 };
  const db = {
    prepare(sql: string) {
      if (sql.startsWith('UPDATE user_computer_runtimes SET last_session_at')) {
        return {
          bind: () => ({
            run: async () => {
              sessions.count += 1;
              return { meta: { changes: 1 } };
            },
          }),
        };
      }
      if (!sql.includes('FROM user_computer_runtimes')) {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return {
        bind: () => ({ first: async () => queue.shift() ?? null }),
      };
    },
  } as unknown as D1Database;
  const env = {
    DB: db,
    CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(1))),
  } as unknown as Env;
  recordedSessions.set(env, sessions);
  return env;
}

function sessionsRecorded(env: Env): number {
  return recordedSessions.get(env)?.count ?? 0;
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
              } else if (sql.includes("status = 'expired'") && state) {
                state = { ...state, status: 'expired', updatedAt: values[0] as number };
              } else if (sql.includes('SET status = ?, authenticated_user_id = ?') && state) {
                const [status, userId, updatedAt, id, providerSessionId, returnTo, expiresAt, fromUserId] = values;
                if (status === 'completed') {
                  completeStateWrite(...values);
                }
                const matches =
                  state.status === 'pending' &&
                  id === state.id &&
                  providerSessionId === state.providerSessionId &&
                  returnTo === state.returnTo &&
                  expiresAt === state.expiresAt &&
                  fromUserId === state.authenticatedUserId;
                if (!matches) {
                  return { success: true, meta: { changes: 0 } };
                }
                const [mismatchAfterCommit, errorAfterCommit] =
                  status === 'pending'
                    ? [options.checkpointMismatchAfterCommit, options.checkpointErrorAfterCommit]
                    : status === 'completed'
                      ? [options.completionMismatchAfterCommit, options.completionErrorAfterCommit]
                      : [false, options.providerErrorAfterCommit];
                state = {
                  ...state,
                  // SAFETY: the transition binds its status, user, and time first, in that order.
                  status: status as State['status'],
                  authenticatedUserId: userId as string | null,
                  updatedAt: (updatedAt as number) + (mismatchAfterCommit ? 1 : 0),
                };
                if (errorAfterCommit) {
                  throw errorAfterCommit;
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
