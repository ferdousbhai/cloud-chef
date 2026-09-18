import { expect, test, type Page } from '@playwright/test';
import { collectBrowserDiagnostics } from './browser-diagnostics';

// Contract doubles, never a Cloudflare account: these tests stub the two Worker
// endpoints the browser needs before it can reach the user-owned runtime, then
// prove the recovery surfaces the product renders for each typed failure.
const RUNTIME_SESSION_ROUTE = '**/api/cloudflare/runtime-session';
// The Worker's connect-src policy only allows workers.dev origins, so the
// runtime double has to look like a real user-owned runtime.
const RUNTIME_ORIGIN = 'https://e2e-recovery-fixture.workers.dev';
const authSession = {
  session: { id: 'e2e-session', userId: 'e2e-user', expiresAt: Date.now() + 86_400_000, createdAt: Date.now() },
  user: { id: 'e2e-user', name: 'Recovery fixture', email: 'recovery@example.invalid', image: null },
};

async function stubConnectedSession(page: Page) {
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: authSession }));
}

async function startProject(page: Page) {
  await page.goto('/');
  await page.getByPlaceholder(/Describe your app/i).fill('Build a launch checklist.');
  await page.getByRole('button', { name: 'Send' }).click();
}

test('retries a workspace runtime that failed to prepare', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, [/user-owned runtime/, /status of 502/]);
  await stubConnectedSession(page);
  let attempts = 0;
  await page.route(RUNTIME_SESSION_ROUTE, (route) => {
    attempts += 1;
    return route.fulfill({
      status: 502,
      json: { code: 'workspace_preparation_failed', error: 'Cloudflare could not create your workspace.' },
    });
  });

  await startProject(page);

  await expect(page.getByRole('heading', { name: 'CloudChef could not prepare your workspace.' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Cloudflare could not create your workspace.');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => attempts).toBeGreaterThan(1);
  await assertClean();
});

test('explains the Cloudflare action each typed workspace failure needs', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, [
    /user-owned runtime/,
    /status of 409/,
    /status of 503/,
  ]);
  await stubConnectedSession(page);
  await page.route(RUNTIME_SESSION_ROUTE, (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: 'workspace_plan_required',
        error: 'Cloudflare Containers requires the Workers Paid plan.',
        upgradeUrl: 'https://dash.cloudflare.com/?to=/:account/workers/plans',
      },
    }),
  );

  await startProject(page);

  await expect(page.getByRole('alert')).toContainText('Workers Paid plan');
  // The destination is the one Cloudflare named in its own refusal, not a guess by the product.
  await expect(page.getByRole('link', { name: 'Open Workers plan' })).toHaveAttribute(
    'href',
    'https://dash.cloudflare.com/?to=/:account/workers/plans',
  );
  await expect(page.getByRole('link', { name: 'Reauthorize Cloudflare' })).toHaveCount(0);

  // An eligibility answer CloudChef could not read must not be dressed up as a plan refusal.
  await page.unroute(RUNTIME_SESSION_ROUTE);
  await page.route(RUNTIME_SESSION_ROUTE, (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: 'workspace_eligibility_unknown',
        error: 'CloudChef could not reach Cloudflare to confirm that this account can run Containers.',
      },
    }),
  );
  await page.getByRole('button', { name: 'Try again' }).click();

  await expect(page.getByRole('alert')).toContainText('could not reach Cloudflare to confirm');
  await expect(page.getByRole('link', { name: 'Open Workers plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  await page.unroute(RUNTIME_SESSION_ROUTE);
  await page.route(RUNTIME_SESSION_ROUTE, (route) =>
    route.fulfill({
      status: 409,
      json: {
        code: 'cloudflare_reauthorization_required',
        error: 'CloudChef needs updated Cloudflare permissions for this workspace.',
      },
    }),
  );
  await page.getByRole('button', { name: 'Try again' }).click();

  await expect(page.getByRole('alert')).toContainText('updated Cloudflare permissions');
  await expect(page.getByRole('link', { name: 'Reauthorize Cloudflare' })).toBeVisible();
  await assertClean();
});

test('keeps waiting for the workspace after a reload during preparation', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, [/status of 409/]);
  await stubConnectedSession(page);
  let attempts = 0;
  await page.route(RUNTIME_SESSION_ROUTE, (route) => {
    attempts += 1;
    return route.fulfill({
      status: 409,
      json: { code: 'workspace_preparing', error: 'CloudChef is still preparing your workspace.' },
    });
  });

  await page.goto('/chat/recovery-fixture-project');
  // Named, not a bare spinner and never a timeout: the wait is provisioning, which takes minutes.
  await expect(page.getByText('Preparing your Cloudflare workspace. This takes a few minutes.')).toBeVisible();

  const attemptsBeforeReload = attempts;
  await page.reload();

  await expect.poll(() => attempts).toBeGreaterThan(attemptsBeforeReload);
  await expect(page.getByText('Preparing your Cloudflare workspace. This takes a few minutes.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'CloudChef could not prepare your workspace.' })).toHaveCount(0);
  await assertClean();
});

test('recovers a project whose data operations fail', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, [/workspace runtime is unavailable|status of 503/]);
  await stubConnectedSession(page);
  await page.route(RUNTIME_SESSION_ROUTE, (route) =>
    route.fulfill({
      json: { endpoint: RUNTIME_ORIGIN, token: 'e2e-capability', expiresAt: Date.now() + 600_000 },
    }),
  );
  let attempts = 0;
  await page.route(`${RUNTIME_ORIGIN}/v1/data`, (route) => {
    attempts += 1;
    return route.fulfill({ status: 503, json: { error: 'The workspace runtime is unavailable.' } });
  });

  await page.goto('/chat/recovery-fixture-project');

  await expect(page.getByRole('heading', { name: 'CloudChef could not load this project.' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('The workspace runtime is unavailable.');
  const requestsBeforeRetry = attempts;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => attempts).toBeGreaterThan(requestsBeforeRetry);
  await assertClean();
});
