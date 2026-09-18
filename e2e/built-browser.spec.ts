import { expect, test } from '@playwright/test';
import { HOME_HEADING, TRUST_PAGE_HEADINGS } from '~/lib/trust';
import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';
import { collectBrowserDiagnostics } from './browser-diagnostics';

test('hydrates the built landing page without replacing meaningful SSR content', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await page.setViewportSize({ width: 320, height: 800 });

  await page.goto('/');

  await expect(page).toHaveTitle(/CloudChef/);
  // Asserted against the constant, not a copy of it: this gate exists to prove SSR content
  // survives hydration, and a transcribed sentence turns every wording change into a red build
  // that `validate` cannot see, because the browser gate runs outside it.
  await expect(page.getByText(HOME_HEADING, { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder(/Describe your app/i)).toBeVisible();
  // The builder model selector belongs to a connected session, so the signed-out
  // landing page must offer the connect action instead.
  await expect(page.getByRole('button', { name: /Builder model/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect Cloudflare' }).first()).toBeVisible();
  const legalNotice = page.getByTestId('cloudflare-connect-legal-notice');
  await expect(legalNotice).toBeVisible();
  await expect(legalNotice.getByRole('link', { name: 'Terms' })).toBeVisible();
  expect(await page.locator('header').evaluate((header) => header.scrollWidth <= header.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await assertClean();
});

test('renders signed-out private routes after browser hydration', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /Connect Cloudflare to open settings/i })).toBeVisible();
  // Never a bounce into Cloudflare's consent screen: the route that asks for eight permissions
  // states the plan requirement here first, exactly as the composer does.
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('cloudflare-connect-legal-notice')).toContainText('Workers Paid required.');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex,\s*nofollow/);

  await page.goto('/chat/browser-smoke-project');
  await expect(page.getByRole('heading', { name: /Connect Cloudflare to open this project/i })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex,\s*nofollow/);
  await assertClean();
});

test('keeps the built 404 and mobile shell usable', async ({ page }, testInfo) => {
  // The reason phrase is absent over HTTP/2, so a deployed candidate reports `404 ()`
  // where the local HTTP/1.1 preview reports `404 (Not Found)`.
  const assertClean = collectBrowserDiagnostics(page, testInfo, [/status of 404 \(/]);

  const response = await page.goto('/does-not-exist');

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This page does not exist.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await assertClean();
});

test('renders the public trust routes and persists the telemetry choice', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  const routes = [
    ['/terms', TRUST_PAGE_HEADINGS.terms],
    ['/support', TRUST_PAGE_HEADINGS.support],
    ['/security', TRUST_PAGE_HEADINGS.security],
  ] as const;

  for (const [path, heading] of routes) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Trust and legal' }).getByRole('link', { name: heading, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await page.getByText('On this page', { exact: true }).click();
    const sectionLink = page.getByRole('navigation', { name: 'Page sections' }).getByRole('link').last();
    const sectionTitle = await sectionLink.innerText();
    await sectionLink.click();
    await expect(page.getByRole('heading', { name: sectionTitle, exact: true })).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
  }

  await page.goto('/terms');
  await expect(page.getByText(/CloudChef is operated by DOUS SOFTWARE INC\./)).toBeVisible();

  const securityTxt = await page.request.get('/.well-known/security.txt');
  expect(securityTxt.status()).toBe(200);
  expect(securityTxt.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(await securityTxt.text()).toContain(
    'Contact: https://github.com/ferdousbhai/cloud-chef/security/advisories/new',
  );

  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: TRUST_PAGE_HEADINGS.privacy, level: 1 })).toBeVisible();
  await expect(page.getByText(/DOUS SOFTWARE INC\..*is the controller for personal data/)).toBeVisible();
  await expect(page.getByText('Product telemetry is disabled on this browser.')).toBeVisible();

  await page.getByRole('button', { name: 'Allow telemetry' }).click();
  await expect(page.getByText('Product telemetry is enabled on this browser.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Product telemetry is enabled on this browser.')).toBeVisible();

  await page.getByRole('button', { name: 'Disable telemetry' }).click();
  await expect(page.getByText('Product telemetry is disabled on this browser.')).toBeVisible();
  await assertClean();
});

// A local contract fixture: no real account is connected or deleted.
test('keeps account details discoverable and clears a cancelled deletion', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        session: {
          id: 'settings-session',
          userId: 'settings-user',
          expiresAt: Date.now() + 86400000,
          createdAt: Date.now(),
        },
        user: { id: 'settings-user', name: 'Settings fixture', email: 'settings@example.invalid', image: null },
      },
    }),
  );
  await page.route('**/api/cloudflare/connection', (route) =>
    route.fulfill({
      json: {
        accountName: 'Test account',
        oauthScopeGrantStatus: 'full',
      },
    }),
  );
  let deletionRequests = 0;
  await page.route('**/api/account/delete', (route) => {
    deletionRequests += 1;
    return route.fulfill({ status: 400, json: { error: 'Fixture: deletion is disabled.' } });
  });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Your data' })).toBeVisible();
  await expect(page.getByText('Your Cloudflare resources remain live and billable.')).toBeVisible();
  const exportDetails = page.locator('details').filter({ hasText: 'What’s included?' });
  await expect(exportDetails).not.toHaveAttribute('open', '');
  await exportDetails.locator('summary').click();
  await expect(exportDetails.getByText(/Chats, transcripts/)).toBeVisible();

  const openDeletion = page.getByRole('button', { name: 'Delete account data' });
  await openDeletion.click();
  const confirm = page.getByRole('button', { name: 'Permanently delete', exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByRole('checkbox').check();
  await page.getByLabel('Deletion confirmation phrase').fill(ACCOUNT_DELETION_CONFIRMATION);
  await expect(confirm).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openDeletion.click();
  await expect(confirm).toBeDisabled();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByLabel('Deletion confirmation phrase')).toHaveValue('');
  expect(deletionRequests).toBe(0);
  const cards = page.locator('section.app-card');
  await expect(cards).toHaveCount(3);
  // Classic scrollbars can leave only 310 CSS pixels inside a 320px window.
  for (const width of [1280, 320, 310]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
    expect(
      await cards.evaluateAll((sections) => sections.every((section) => section.scrollWidth <= section.clientWidth)),
    ).toBe(true);
  }
  await assertClean();
});
