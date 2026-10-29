import { expect, test } from '@playwright/test';
import { HOME_HEADING, TRUST_PAGE_HEADINGS } from '~/lib/trust';
import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';
import { DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { TRANSCRIPT_HISTORY_FORMAT_VERSION } from 'cloudchef-agent/transcript';
import { z } from 'zod';
import { authSession } from './auth-session';
import { collectBrowserDiagnostics } from './browser-diagnostics';

/** A builder agent call as the browser sends it over the agent's socket. */
const rpcRequestSchema = z.object({ type: z.literal('rpc'), id: z.string(), method: z.string() });

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
  await expect(page.getByRole('heading', { name: /Sign in to open settings/i })).toBeVisible();
  // Never a bounce into Cloudflare's consent screen: the route that asks for eight permissions
  // states the plan requirement here first, beside the button that goes there.
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText("Needs Cloudflare's Workers Paid plan.")).toBeVisible();
  await expect(page.getByTestId('cloudflare-connect-legal-notice')).toContainText(
    'By continuing, you agree to the Terms and Privacy notice.',
  );
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
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: authSession }));
  await page.route('**/api/cloudflare/connection', (route) =>
    route.fulfill({
      json: { accountName: 'Test account' },
    }),
  );
  // Every card a signed-in member's settings load, answered as for a member with no teams and no keys yet.
  await page.route('**/api/settings/models', (route) =>
    route.fulfill({
      json: { canManage: true, defaultModelId: null, allowedModelIds: null, keys: { status: 'ready', providers: [] } },
    }),
  );
  await page.route('**/api/settings/ai-gateway-logging', (route) => route.fulfill({ json: { contentLogging: true } }));
  await page.route('**/api/organizations', (route) => route.fulfill({ json: { organizations: [] } }));
  await page.route('**/api/settings/command-line-tokens', (route) => route.fulfill({ json: { tokens: [] } }));
  // The Models card lists the account's catalog, which its workspace runtime serves. The Worker's
  // connect-src policy only allows workers.dev origins, so the double looks like a user-owned runtime.
  const runtimeOrigin = 'https://e2e-settings-fixture.workers.dev';
  await page.route('**/api/cloudflare/runtime-session', (route) =>
    route.fulfill({ json: { endpoint: runtimeOrigin, token: 'e2e-capability', expiresAt: Date.now() + 600_000 } }),
  );
  await page.route(`${runtimeOrigin}/v1/models`, (route) =>
    route.fulfill({ json: { defaultModelId: DEFAULT_WORKERS_AI_MODEL.id, models: [DEFAULT_WORKERS_AI_MODEL] } }),
  );
  await page.route(`${runtimeOrigin}/v1/models/compatible`, (route) =>
    route.fulfill({ json: { models: [DEFAULT_WORKERS_AI_MODEL] } }),
  );
  let deletionRequests = 0;
  await page.route('**/api/account/delete', (route) => {
    deletionRequests += 1;
    return route.fulfill({ status: 400, json: { error: 'Fixture: deletion is disabled.' } });
  });
  await page.goto('/settings');
  // Settings opens on Account; each tab shows its own cards.
  await expect(page.getByRole('heading', { name: 'Cloudflare account' })).toBeVisible();
  // The theme is chosen here, not in the header: dark until another is picked, and the page follows the choice.
  const theme = page.getByRole('radiogroup', { name: 'Theme' });
  await expect(theme.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveClass('dark');
  await page.getByRole('heading', { name: 'Appearance' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('appearance.png') });
  await theme.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveClass('light');
  await page.getByRole('tab', { name: 'Models' }).click();
  await expect(
    page.getByRole('region').filter({ has: page.getByRole('heading', { name: 'Models', exact: true }) }),
  ).toContainText(DEFAULT_WORKERS_AI_MODEL.label);
  await page.getByRole('tab', { name: 'Privacy & data' }).click();
  await expect(page).toHaveURL(/#data$/);
  await expect(page.getByRole('heading', { name: 'Your data' })).toBeVisible();
  // The member's own cards loaded as theirs, not as a signed-out visitor's.
  await expect(page.getByRole('checkbox', { name: 'Log my model requests in AI Gateway' })).toBeChecked();
  await expect(page.getByText('Sign in first.')).toHaveCount(0);
  const exportDetails = page.locator('details').filter({ hasText: 'What’s included?' });
  await expect(exportDetails).not.toHaveAttribute('open', '');
  await exportDetails.locator('summary').click();
  await expect(exportDetails.getByText(/Chats, transcripts/)).toBeVisible();

  const openDeletion = page.getByRole('button', { name: 'Delete account data' });
  await openDeletion.click();
  // What deletion leaves behind is said where it is confirmed.
  await expect(page.getByRole('dialog').getByText('Your Cloudflare resources remain live and billable.')).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Permanently delete', exact: true });
  await expect(confirm).toBeDisabled();
  const acknowledgement = page.getByRole('checkbox', { name: /I understand this is irreversible/ });
  await acknowledgement.check();
  await page.getByLabel('Deletion confirmation phrase').fill(ACCOUNT_DELETION_CONFIRMATION);
  await expect(confirm).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openDeletion.click();
  await expect(confirm).toBeDisabled();
  await expect(acknowledgement).not.toBeChecked();
  await expect(page.getByLabel('Deletion confirmation phrase')).toHaveValue('');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Escape closes it too, and no dialog follows a switch to another tab.
  await openDeletion.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Teams' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Privacy & data' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(deletionRequests).toBe(0);
  const cards = page.locator('section.app-card');
  // Account, Cloudflare account, Command line, Appearance, Models, AI request logs, Teams and Your data: every
  // card is measured below.
  await expect(cards).toHaveCount(8);
  // Classic scrollbars can leave only 310 CSS pixels inside a 320px window.
  for (const width of [1280, 320, 310]) {
    await page.setViewportSize({ width, height: 800 });
    for (const tab of ['Account', 'Teams', 'Models', 'Privacy & data']) {
      await page.getByRole('tab', { name: tab }).click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
      expect(
        await cards.evaluateAll((sections) => sections.every((section) => section.scrollWidth <= section.clientWidth)),
      ).toBe(true);
    }
  }
  await assertClean();
});

// A contract fixture: the runtime and its builder agent are doubles, answering as a runtime whose team
// project could not be imported.
test("says why a team project's workspace could not open, in the chat and the code view", async ({
  page,
}, testInfo) => {
  const failure = 'Connect GitHub again in Settings to import this project.';
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  const runtimeOrigin = 'https://e2e-team-project-fixture.workers.dev';
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: authSession }));
  await page.route('**/api/cloudflare/runtime-session', (route) =>
    route.fulfill({ json: { endpoint: runtimeOrigin, token: 'e2e-capability', expiresAt: Date.now() + 600_000 } }),
  );
  await page.route(`${runtimeOrigin}/v1/chats/messages`, (route) =>
    route.fulfill({
      json: {
        status: 'ready',
        version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
        initialId: 'team-project-chat',
        description: 'Ada site',
        transcript: { agentName: 'agent-team-project', subchatIndex: 0 },
        checkpoint: null,
        messages: [],
      },
    }),
  );
  await page.route(`${runtimeOrigin}/v1/models`, (route) =>
    route.fulfill({ json: { defaultModelId: DEFAULT_WORKERS_AI_MODEL.id, models: [DEFAULT_WORKERS_AI_MODEL] } }),
  );
  await page.route(`${runtimeOrigin}/v1/data`, (route) => route.fulfill({ json: { result: [] } }));
  let preparations = 0;
  await page.routeWebSocket(new RegExp(`^wss://${new URL(runtimeOrigin).host}/`), (socket) => {
    socket.send(
      JSON.stringify({
        type: 'cf_agent_state',
        state: { linkedProject: { repository: 'Ada site', defaultBranch: 'main' } },
      }),
    );
    socket.onMessage((raw) => {
      const message = rpcRequestSchema.safeParse(JSON.parse(String(raw)));
      if (!message.success) {
        return;
      }
      const preparing = message.data.method === 'prepareWorkspace';
      preparations += preparing ? 1 : 0;
      const result = preparing ? { initialized: false, failure } : null;
      socket.send(JSON.stringify({ type: 'rpc', id: message.data.id, success: true, result, done: true }));
    });
  });

  await page.goto('/chat/team-project-chat');

  await expect(page.getByText(`CloudChef could not open this project. ${failure}`)).toBeVisible();
  await page.getByRole('button', { name: 'Browse the code' }).click();
  const codeView = page.getByRole('complementary', { name: 'Project workbench' });
  await expect(codeView.getByRole('heading', { name: 'CloudChef could not open this project.' })).toBeVisible();
  await expect(codeView.getByRole('alert')).toHaveText(failure);
  // Answered once and not reconnected to: only the person's retry asks again.
  expect(preparations).toBe(1);
  await codeView.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => preparations).toBe(2);
  await assertClean();
});
