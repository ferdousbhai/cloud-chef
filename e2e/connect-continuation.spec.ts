import { expect, test, type Page } from '@playwright/test';
import { PENDING_PROMPT_STORAGE_KEY, PENDING_SUBMIT_STORAGE_KEY } from '~/utils/constants';
import { authSession } from './auth-session';
import { collectBrowserDiagnostics } from './browser-diagnostics';

// Connecting Cloudflare is never a goal in itself: it is what the product asks for before it
// can do what was already asked of it. These tests stub the authorization round trip and prove
// which returns finish that instruction and which must not. Someone signed in with nowhere to
// build chooses their own Cloudflare account from the dialog the submit opens.
const PROMPT = 'Build a launch checklist.';

/**
 * Authorizing at Cloudflare is a full page navigation back to CloudChef with a session, so
 * the connect start returns the origin itself and the session stub flips at the same moment.
 */
async function stubCloudflareAuthorization(page: Page, before: 'signed out' | 'no space' = 'signed out') {
  const connection = { authorized: false };
  const noSpace = { ...authSession, context: null, contexts: [] };
  await page.route('**/api/auth/session', (route) =>
    route.fulfill(
      connection.authorized
        ? { json: authSession }
        : before === 'no space'
          ? { json: noSpace }
          : { body: 'null', contentType: 'application/json' },
    ),
  );
  // The home lists the projects in the account it connects to; this one has none yet.
  await page.route('**/api/org-projects', (route) => route.fulfill({ json: { projects: [] } }));
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
  // Leaving for Cloudflare cancels the home's project list if it is still loading.
  const assertClean = collectBrowserDiagnostics(page, testInfo, [
    /status of 409/,
    /requestfailed: GET .*\/api\/org-projects$/,
  ]);
  await stubCloudflareAuthorization(page, 'no space');

  await page.goto('/');
  await page.getByPlaceholder(/Describe your app/i).fill(PROMPT);
  await page.getByRole('button', { name: 'Choose where to build' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use my Cloudflare account' }).click();

  // Back from Cloudflare, the prompt is not merely restored: the submit it belonged to runs.
  await expect(page.getByText('Preparing your Cloudflare workspace')).toBeVisible();
  await expect(page.getByPlaceholder(/Describe your app/i)).toHaveCount(0);
  await assertClean();
});

test('never starts a build for someone who connected from settings', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, [/status of 409/]);
  await stubCloudflareAuthorization(page);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /Sign in to open settings/i })).toBeVisible();
  // A submit from an earlier visit is still waiting in this tab; connecting from settings is
  // not that submit, so returning here must not spend it.
  await page.evaluate(
    ([promptKey, submitKey, prompt]) => {
      window.sessionStorage.setItem(promptKey, prompt);
      window.sessionStorage.setItem(submitKey, prompt);
    },
    [PENDING_PROMPT_STORAGE_KEY, PENDING_SUBMIT_STORAGE_KEY, PROMPT] as const,
  );
  await page.getByRole('button', { name: 'Sign in with Cloudflare' }).click();

  await expect(page.getByPlaceholder(/Describe your app/i)).toHaveValue(PROMPT);
  // The home's project list waits for the workspace to list what's in it; that's the only wait, and
  // no build's progress is shown.
  await expect(page.getByRole('region', { name: 'My projects' })).toContainText('Preparing your Cloudflare workspace');
  await expect(page.getByText('Preparing your Cloudflare workspace')).toHaveCount(1);
  await assertClean();
});
