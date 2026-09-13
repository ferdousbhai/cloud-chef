import { beforeEach, describe, expect, it, vi } from 'vitest';

const tanstackFetch = vi.hoisted(() => vi.fn<(request: Request, env: Env) => Promise<Response>>());
const getAuthSession = vi.hoisted(() => vi.fn());
const healthAction = vi.hoisted(() => vi.fn());
const completeCloudflareConnectionAction = vi.hoisted(() => vi.fn());
const cloudflareConnectionStatusAction = vi.hoisted(() => vi.fn());
const startCloudflareConnectionAction = vi.hoisted(() => vi.fn());
const pruneCloudflareAuthDataBestEffort = vi.hoisted(() => vi.fn());
const runtimeCredentialAction = vi.hoisted(() => vi.fn());
const clientTelemetryAction = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-start/server-entry', () => ({ default: { fetch: tanstackFetch } }));
vi.mock('./lib/.server/auth', () => ({ getAuthSession }));
vi.mock('./server-handlers/auth', () => ({ authSessionAction: vi.fn(), signOutAction: vi.fn() }));
vi.mock('./server-handlers/cloudflare-integration', () => ({
  CLOUDFLARE_CONNECTION_CALLBACK_METHOD: 'GET',
  cloudflareConnectionStatusAction,
  completeCloudflareConnectionAction,
  startCloudflareConnectionAction,
}));
vi.mock('./server-handlers/health', () => ({ healthAction }));
vi.mock('./server-handlers/version', () => ({ versionAction: vi.fn() }));
vi.mock('./server-handlers/runtime-credential', () => ({ runtimeCredentialAction }));
vi.mock('./server-handlers/client-telemetry', () => ({ clientTelemetryAction }));
vi.mock('./lib/cloudflare/data/cloudflare-auth-retention.server', () => ({ pruneCloudflareAuthDataBestEffort }));

import server from './server';

function testEnv(overrides: Partial<Env> = {}): Env {
  // SAFETY: every route exercised in this file hands `env` straight to a mocked handler and reads
  // no binding beyond the overrides a test supplies, so the rest of the environment is unobserved.
  return { ...overrides } as Env;
}

function testExecutionContext(waitUntil: (promise: Promise<unknown>) => void): ExecutionContext {
  // SAFETY: `server.scheduled` only calls `ctx.waitUntil`. The remaining members (`exports`,
  // `props`, `tracing`) are runtime-provided and never touched on this path.
  return { waitUntil } as unknown as ExecutionContext;
}

describe('server Agent routing boundary', () => {
  beforeEach(() => {
    tanstackFetch.mockReset();
    tanstackFetch.mockResolvedValue(new Response('application', { headers: { 'Content-Type': 'text/html' } }));
    getAuthSession.mockReset();
    healthAction.mockReset().mockResolvedValue(Response.json({ status: 'ok' }));
    completeCloudflareConnectionAction.mockReset().mockImplementation(async () => {
      const headers = new Headers({ Location: 'https://ghostbuild.dev/' });
      headers.append('Set-Cookie', 'ghostbuild_session=session; Path=/; HttpOnly; Secure');
      headers.append('Set-Cookie', 'ghostbuild_oauth_state=; Path=/connect/return; Max-Age=0');
      return new Response(null, { status: 303, headers });
    });
    cloudflareConnectionStatusAction.mockReset().mockResolvedValue(Response.json({ connected: true }));
    startCloudflareConnectionAction
      .mockReset()
      .mockResolvedValue(Response.json({ error: 'Invalid request.' }, { status: 400 }));
    pruneCloudflareAuthDataBestEffort.mockReset().mockResolvedValue(undefined);
    runtimeCredentialAction.mockReset().mockResolvedValue(Response.json({ accessToken: 'fresh' }));
    clientTelemetryAction.mockReset().mockResolvedValue(new Response(null, { status: 202 }));
  });

  it('leaves non-Builder Agent-looking routes to the application router', async () => {
    const pathname = '/agents/unrecognized/private';
    const response = await server.fetch(new Request(`https://ghostbuild.dev${pathname}`), testEnv());

    expect(response.status).toBe(200);
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(tanstackFetch).toHaveBeenCalledOnce();
  });

  it('leaves ordinary application routes outside the Agent routing boundary', async () => {
    const response = await server.fetch(new Request('https://ghostbuild.dev/not-an-agent'), testEnv());

    expect(await response.text()).toBe('application');
    expect(response.headers.has('Cross-Origin-Opener-Policy')).toBe(false);
    expect(response.headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    const forwardedRequest = tanstackFetch.mock.calls[0]?.[0];
    const nonce = forwardedRequest.headers.get('X-Ghostbuild-CSP-Nonce');
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/i);
    expect(response.headers.get('Content-Security-Policy')).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(tanstackFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['HTTP', 'http://ghostbuild.dev/share?from=http', 'https://ghostbuild.dev/share?from=http'],
    ['www', 'https://www.ghostbuild.dev/share?from=www', 'https://ghostbuild.dev/share?from=www'],
  ])('redirects the production %s origin to canonical HTTPS before routing', async (_label, source, destination) => {
    const response = await server.fetch(new Request(source), testEnv());

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(destination);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(tanstackFetch).not.toHaveBeenCalled();
  });

  it('prevents cached HTML from retaining stale hashed asset references', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('<html></html>', {
        headers: { 'Cache-Control': 'public, max-age=300', 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/chat/project'), testEnv());

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('preserves the streamed HTML body while applying the matching nonce policy', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>'));
        controller.close();
      },
    });
    tanstackFetch.mockResolvedValueOnce(
      new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/stream'), testEnv());
    const forwardedRequest = tanstackFetch.mock.calls[0]?.[0];
    const nonce = forwardedRequest.headers.get('X-Ghostbuild-CSP-Nonce');

    expect(response.body).toBe(body);
    expect(response.headers.get('Content-Security-Policy')).toContain(`'nonce-${nonce}'`);
    expect(await response.text()).toBe('<html>');
  });

  it('preserves immutable caching for content-addressed static assets', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('export {}', {
        headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': 'text/javascript' },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/assets/app-abc123.js'), testEnv());

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('applies the application security policy to exact API responses', async () => {
    const response = await server.fetch(new Request('https://ghostbuild.dev/api/health'), testEnv());

    expect(response.status).toBe(200);
    expect(response.headers.has('Cross-Origin-Opener-Policy')).toBe(false);
    expect(response.headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(healthAction).toHaveBeenCalledOnce();
    expect(tanstackFetch).not.toHaveBeenCalled();
  });

  it('applies the application security policy to router-generated errors', async () => {
    const response = await server.fetch(
      new Request('https://ghostbuild.dev/api/health', { method: 'POST' }),
      testEnv(),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(healthAction).not.toHaveBeenCalled();
  });

  it('marks OAuth callback redirects no-store without losing either cookie', async () => {
    const response = await server.fetch(
      new Request('https://ghostbuild.dev/connect/return?state=00000000-0000-4000-8000-000000000001&code=code'),
      testEnv(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.getSetCookie()).toEqual([
      'ghostbuild_session=session; Path=/; HttpOnly; Secure',
      'ghostbuild_oauth_state=; Path=/connect/return; Max-Age=0',
    ]);
    expect(completeCloudflareConnectionAction).toHaveBeenCalledOnce();
  });

  it.each([
    ['connection status', '/api/cloudflare/connection', 'GET'],
    ['OAuth start errors', '/api/cloudflare/connection/start', 'POST'],
  ])('marks Cloudflare %s responses no-store', async (_label, pathname, method) => {
    const response = await server.fetch(new Request(`https://ghostbuild.dev${pathname}`, { method }), testEnv());

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('routes only POST requests to the private runtime credential broker', async () => {
    const env = testEnv();
    const request = new Request('https://ghostbuild.dev/api/cloudflare/runtime-credential', { method: 'POST' });

    const response = await server.fetch(request, env);

    expect(response.status).toBe(200);
    expect(runtimeCredentialAction).toHaveBeenCalledWith({ request, env });

    const rejected = await server.fetch(new Request('https://ghostbuild.dev/api/cloudflare/runtime-credential'), env);
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get('Allow')).toBe('POST');
    expect(runtimeCredentialAction).toHaveBeenCalledOnce();
  });

  it('routes only POST requests to privacy-safe client telemetry ingestion', async () => {
    const request = new Request('https://ghostbuild.dev/api/client-telemetry', { method: 'POST' });

    const response = await server.fetch(request, testEnv());

    expect(response.status).toBe(202);
    expect(clientTelemetryAction).toHaveBeenCalledWith({ request, env: {} });
    const rejected = await server.fetch(new Request('https://ghostbuild.dev/api/client-telemetry'), testEnv());
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get('Allow')).toBe('POST');
    expect(clientTelemetryAction).toHaveBeenCalledOnce();
  });

  it('preserves an explicit application cache policy', async () => {
    healthAction.mockResolvedValueOnce(
      Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'public, max-age=60' } }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/api/health'), testEnv());

    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('independently enforces the baseline without weakening stricter application CSP or HSTS', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('application', {
        headers: {
          'Content-Security-Policy': "default-src 'none'; script-src 'self'",
          'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
        },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/strict'), testEnv());

    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; script-src 'self', base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
    );
    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains; preload');
  });

  it('bounds malformed HSTS parsing and preserves non-max-age directives when applying the floor', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('application', {
        headers: {
          'Strict-Transport-Security': `max-age=${'9'.repeat(1_024)}; includeSubDomains; future=value`,
        },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/hsts-floor'), testEnv());

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains; future=value');
  });

  it('normalizes duplicate HSTS max-age directives', async () => {
    tanstackFetch.mockResolvedValueOnce(
      new Response('application', {
        headers: {
          'Strict-Transport-Security': 'max-age=63072000; max-age=0; includeSubDomains',
        },
      }),
    );

    const response = await server.fetch(new Request('https://ghostbuild.dev/duplicate-hsts'), testEnv());

    expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
  });

  it('runs authentication-metadata retention on schedule', async () => {
    const waitUntil = vi.fn();
    const env = testEnv();

    const controller: ScheduledController = {
      cron: '*/15 * * * *',
      scheduledTime: Date.now(),
      noRetry: () => undefined,
    };

    server.scheduled(controller, env, testExecutionContext(waitUntil));

    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
    expect(pruneCloudflareAuthDataBestEffort).toHaveBeenCalledWith(env.DB);
  });

  it('exposes no HTTP route for private operations', async () => {
    const env = testEnv();

    // Operations are scheduled work inside this Worker, not a surface anyone can
    // reach. Nothing under these paths may resolve to a dedicated handler, so
    // each one falls through to the application like any unknown path.
    for (const request of [
      new Request('https://ghostbuild.dev/api/ops/session'),
      new Request('https://ghostbuild.dev/api/internal/ops/runtime-version'),
      new Request('https://ghostbuild.dev/api/internal/ops/runtimes/reconcile', { method: 'POST' }),
    ]) {
      tanstackFetch
        .mockClear()
        .mockResolvedValue(new Response('application', { headers: { 'Content-Type': 'text/html' } }));
      const response = await server.fetch(request, env);

      expect(tanstackFetch).toHaveBeenCalledOnce();
      expect(await response.text()).toBe('application');
    }
  });

  it('exports only the Worker handler and its durable provisioning Workflow', async () => {
    // `OperationsService` existed only so a second deployed Worker could reach the control
    // plane's credentials over RPC. Its caller now runs in this Worker, so the entrypoint - and
    // the Service binding that authorized it - are gone rather than left reachable.
    const exported = await import('./server');

    expect(Object.keys(exported).sort()).toEqual(['UserWorkspaceRuntimeProvisioningWorkflow', 'default']);
  });
});
