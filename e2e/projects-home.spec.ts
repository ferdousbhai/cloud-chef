import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import type { WorkspaceSummary, ProjectCommit, ProjectGitAddress } from '~/lib/cloudflare/data-api';
import type { Approval, Approvals } from '~/lib/cloudflare/approvals.client';
import type { PublicProject, TeamProject } from '~/lib/cloudflare/org-projects.client';
import { DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { authSession } from './auth-session';
import { collectBrowserDiagnostics } from './browser-diagnostics';

// Contract doubles, never a Cloudflare account: the signed-in home reads the person's projects from the
// workspace runtime and their team projects from the Worker, and both are stubbed here.
const RUNTIME_ORIGIN = 'https://e2e-projects-fixture.workers.dev';
const SITE_ORIGIN = 'https://e2e-booking-site.workers.dev';
const dataRequestSchema = z.object({ path: z.string() });
const reuseRequestSchema = z.object({ installationId: z.number() });

const ownProjects: WorkspaceSummary[] = [
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

const gitAddress: ProjectGitAddress = { projectId: 'chat-booking' };

async function stubSignedIn(page: Page, context: WorkspaceContext, teamProjects: TeamProject[] = []) {
  const session: CloudflareAuthSession = { ...authSession, context, contexts: [context] };
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: session }));
  await page.route('**/api/cloudflare/runtime-session', (route) =>
    route.fulfill({ json: { endpoint: RUNTIME_ORIGIN, token: 'e2e-capability', expiresAt: Date.now() + 600_000 } }),
  );
  await page.route('**/api/org-projects', (route) => route.fulfill({ json: { projects: teamProjects } }));
  // CloudChef's record of the person's apps; none yet, so their cards have no public or copy choices.
  await page.route('**/api/apps', (route) => route.fulfill({ json: { apps: [] } }));
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
          : path === 'projects.gitAddress'
            ? gitAddress
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
  await page.getByRole('button', { name: 'Add an existing project' }).click();
  await expect(page.getByRole('menuitem', { name: 'Import from GitHub' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Upload a ZIP' })).toBeVisible();
  await page.keyboard.press('Escape');

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
  // Through CloudChef's own address, which checks who is asking each time: no token in the command.
  await expect(clone.getByLabel('cloudchef command', { exact: true })).toHaveText('cloudchef repo clone chat-booking');
  const origin = new URL(page.url()).origin;
  await expect(clone.getByLabel('git command', { exact: true })).toHaveText(`git clone ${origin}/git/chat-booking.git`);
  await page.screenshot({ path: testInfo.outputPath('clone.png'), fullPage: true });
  await clone.getByRole('button', { name: 'Close dialog' }).click();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await assertClean();
});

test('lists every project in one sidebar list, under the space they are in', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await stubSignedIn(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' }, [
    {
      id: 'project-glossary',
      name: 'alberta-plan-glossary',
      role: 'edit',
      repo: 't-project-glossary',
      createdAt: new Date(Date.now() - 1_800_000).toISOString(),
    },
  ]);

  await page.goto('/');
  await page.getByRole('button', { name: 'Open project menu' }).click();
  const sidebar = page.getByRole('complementary', { name: 'Projects' });
  // An imported project is listed with the ones made here, by when each was added: no separate heading.
  await expect(sidebar.getByRole('heading')).toHaveText(['Projects']);
  await expect(sidebar).toContainText('3 projects');
  await expect(sidebar.getByRole('button', { name: /alberta-plan-glossary/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /Booking site/ })).toBeVisible();
  // The space and the pages beyond the projects are here, not in the header.
  await expect(sidebar.getByRole('button', { name: /^Personal · Test account/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Explore' })).toBeVisible();
  await expect(page.locator('header').getByRole('link', { name: 'Explore' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('sidebar.png') });
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
  // Cloning only reads it, through CloudChef's own git address, as Download ZIP does.
  await expect(page.getByRole('menuitem', { name: 'Clone' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Share' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
  await assertClean();
});

test('lists public projects in Explore, with their sites and a way to make a copy', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await stubSignedIn(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' });
  const publicProjects: PublicProject[] = [
    {
      kind: 'project',
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Booking site',
      fullName: 'grace/booking-site',
      owner: { username: 'grace', name: 'Grace Hopper' },
      siteUrl: `${SITE_ORIGIN}/`,
      siteFrameable: true,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      copiedFrom: { fullName: 'ada/booking' },
    },
  ];
  await page.route('**/api/explore', (route) => route.fulfill({ json: { projects: publicProjects } }));

  await page.goto('/');
  // Explore is in the projects sidebar, under the list.
  await page.getByRole('button', { name: 'Open project menu' }).click();
  await page.getByRole('link', { name: 'Explore' }).click();

  await expect(page).toHaveURL(/\/explore$/);
  await expect(page).toHaveTitle('Explore | CloudChef');
  const booking = page.getByRole('listitem').filter({ hasText: 'grace/booking-site' });
  await expect(booking).toContainText('By Grace Hopper');
  await expect(booking).toContainText('Copied from ada/booking');
  await expect(booking.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(booking.getByRole('link', { name: 'Open site: grace/booking-site' })).toHaveAttribute(
    'href',
    `${SITE_ORIGIN}/`,
  );
  await booking.getByRole('button', { name: 'Make a copy of grace/booking-site' }).click();
  const dialog = page.getByRole('dialog', { name: 'Make a copy' });
  await expect(dialog.getByRole('textbox')).toHaveValue('Booking site');
  await expect(dialog).toContainText('Personal');
  await page.screenshot({ path: testInfo.outputPath('explore.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await assertClean();
});

test("shows a team admin what their members asked for, from the sidebar's Approvals link", async ({
  page,
}, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await stubSignedIn(page, {
    kind: 'organization',
    connectionId: 'e2e-team-connection',
    accountName: 'Team account',
    orgId: 'e2e-org',
    orgName: 'Sites',
    role: 'admin',
    draftsAllowed: true,
  });
  const change: Approval = {
    id: '00000000-0000-4000-8000-000000000010',
    orgId: 'e2e-org',
    orgName: 'Sites',
    kind: 'cloudflare_change',
    source: 'agent',
    requester: { name: 'Sara', email: 'sara@example.invalid' },
    request: {
      method: 'POST',
      url: 'https://api.cloudflare.com/client/v4/accounts/e2e-account/workers/domains',
      body: { hostname: 'shop.example.com', service: 'shop', environment: 'production' },
    },
    warning: 'This puts shop.example.com on the Worker shop. Anyone visiting shop.example.com will see that site.',
    status: 'pending',
    result: null,
    outcome: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: Date.now() - 20 * 60_000,
    expiresAt: Date.now() + 86_400_000,
  };
  const approvals: Approvals = {
    admin: true,
    waiting: [change],
    decided: [
      {
        ...change,
        id: '00000000-0000-4000-8000-000000000011',
        request: {
          method: 'DELETE',
          url: 'https://api.cloudflare.com/client/v4/accounts/e2e-account/workers/scripts/old',
        },
        warning: null,
        status: 'done',
        result: 'succeeded',
        outcome: { summary: 'Cloudflare applied the approved request.' },
        decidedBy: 'Ada',
        decidedAt: Date.now() - 2 * 3_600_000,
      },
    ],
    productionRequests: [
      {
        id: 'request-1',
        orgId: 'e2e-org',
        orgName: 'Sites',
        title: 'Recipe planner',
        note: 'Ready for the family to use.',
        previewUrl: `${SITE_ORIGIN}/`,
        requesterName: 'Sara',
        requesterEmail: 'sara@example.invalid',
        createdAt: Date.now() - 3 * 86_400_000,
        updatedAt: null,
      },
    ],
  };
  await page.route('**/api/approvals', (route) => route.fulfill({ json: approvals }));

  await page.goto('/');
  // The sidebar's button says approvals are waiting; the sidebar links to them.
  await page.getByRole('button', { name: 'Open project menu (2 waiting for approval)' }).click();
  await page.getByRole('link', { name: 'Approvals (2)' }).click();

  await expect(page).toHaveURL(/\/approvals$/);
  await expect(page).toHaveTitle('Approvals | CloudChef');
  const waiting = page.getByRole('region', { name: 'Waiting' });
  await expect(waiting).toContainText('Sites · from Sara · 20 min ago');
  await expect(waiting).toContainText('Create /accounts/e2e-account/workers/domains');
  await expect(waiting).toContainText('Recipe planner');
  await expect(page.getByRole('region', { name: 'Decided' })).toContainText(
    'Approved by Ada, and Cloudflare made the change',
  );
  await page.screenshot({ path: testInfo.outputPath('approvals.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await assertClean();
});

test('deletes a project only after listing what goes with it and having its name typed', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await stubSignedIn(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' }, [
    {
      id: '00000000-0000-4000-8000-000000000020',
      name: 'Booking site',
      fullName: 'ada/booking-site',
      role: 'edit',
      repo: 't-booking',
      visibility: 'private',
      canManage: true,
      siteUrl: `${SITE_ORIGIN}/`,
    },
  ]);
  await page.route('**/api/projects/delete/preview', (route) =>
    route.fulfill({
      json: {
        sites: [`${SITE_ORIGIN}/`],
        workers: ['booking-site'],
        buildTriggers: ['trigger-main'],
        resources: [
          { kind: 'database', id: 'db-1', name: 'booking-data' },
          { kind: 'storage', id: 'booking-photos', name: 'booking-photos' },
        ],
        kept: [{ kind: 'storage', id: 'shared-logos', name: 'shared-logos', reason: 'another Worker uses it' }],
        repository: 't-booking',
      },
    }),
  );
  const deletions: unknown[] = [];
  await page.route('**/api/projects/delete', (route) => {
    deletions.push(route.request().postDataJSON());
    return route.fulfill({ json: { deleted: ['Worker booking-site'] } });
  });

  await page.goto('/');
  const booking = page.getByRole('listitem').filter({ hasText: 'ada/booking-site' });
  await booking.getByRole('button', { name: 'More for ada/booking-site' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const dialog = page.getByRole('dialog', { name: 'Delete Booking site?' });
  await expect(dialog).toContainText('can’t be undone');
  await expect(dialog).toContainText('Database booking-data');
  await expect(dialog).toContainText('Its automatic builds from its code');
  await expect(dialog).toContainText('File storage shared-logos: another Worker uses it');
  const confirm = dialog.getByRole('button', { name: 'Delete' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox').fill('Booking');
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('textbox').fill('Booking site');
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('delete-project.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );

  await confirm.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('ada/booking-site')).toHaveCount(0);
  expect(deletions).toEqual([{ projectId: '00000000-0000-4000-8000-000000000020', confirm: 'Booking site' }]);
  await assertClean();
});

declare global {
  interface Window {
    /** What the page registered with the stand-in WebMCP below, by name. */
    webMcpTools?: Map<string, WebMcpTool>;
  }
}

const listedSchema = z.object({ account: z.string(), projects: z.array(z.object({ name: z.string() })) });
const publishSchema = z.object({
  latestPublish: z.object({ state: z.string(), failedAt: z.string().nullable(), reason: z.string().nullable() }),
  log: z.string().nullable(),
});

test('offers an in-browser agent WebMCP tools that read projects, and fill in a new project for the person to send', async ({
  page,
}, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  const projectId = '00000000-0000-4000-8000-000000000030';
  await stubSignedIn(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' }, [
    {
      id: projectId,
      name: 'Storefront',
      fullName: 'ada/storefront',
      role: 'edit',
      repo: 't-storefront',
      deploysWith: 'cloudchef',
      deployment: {
        id: '00000000-0000-4000-8000-0000000000d1',
        state: 'failed',
        failureStage: 'build',
        reason: 'The build failed.',
        updatedAt: Date.now(),
      },
    },
  ]);
  await page.route(`${RUNTIME_ORIGIN}/v1/projects/deploy-log?*`, (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'src/main.ts(3,1): error TS1005' }),
  );
  // A stand-in for the browser's WebMCP: it keeps what the page registers, as an agent would see it.
  await page.addInitScript(() => {
    const tools = new Map<string, WebMcpTool>();
    window.webMcpTools = tools;
    const modelContext: WebMcpModelContext = {
      registerTool(tool, options) {
        tools.set(tool.name, tool);
        options?.signal?.addEventListener('abort', () => tools.delete(tool.name));
      },
    };
    Object.defineProperty(document, 'modelContext', { value: modelContext });
  });
  const registered = () => page.evaluate(() => [...(window.webMcpTools?.keys() ?? [])].sort());
  const call = (name: string, input: WebMcpToolInput = {}) =>
    page.evaluate(
      // The input crosses into the page as JSON text, as an agent's arguments do.
      async ({ toolName, toolInput }) => {
        const tool = window.webMcpTools?.get(toolName);
        const parsed: WebMcpToolInput = JSON.parse(toolInput);
        return tool ? (await tool.execute(parsed)).content.map((part) => part.text).join('\n') : 'missing';
      },
      { toolName: name, toolInput: JSON.stringify(input) },
    );

  await page.goto('/');
  await expect(page.getByPlaceholder(/Describe your app/i)).toBeVisible();
  await expect
    .poll(registered)
    .toEqual([
      'get_publish',
      'list_approvals',
      'list_projects',
      'list_public_projects',
      'open_project',
      'start_project',
    ]);

  const listed = listedSchema.parse(JSON.parse(await call('list_projects')));
  expect(listed.account).toBe('Personal');
  expect(listed.projects.map((project) => project.name)).toEqual(['Storefront', 'Booking site', 'Recipe planner']);
  const publish = publishSchema.parse(JSON.parse(await call('get_publish', { projectId, includeLog: true })));
  expect(publish.latestPublish).toEqual({ state: 'failed', failedAt: 'build', reason: 'The build failed.' });
  expect(publish.log).toContain('error TS1005');
  expect(await call('get_publish', { projectId: 'nope' })).toContain('No project with that id');

  // Starting a project only fills in the message box: the person sends it.
  await call('start_project', { prompt: 'A sign-up page for the spring fair' });
  await expect(page).toHaveURL(/prefill=/);
  await expect(page.getByPlaceholder(/Describe your app/i)).toHaveValue('A sign-up page for the spring fair');
  await page.screenshot({ path: testInfo.outputPath('webmcp-start-project.png') });
  await assertClean();
});

for (const theme of ['dark', 'light'] as const) {
  test(`offers the person's own GitHub account, connected in another space, in the import dialog (${theme})`, async ({
    page,
  }, testInfo) => {
    const assertClean = collectBrowserDiagnostics(page, testInfo);
    // The page's own frame only: the project cards' sandboxed site previews have no storage.
    await page.addInitScript((chosen) => {
      if (window === window.top) {
        localStorage.setItem('cloudchef_theme', chosen);
      }
    }, theme);
    await stubSignedIn(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' });
    // Nothing connected in Personal; the App is on the person's own GitHub account, connected from their team.
    await page.route('**/api/organizations/github/repositories', (route) =>
      route.fulfill({
        json: { repositories: [], unreachable: [], reusable: [{ installationId: 4242, accountLogin: 'ferdousbhai' }] },
      }),
    );
    const reused: number[] = [];
    await page.route('**/api/organizations/github/reuse', (route) => {
      reused.push(reuseRequestSchema.parse(route.request().postDataJSON()).installationId);
      return route.fulfill({
        status: 201,
        json: { authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=e2e&state=e2e-state' },
      });
    });
    await page.route('https://github.com/login/oauth/authorize**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Authorize</title><p>GitHub</p>' }),
    );

    await page.goto('/');
    await page.getByRole('button', { name: 'Add an existing project' }).click();
    await page.getByRole('menuitem', { name: 'Import from GitHub' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import from GitHub' });
    await expect(
      dialog.getByText(
        "The App is already on your GitHub account (ferdousbhai). CloudChef will ask GitHub to confirm it's you, then you can import from it here too.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Install/ })).toHaveCount(0);
    await expect(page.locator('html')).toHaveClass(theme);
    await dialog.screenshot({ path: testInfo.outputPath(`import-github-reuse-${theme}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`import-github-reuse-${theme}-page.png`) });
    await assertClean();

    await dialog.getByRole('button', { name: 'Use my GitHub account here' }).click();
    await expect(page).toHaveURL(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    expect(reused).toEqual([4242]);
  });
}
