import { expect, test, type Page } from '@playwright/test';
import { PENDING_PROMPT_STORAGE_KEY, PENDING_SUBMIT_STORAGE_KEY } from '~/utils/constants';
import { collectBrowserDiagnostics } from './browser-diagnostics';

// Connecting Cloudflare is never a goal in itself: it is what the product asks for before it
// can do what was already asked of it. These tests stub the authorization round trip and prove
// which returns finish that instruction and which must not.
const PROMPT = 'Build a launch checklist.';
const authSession = {
  session: { id: 'e2e-session', userId: 'e2e-user', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
  user: { id: 'e2e-user', name: 'Continuation fixture', email: 'continuation@example.invalid', image: null },
};

/**
 * Authorizing at Cloudflare is a full page navigation back to CloudChef with a session, so
 * the connect start returns the origin itself and the session stub flips at the same moment.
 */
async function stubCloudflareAuthorization(page: Page) {
  const connection = { authorized: false };
  await page.route('**/api/auth/session', (route) =>
    route.fulfill(connection.authorized ? { json: authSession } : { body: 'null', contentType: 'application/json' }),
  );
  await page.route('**/api/cloudflare/connection/start', (route) => {
    connection.authorized = true;
    return route.fulfill({ json: { authorizationUrl: new URL(route.request().url()).origin } });
  });
  // The returning browser reaches a workspace that is still being built, which is the state
  // this fixture can produce without an account, and is enough to show the build was started.
  await page.route('**/api/cloudflare/runtime-session', (route) =>
    route.fulfill({
      status: 409,
      json: { code: 'workspace_preparing', error: 'CloudChef is still preparing your workspace.' },
    }),
  );
  return connection;
}

test('finishes the submit that had to connect Cloudflare first', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, [/status of 409/]);
  await stubCloudflareAuthorization(page);

  await page.goto('/');
  await page.getByPlaceholder(/Describe your app/i).fill(PROMPT);
  await page.getByRole('button', { name: 'Connect Cloudflare' }).first().click();

  // Back from Cloudflare, the prompt is not merely restored: the submit it belonged to runs.
  await expect(page.getByText('Preparing your Cloudflare workspace')).toBeVisible();
  await expect(page.getByPlaceholder(/Describe your app/i)).toHaveCount(0);
  await assertClean();
});

test('never starts a build for someone who connected from settings', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, [/status of 409/]);
  await stubCloudflareAuthorization(page);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /Connect Cloudflare to open settings/i })).toBeVisible();
  // A submit from an earlier visit is still waiting in this tab; connecting from settings is
  // not that submit, so returning here must not spend it.
  await page.evaluate(
    ([promptKey, submitKey, prompt]) => {
      window.sessionStorage.setItem(promptKey, prompt);
      window.sessionStorage.setItem(submitKey, prompt);
    },
    [PENDING_PROMPT_STORAGE_KEY, PENDING_SUBMIT_STORAGE_KEY, PROMPT] as const,
  );
  await page.getByRole('button', { name: 'Connect Cloudflare' }).click();

  await expect(page.getByPlaceholder(/Describe your app/i)).toHaveValue(PROMPT);
  await expect(page.getByText('Preparing your Cloudflare workspace')).toHaveCount(0);
  await assertClean();
});
