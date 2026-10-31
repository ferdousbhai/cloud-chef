import { expect, test, type Page } from '@playwright/test';
import { z } from 'zod';
import type { CloudflareAuthSession, WorkspaceContext } from '~/lib/.server/auth';
import type { TeamProject } from '~/lib/cloudflare/org-projects.client';
import { DEFAULT_WORKERS_AI_MODEL, type BuilderModel } from '~/lib/workers-ai-model';
import { PENDING_PROMPT_STORAGE_KEY } from '~/utils/constants';
import { authSession } from './auth-session';

// The home loads in steps — the session, then the account's models, then the person's projects — and the
// heading and the prompt box stay where they first painted through all of them. The answers are delayed the way
// production gives them, so each step lands after the one before it has painted.
const SESSION_DELAY_MS = 300;
const MODELS_DELAY_MS = 800;
const PROJECTS_DELAY_MS = 1_000;
const RUNTIME_ORIGIN = 'https://e2e-steady-home.workers.dev';
// Set to a directory to keep a screenshot of the loading and the settled home.
const screenshotDirectory = process.env.STEADY_HOME_SCREENSHOTS;

const defaultModel: BuilderModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/zai-org/glm-5.3-flash',
  label: 'GLM 5.3 Flash',
  reasoningLevels: ['low', 'medium', 'high'],
};

const ownProjects: TeamProject[] = [
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Recipe planner',
    role: 'edit',
    repo: 't-recipes',
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

const teamProjects: TeamProject[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Storefront', role: 'edit', repo: 't-storefront' },
];

const frameSchema = z.object({
  heading: z.number().nullable(),
  composer: z.number().nullable(),
  composerHeight: z.number().nullable(),
});
const shiftSchema = z.object({ value: z.number(), sources: z.array(z.string()) });
const measurementSchema = z.object({ frames: z.array(frameSchema), shifts: z.array(shiftSchema) });

function delayed(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stubHome(page: Page, context: WorkspaceContext | null) {
  // A model this browser hasn't seen yet, so the new-models notice shows once the list arrives.
  await page.addInitScript(() => {
    localStorage.setItem('cloudchef_seen_builder_models_v1', JSON.stringify([]));
  });
  await page.route('**/api/auth/session', async (route) => {
    await delayed(SESSION_DELAY_MS);
    const session: CloudflareAuthSession | null = context ? { ...authSession, context, contexts: [context] } : null;
    await route.fulfill({ json: session });
  });
  await page.route('**/api/cloudflare/runtime-session', (route) =>
    route.fulfill({ json: { endpoint: RUNTIME_ORIGIN, token: 'e2e-capability', expiresAt: Date.now() + 600_000 } }),
  );
  await page.route('**/api/org-projects', async (route) => {
    await delayed(PROJECTS_DELAY_MS);
    await route.fulfill({ json: { projects: context?.kind === 'organization' ? teamProjects : ownProjects } });
  });
  await page.route(`${RUNTIME_ORIGIN}/v1/models`, async (route) => {
    await delayed(MODELS_DELAY_MS);
    await route.fulfill({
      json: { defaultModelId: defaultModel.id, models: [defaultModel, DEFAULT_WORKERS_AI_MODEL] },
    });
  });
  await page.route(`${RUNTIME_ORIGIN}/v1/data`, (route) => route.fulfill({ json: { result: null } }));
}

type Frame = z.infer<typeof frameSchema>;
type Shift = { value: unknown; sources: string[] };

declare global {
  interface Window {
    /** What `recordFrames` has seen so far, read back by `readMeasurement`. */
    steadyHome?: { frames: Frame[]; shifts: Shift[] };
  }
}

/** Records where the heading and the prompt box are on every frame, from before the first paint. */
async function recordFrames(page: Page) {
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    const shifts: Shift[] = [];
    window.steadyHome = { frames, shifts };
    const record = () => {
      const heading = document.querySelector('h1.cloudchef-home-title');
      const composer =
        document.querySelector('.cloudchef-message-input--home') ??
        document.querySelector('.cloudchef-home-composer-stack');
      const box = composer?.getBoundingClientRect();
      frames.push({
        heading: heading ? heading.getBoundingClientRect().top : null,
        composer: box ? box.top : null,
        composerHeight: box ? box.height : null,
      });
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // A layout shift names the elements that moved; each is recorded by its tag and classes.
        const moved: string[] = [];
        for (const source of 'sources' in entry && Array.isArray(entry.sources) ? entry.sources : []) {
          const node = source instanceof Object && 'node' in source ? source.node : null;
          moved.push(node instanceof Element ? `${node.tagName.toLowerCase()}.${node.className}` : 'text');
        }
        shifts.push({ value: 'value' in entry ? entry.value : null, sources: moved });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function readMeasurement(page: Page) {
  return measurementSchema.parse(await page.evaluate(() => window.steadyHome));
}

const states: { name: string; context: WorkspaceContext | null; settled: (page: Page) => Promise<void> }[] = [
  {
    name: 'signed out',
    context: null,
    settled: (page) => expect(page.getByRole('button', { name: 'Sign in', exact: true }).last()).toBeVisible(),
  },
  {
    name: 'signed in with projects',
    context: { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' },
    settled: async (page) => {
      await expect(page.getByText('New models:')).toBeVisible();
      await expect(page.getByRole('region', { name: 'My projects' }).getByText('Recipe planner')).toBeVisible();
    },
  },
  {
    name: 'signed in as a team member limited to team projects',
    context: {
      kind: 'organization',
      connectionId: 'e2e-team-connection',
      accountName: 'Team account',
      orgId: 'e2e-org',
      orgName: 'E2E team',
      role: 'member',
      draftsAllowed: false,
    },
    settled: (page) => expect(page.getByRole('button', { name: 'Edit Storefront' })).toBeVisible(),
  },
];

const schemes: ('light' | 'dark')[] = ['light', 'dark'];

for (const scheme of schemes) {
  for (const state of states) {
    test(`keeps the heading and the prompt still while the home loads, ${state.name}, ${scheme}`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stubHome(page, state.context);
      await recordFrames(page);
      const slug = `${testInfo.project.name}-${scheme}-${state.name.replaceAll(' ', '-')}`;

      await page.goto('/');
      await expect(page.locator('h1.cloudchef-home-title')).toBeVisible();
      if (screenshotDirectory) {
        await page.screenshot({ path: `${screenshotDirectory}/${slug}-loading.png` });
      }
      await state.settled(page);
      // Two more frames after the last answer has painted.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (screenshotDirectory) {
        await page.screenshot({ path: `${screenshotDirectory}/${slug}-settled.png` });
      }

      const { frames, shifts } = await readMeasurement(page);
      const painted = frames.filter((frame) => frame.heading !== null && frame.composer !== null);
      const [first] = painted;
      expect(first, 'the heading and the prompt painted').toBeDefined();
      await testInfo.attach('positions', {
        body: Buffer.from(
          JSON.stringify(
            { first, last: painted.at(-1), distinct: [...new Set(painted.map((frame) => JSON.stringify(frame)))] },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
      for (const frame of painted) {
        expect(frame.heading).toBe(first?.heading);
        expect(frame.composer).toBe(first?.composer);
      }
      // The prompt box itself keeps its height while the model chip and the notices arrive (the team member's
      // line in its place is another element, and only things below it move).
      if (state.context?.kind !== 'organization') {
        for (const frame of painted) {
          expect(frame.composerHeight).toBe(first?.composerHeight);
        }
      }
      const homeShifts = shifts.filter((shift) =>
        shift.sources.some((source) => /cloudchef-home|cloudchef-message-input|h1\./.test(source)),
      );
      expect(homeShifts).toEqual([]);
    });
  }
}

// Typed fast, from the moment the box shows, while the session, the models and the projects are all still on
// their way: every character must reach what is sent.
const SENTENCE =
  'Make a booking site for a small bakery that takes orders on Workers, named Crumb, with a menu page. Then publish it.';
const EDITOR_CODE_DELAY_MS = 400;

/** Types from the moment the box is visible, with the real editor's code held back so the typing spans its arrival. */
async function typeAsSoonAsVisible(page: Page) {
  await page.route(/\/assets\/Homepage\.client-[\w-]+\.js$/, async (route) => {
    await delayed(EDITOR_CODE_DELAY_MS);
    await route.continue();
  });
  await page.goto('/');
  const box = page.getByRole('textbox', { name: 'Message to CloudChef' });
  await box.click();
  await page.keyboard.type(SENTENCE);
  return box;
}

test('keeps every keystroke typed while the home loads, signed out, and keeps exactly that for sign-in', async ({
  page,
}) => {
  await stubHome(page, null);

  const box = await typeAsSoonAsVisible(page);

  await expect(box).toHaveValue(SENTENCE);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true }).last()).toBeVisible();
  await box.press('Enter');
  // Signing in opens over the home; what was typed waits in this tab for the return.
  await expect(page.getByRole('dialog', { name: 'Sign in to CloudChef' })).toBeVisible();
  expect(await page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_PROMPT_STORAGE_KEY)).toBe(SENTENCE);
});

test('keeps every keystroke typed while the home loads, signed in, and sends exactly that', async ({ page }) => {
  await stubHome(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' });

  const box = await typeAsSoonAsVisible(page);

  await expect(page.getByText('New models:')).toBeVisible();
  await expect(page.getByRole('region', { name: 'My projects' }).getByText('Recipe planner')).toBeVisible();
  await expect(box).toHaveValue(SENTENCE);
  await box.press('Enter');
  // Sent: the home hands the prompt to a new chat, which shows it whole (as its first message, or back in its box
  // while this fixture's workspace, which has no files, loads).
  await expect(page.getByPlaceholder(/Describe your app/i)).toHaveCount(0);
  await expect(page.getByText(SENTENCE, { exact: true }).first()).toBeVisible();
});

test('keeps every keystroke of a burst typed faster than the page draws', async ({ page }) => {
  await stubHome(page, { kind: 'personal', connectionId: 'e2e-connection', accountName: 'Test account' });
  await page.goto('/');
  // The real editor, on a slow machine: every key is sent at once, without waiting for the page to draw it, the
  // way a fast typist or a typing tool lands on a busy page.
  const box = page.locator('textarea[maxlength]');
  await box.click();
  const browser = await page.context().newCDPSession(page);
  await browser.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await Promise.all(
    [...SENTENCE.repeat(2)].flatMap((key) => [
      browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key }),
      browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key }),
    ]),
  );
  await expect(box).toHaveValue(SENTENCE.repeat(2));
});
