import { expect, test } from '@playwright/test';
import { CLOUDFLARE_CONNECT_MESSAGE_PARAM } from '~/lib/cloudflare/authorization-recovery';
import { runtimeIdentityHeaders } from '~/lib/.server/cloudflare/runtime-identity-headers';
import { collectBrowserDiagnostics } from './browser-diagnostics';

// The built Worker enforces these boundaries itself, so they are provable
// against the local candidate without any Cloudflare account.
const FORGED_SESSION_COOKIE = 'cloudchef_session=forged-session-token';
// A runtime names itself in headers and proves it with a bearer secret; the body carries only the request.
const FORGED_RUNTIME_IDENTITY = runtimeIdentityHeaders({
  userId: 'forged-user',
  connectionId: 'forged-connection',
  connectionGeneration: 1,
});
const RUNTIME_CREDENTIAL_REQUEST = { forceRefresh: false };

type DeniedRequest = {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  data?: unknown;
  status: number;
};

test('refuses private endpoints to unauthenticated and forged sessions', async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const denied: DeniedRequest[] = [
    { name: 'connection status without a session', method: 'GET', path: '/api/cloudflare/connection', status: 401 },
    {
      name: 'connection status with a forged session',
      method: 'GET',
      path: '/api/cloudflare/connection',
      headers: { Cookie: FORGED_SESSION_COOKIE },
      status: 401,
    },
    {
      name: 'runtime session without a session',
      method: 'POST',
      path: '/api/cloudflare/runtime-session',
      headers: { Origin: origin },
      status: 401,
    },
    {
      name: 'runtime session with a forged session',
      method: 'POST',
      path: '/api/cloudflare/runtime-session',
      headers: { Origin: origin, Cookie: FORGED_SESSION_COOKIE },
      status: 401,
    },
    {
      name: 'runtime session from another origin',
      method: 'POST',
      path: '/api/cloudflare/runtime-session',
      headers: { Origin: 'https://attacker.example' },
      status: 403,
    },
    {
      name: 'sign-out from another origin',
      method: 'POST',
      path: '/api/auth/sign-out',
      headers: { Origin: 'https://attacker.example', Cookie: FORGED_SESSION_COOKIE },
      status: 403,
    },
    // A request that names no runtime is malformed, refused before any secret is looked at.
    {
      name: 'runtime credential without identity headers',
      method: 'POST',
      path: '/api/cloudflare/runtime-credential',
      data: RUNTIME_CREDENTIAL_REQUEST,
      status: 400,
    },
    {
      name: 'runtime credential without identity headers but with a forged bearer token',
      method: 'POST',
      path: '/api/cloudflare/runtime-credential',
      headers: { Authorization: `Bearer ${'f'.repeat(64)}` },
      data: RUNTIME_CREDENTIAL_REQUEST,
      status: 400,
    },
    {
      name: 'runtime credential without a bearer token',
      method: 'POST',
      path: '/api/cloudflare/runtime-credential',
      headers: FORGED_RUNTIME_IDENTITY,
      data: RUNTIME_CREDENTIAL_REQUEST,
      status: 401,
    },
    {
      name: 'runtime credential with a forged bearer token',
      method: 'POST',
      path: '/api/cloudflare/runtime-credential',
      // Long enough to be read as a bearer secret, so the refusal is the secret's, not its shape's.
      headers: { ...FORGED_RUNTIME_IDENTITY, Authorization: `Bearer ${'f'.repeat(64)}` },
      data: RUNTIME_CREDENTIAL_REQUEST,
      status: 401,
    },
    { name: 'runtime session over GET', method: 'GET', path: '/api/cloudflare/runtime-session', status: 405 },
  ];

  for (const { name, method, path, headers, data, status } of denied) {
    const response = await request.fetch(path, { method, headers, data });
    expect(response.status(), name).toBe(status);
    expect(await response.text(), name).not.toContain('accountId');
  }
});

test('sends a forged OAuth return back to Settings without a session', async ({ request }) => {
  const response = await request.get('/connect/return?state=11111111-1111-4111-8111-111111111111&code=forged-code', {
    maxRedirects: 0,
  });

  // A return this browser never started is explained on Settings, never completed.
  expect(response.status()).toBe(303);
  const location = new URL(response.headers().location!);
  expect(location.pathname).toBe('/settings');
  expect(location.searchParams.get(CLOUDFLARE_CONNECT_MESSAGE_PARAM)).toBe('other_browser');
  const cookies = response.headersArray().filter(({ name }) => name.toLowerCase() === 'set-cookie');
  expect(cookies.some(({ value }) => value.startsWith('cloudchef_session='))).toBe(false);
  expect(response.headers()['cache-control']).toBe('no-store');
});

test('mints no session from a forged cookie', async ({ request }) => {
  for (const headers of [undefined, { Cookie: FORGED_SESSION_COOKIE }]) {
    const response = await request.get('/api/auth/session', { headers });

    expect(response.status()).toBe(200);
    expect(await response.json()).toBeNull();
    expect(response.headers()['cache-control']).toBe('no-store');
  }
});

test('keeps the project workbench closed to a forged browser session', async ({ page, context, baseURL }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await context.addCookies([
    { name: 'cloudchef_session', value: 'forged-session-token', domain: new URL(baseURL!).hostname, path: '/' },
  ]);

  await page.goto('/chat/forged-session-project');

  await expect(page.getByRole('heading', { name: /Sign in to open this project/i })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Project workbench' })).toHaveCount(0);
  await assertClean();
});
