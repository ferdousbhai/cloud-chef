import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import type { ChatHistorySummary, ProjectCloneAccess, ProjectCommit } from '~/lib/cloudflare/data-api';
import type { TeamProject } from '~/lib/cloudflare/org-projects.client';
import { DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { authSession } from './auth-session';
import { collectBrowserDiagnostics } from './browser-diagnostics';

// Contract doubles, never a Cloudflare account: the signed-in home reads the person's projects from the
// workspace runtime and their team projects from the Worker, and both are stubbed here.
const RUNTIME_ORIGIN = 'https://e2e-projects-fixture.workers.dev';
const SITE_ORIGIN = 'https://e2e-booking-site.workers.dev';
const dataRequestSchema = z.object({ path: z.string() });

const ownProjects: ChatHistorySummary[] = [
  {
    id: 'chat-booking',
    initialId: 'chat-booking',
    description: 'Booking site',
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    productionUrl: `${SITE_ORIGIN}/`,
  },
  {
    id: 'chat-draft',
    initialId: 'chat-draft',
    description: 'Recipe planner',
    timestamp: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

const commits: ProjectCommit[] = [
  {
    hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    message: 'Add a booking form\n\nCloudChef-Revision: 4f1c',
    author: { name: 'E2E fixture', email: 'e2e@example.invalid' },
    committedAt: Math.floor(Date.now() / 1_000) - 1_800,
  },
  {
    hash: '0f9e8d7c6b5a4938271605f4e3d2c1b0a9876543',
    message: 'First publish',
    author: { name: 'E2E fixture', email: 'e2e@example.invalid' },
    committedAt: Math.floor(Date.now() / 1_000) - 86_400,
  },
];

const cloneAccess: ProjectCloneAccess = {
  remote: 'https://e2e.artifacts.cloudflare.net/git/cloudchef/p-chat-booking.git',
  token: 'e2e-read-token',
  expiresAt: Date.now() + 3_600_000,
  command:
    'git clone https://x:e2e-read-token@e2e.artifacts.cloudflare.net/git/cloudchef/p-chat-booking.git booking-site',
};

async function stubSignedIn(page: Page, context: WorkspaceContext, teamProjects: TeamProject[] = []) {
  const session: CloudflareAuthSession = { ...authSession, context, contexts: [context] };
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: session }));
  await page.route('**/api/cloudflare/runtime-session', (route) =>
    route.fulfill({ json: { endpoint: RUNTIME_ORIGIN, token: 'e2e-capability', expiresAt: Date.now() + 600_000 } }),
  );
  await page.route('**/api/org-projects', (route) => route.fulfill({ json: { projects: teamProjects } }));
  // The prompt's model selector reads the account's catalog from the same runtime.
  await page.route(`${RUNTIME_ORIGIN}/v1/models`, (route) =>
    route.fulfill({ json: { defaultModelId: DEFAULT_WORKERS_AI_MODEL.id, models: [DEFAULT_WORKERS_AI_MODEL] } }),
  );
  await page.route(`${RUNTIME_ORIGIN}/v1/data`, async (route) => {
    const { path } = dataRequestSchema.parse(route.request().postDataJSON());
    const result =
      path === 'messages.getAll'
        ? ownProjects
        : path === 'projects.history'
          ? commits
          : path === 'projects.cloneAccess'
            ? cloneAccess
            : null;
    return route.fulfill({ json: { result } });
  });
  await page.route(`${SITE_ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Booking</title><body style="font:48px system-ui;padding:48px">Book a table</body>',
    }),
  );
}

test('lists the signed-in person’s projects below the prompt, with their history and clone command', async ({
  page,
}, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await stubSignedIn(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' });

  await page.goto('/');

  await expect(page.getByPlaceholder(/Describe your app/i)).toBeVisible();
  const projects = page.getByRole('region', { name: 'My projects' });
  const booking = projects.getByRole('listitem').filter({ hasText: 'Booking site' });
  await expect(booking.getByRole('link', { name: 'Edit Booking site' })).toHaveAttribute('href', '/chat/chat-booking');
  await expect(booking.getByRole('link', { name: 'Open site: Booking site' })).toHaveAttribute(
    'href',
    `${SITE_ORIGIN}/`,
  );
  await expect(booking.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  const draft = projects.getByRole('listitem').filter({ hasText: 'Recipe planner' });
  await expect(draft.getByRole('link', { name: /Open site/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import from GitHub' })).toBeVisible();

  await booking.getByRole('button', { name: 'More for Booking site' }).click();
  await page.getByRole('menuitem', { name: 'History' }).click();
  const history = page.getByRole('dialog', { name: 'History' });
  await expect(history.getByText('Add a booking form')).toBeVisible();
  await expect(history.getByRole('button', { name: 'Make a copy from 0f9e8d7' })).toBeVisible();
  await expect(history.getByRole('button', { name: 'Download ZIP of a1b2c3d' })).toBeVisible();
  await history.getByRole('button', { name: 'Close dialog' }).click();

  await booking.getByRole('button', { name: 'More for Booking site' }).click();
  await page.getByRole('menuitem', { name: 'Clone' }).click();
  const clone = page.getByRole('dialog', { name: 'Clone' });
  await expect(clone.getByLabel('Clone command')).toHaveText(cloneAccess.command);
  await clone.getByRole('button', { name: 'Close dialog' }).click();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await assertClean();
});

test('shows a team member the projects shared with them, and Edit only where they can edit', async ({
  page,
}, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await stubSignedIn(
    page,
    {
      kind: 'organization',
      connectionId: 'e2e-team-connection',
      accountName: 'Team account',
      orgId: 'e2e-org',
      orgName: 'E2E team',
      role: 'member',
      draftsAllowed: true,
    },
    [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Storefront', role: 'edit', repo: 't-storefront' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Handbook', role: 'view', repo: 't-handbook' },
    ],
  );

  await page.goto('/');

  const shared = page.getByRole('region', { name: 'Shared with me' });
  await expect(shared.getByRole('button', { name: 'Edit Storefront' })).toBeVisible();
  const handbook = shared.getByRole('listitem').filter({ hasText: 'Handbook' });
  await expect(handbook).toContainText('Can view');
  await expect(handbook.getByRole('button', { name: /Edit/ })).toHaveCount(0);
  await handbook.getByRole('button', { name: 'More for Handbook' }).click();
  await expect(page.getByRole('menuitem', { name: 'Download ZIP' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Clone' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Share' })).toHaveCount(0);
  await assertClean();
});
