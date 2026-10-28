import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitHubReturnMessageText } from '~/lib/github-return-messages';
import { z } from 'zod';
import { controlPlaneDatabase, envWith, withStatementHook } from '~/test/control-plane-d1';
import { createAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { createGitHubAppJwt } from '~/lib/.server/github/app-jwt';
import { GitHubApp } from '~/lib/.server/github/github-app';
import { bytesToBase64 } from '~/lib/hex-digest';
import { createOrganizationAction, listOrganizationsAction, updateMemberAction } from './organizations';
import { completeGitHubInstallAction, disconnectGitHubAction, startGitHubInstallAction } from './github-projects';
import { listMyProjectsAction, registerGitHubImport, setProjectAccessAction } from './projects';
import { answeringOrganizationErrors } from './signed-in';
import { requireProjectScope } from '~/lib/cloudflare/data/org-projects.server';

const ORIGIN = 'https://cloudchef.build';
const INSTALLATION_ID = 4242;
/** The App's installation on ada-labs, a GitHub organization ada owns. */
const LABS_INSTALLATION_ID = 4343;
afterEach(() => {
  vi.unstubAllGlobals();
});

const REPOSITORIES = [
  { id: 11, full_name: 'ada/site', default_branch: 'main', private: true },
  { id: 12, full_name: 'ada/blog', default_branch: 'trunk', private: false },
];
const LABS_REPOSITORIES = [{ id: 21, full_name: 'ada-labs/tools', default_branch: 'main', private: true }];

async function pkcs8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(der)}\n-----END PRIVATE KEY-----\n`,
    publicKey: pair.publicKey,
  };
}

/**
 * GitHub as CloudChef sees it: the App's installations on `ada`'s account and on ada-labs, an organization
 * ada owns, and what was asked of it.
 */
function fakeGitHub(pem: string, login = 'ada') {
  const calls: { url: string; body: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : null });
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'user-token' });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json({ login });
    }
    if (url.startsWith('https://api.github.com/user/installations')) {
      // The admin can see more installations than one page lists, and CloudChef's isn't on the first.
      return Response.json({
        total_count: 101,
        installations: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          account: { login: `org-${index}`, type: 'Organization' },
        })),
      });
    }
    if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}`) {
      return Response.json({ id: INSTALLATION_ID, account: { login: 'ada', type: 'User' } });
    }
    if (url === `https://api.github.com/app/installations/${LABS_INSTALLATION_ID}`) {
      return Response.json({ id: LABS_INSTALLATION_ID, account: { login: 'ada-labs', type: 'Organization' } });
    }
    if (url === 'https://api.github.com/user/memberships/orgs/ada-labs') {
      return Response.json({ role: 'admin', state: 'active' });
    }
    if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return Response.json({ token: 'installation-token', expires_at: '2026-10-19T12:00:00Z' }, { status: 201 });
    }
    if (url === `https://api.github.com/app/installations/${LABS_INSTALLATION_ID}/access_tokens`) {
      return Response.json({ token: 'labs-token', expires_at: '2026-10-19T12:00:00Z' }, { status: 201 });
    }
    if (url.startsWith('https://api.github.com/installation/repositories')) {
      const repositories = new Headers(init?.headers).get('authorization')?.endsWith('labs-token')
        ? LABS_REPOSITORIES
        : REPOSITORIES;
      return Response.json({ total_count: repositories.length, repositories });
    }
    return new Response('not found', { status: 404 });
  };
  vi.stubGlobal('fetch', request);
  const app = new GitHubApp({ clientId: 'Iv1.test', clientSecret: 'secret', privateKey: pem, slug: 'cloudchef' });
  return { app, calls };
}

async function setup() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db });
  const signIn = async (email: string) => {
    const user = await upsertVerifiedEmailUser(db, { email });
    const cookie = (await createAuthSession(env, user.id, new Request('https://cloudchef.build/'))).cookie.split(
      ';',
    )[0];
    return { userId: user.id, cookie };
  };
  const admin = await signIn('ada@acme.com');
  const created = await createOrganizationAction({
    request: post(admin.cookie, '/api/organizations/create', { name: 'Acme' }),
    env,
  });
  const { orgId } = z.object({ orgId: z.string() }).parse(await created.json());
  database
    .prepare(
      `INSERT INTO cloudflare_connections (id, org_id, account_id, account_name, status, created_at, updated_at)
       VALUES ('acme-connection', ?, 'account-acme', 'Acme', 'active', 1, 1)`,
    )
    .run(orgId);
  const member = await signIn('sam@acme.com');
  database
    .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)`)
    .run(orgId, member.userId);
  const { pem } = await pkcs8Pem();
  return { database, env, orgId, admin, member, ...fakeGitHub(pem) };
}

function post(cookie: string, path: string, body: Record<string, string | number | boolean | null>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** Installs the App for the organization the way a browser would: start here, return from GitHub. */
async function install(
  env: Env,
  app: GitHubApp,
  cookie: string,
  orgId: string | undefined,
  installationId = INSTALLATION_ID,
  callbackURL?: string,
) {
  const body: Record<string, string> = {};
  if (orgId) {
    body.orgId = orgId;
  }
  if (callbackURL) {
    body.callbackURL = callbackURL;
  }
  const started = await startGitHubInstallAction({
    request: post(cookie, '/api/organizations/github/start', body),
    env: envWith({
      ...env,
      GITHUB_APP_CLIENT_ID: 'Iv1.test',
      GITHUB_APP_CLIENT_SECRET: 'secret',
      GITHUB_APP_PRIVATE_KEY: 'unused',
      GITHUB_APP_SLUG: 'cloudchef',
    }),
  });
  expect(started.status).toBe(201);
  const state = /cloudchef_github_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
  return completeGitHubInstallAction({
    request: new Request(
      `${ORIGIN}/github/return?installation_id=${installationId}&code=c&setup_action=install&state=${state}`,
      {
        headers: { cookie: `${cookie}; cloudchef_github_state=${state}` },
      },
    ),
    env,
    app,
  });
}

/** What Settings shows for the code a return from GitHub carries. */
function githubMessage(response: Response): string | null {
  const code = new URL(response.headers.get('location') ?? '/', ORIGIN).searchParams.get('github_message');
  return code === null ? null : gitHubReturnMessageText(code);
}

const myProjectsSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      repo: z.string().nullable(),
      role: z.enum(['view', 'edit']),
      importRepoFullName: z.string().nullable(),
    }),
  ),
});

/** The projects this person sees where they work now, as `imported from: role`. */
async function myProjects(env: Env, cookie: string) {
  const response = await listMyProjectsAction({
    request: new Request(`${ORIGIN}/api/org-projects`, { headers: { cookie } }),
    env,
  });
  return myProjectsSchema
    .parse(await response.json())
    .projects.map((project) => `${project.importRepoFullName}: ${project.role}`);
}

describe('GitHub App', () => {
  it('signs a nine-minute RS256 token GitHub can verify', async () => {
    const { pem, publicKey } = await pkcs8Pem();
    const now = Date.UTC(2026, 9, 19, 12);
    vi.useFakeTimers({ toFake: ['Date'], now });
    const [header, claims, signature] = (await createGitHubAppJwt('Iv1.test', pem)).split('.');
    vi.useRealTimers();
    const decode = (segment: string) => atob(segment.replaceAll('-', '+').replaceAll('_', '/'));
    expect(JSON.parse(decode(header))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(decode(claims))).toEqual({ iat: now / 1_000 - 60, exp: now / 1_000 + 480, iss: 'Iv1.test' });
    const bytes = Uint8Array.from(decode(signature), (char) => char.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      bytes,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  it('mints tokens for exactly the repositories and permissions asked for', async () => {
    const { pem } = await pkcs8Pem();
    const { app, calls } = fakeGitHub(pem);
    await app.installationToken(INSTALLATION_ID, { contents: 'read' }, [11]);
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ permissions: { contents: 'read' }, repository_ids: [11] });
  });
});

describe('GitHub projects', () => {
  it("records an installation only when it is the App's, on the returning admin's account", async () => {
    const { env, orgId, admin, app } = await setup();
    const forged = await install(env, app, admin.cookie, orgId, 999);
    expect(forged.status).toBe(303);
    expect(githubMessage(forged)).toBe('Only the owner of that GitHub account or organization can connect it.');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM github_installations').first()).toEqual({ n: 0 });

    const installed = await install(env, app, admin.cookie, orgId);
    expect(installed.status).toBe(303);
    expect(githubMessage(installed)).toBe('Connected GitHub.');
    expect(new URL(installed.headers.get('location') ?? '').hash).toBe('#organizations');
    expect(await env.DB.prepare('SELECT installation_id, account_login FROM github_installations').first()).toEqual({
      installation_id: INSTALLATION_ID,
      account_login: 'ada',
    });
  });

  it("ignores a return that doesn't carry the state this browser started with", async () => {
    const { env, orgId, admin, app } = await setup();
    const started = await startGitHubInstallAction({
      request: post(admin.cookie, '/api/organizations/github/start', { orgId }),
      env: envWith({
        ...env,
        GITHUB_APP_CLIENT_ID: 'Iv1.test',
        GITHUB_APP_CLIENT_SECRET: 'secret',
        GITHUB_APP_PRIVATE_KEY: 'unused',
        GITHUB_APP_SLUG: 'cloudchef',
      }),
    });
    const state = /cloudchef_github_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
    // A link someone else made, with their installation and code, opened in the admin's browser.
    const forged = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?installation_id=${INSTALLATION_ID}&code=theirs&state=other`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_state=${state}` },
      }),
      env,
      app,
    });
    expect(forged.status).toBe(303);
    expect(new URL(forged.headers.get('location') ?? '').pathname).toBe('/settings');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM github_installations').first()).toEqual({ n: 0 });
  });

  it('sends a browser back to Settings saying why an expired or cancelled return did nothing', async () => {
    const { env, orgId, admin, app } = await setup();
    const started = await startGitHubInstallAction({
      request: post(admin.cookie, '/api/organizations/github/start', { orgId }),
      env: envWith({
        ...env,
        GITHUB_APP_CLIENT_ID: 'Iv1.test',
        GITHUB_APP_CLIENT_SECRET: 'secret',
        GITHUB_APP_PRIVATE_KEY: 'unused',
        GITHUB_APP_SLUG: 'cloudchef',
      }),
    });
    const state = /cloudchef_github_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const returnWith = (query: string) =>
      completeGitHubInstallAction({
        request: new Request(`${ORIGIN}/github/return?${query}&state=${state}`, {
          headers: { cookie: `${admin.cookie}; cloudchef_github_state=${state}` },
        }),
        env,
        app,
      });
    const cancelled = await returnWith('setup_action=install');
    expect(cancelled.status).toBe(303);
    expect(githubMessage(cancelled)).toMatch(/cancelled/);
    const reused = await returnWith(`installation_id=${INSTALLATION_ID}&code=c`);
    expect(githubMessage(reused)).toMatch(/expired or was already finished/);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM github_installations').first()).toEqual({ n: 0 });
  });

  it("reports changing the installation's repositories as done, and records nothing for another installation", async () => {
    const { env, orgId, admin, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const changeRepositories = async (installationId: number) => {
      const started = await startGitHubInstallAction({
        request: post(admin.cookie, '/api/organizations/github/start', { orgId }),
        env: envWith({
          ...env,
          GITHUB_APP_CLIENT_ID: 'Iv1.test',
          GITHUB_APP_CLIENT_SECRET: 'secret',
          GITHUB_APP_PRIVATE_KEY: 'unused',
          GITHUB_APP_SLUG: 'cloudchef',
        }),
      });
      const state = /cloudchef_github_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
      // GitHub returns from "Configure" with no authorization code.
      return completeGitHubInstallAction({
        request: new Request(
          `${ORIGIN}/github/return?installation_id=${installationId}&setup_action=update&state=${state}`,
          { headers: { cookie: `${admin.cookie}; cloudchef_github_state=${state}` } },
        ),
        env,
        app,
      });
    };

    expect(githubMessage(await changeRepositories(INSTALLATION_ID))).toBe(
      'Updated which repositories CloudChef can reach on GitHub.',
    );
    // One someone else set up for another space is not theirs to add: nothing is recorded.
    expect(githubMessage(await changeRepositories(INSTALLATION_ID + 1))).toMatch(/already has CloudChef's GitHub App/);
    expect(await env.DB.prepare('SELECT installation_id FROM github_installations').all()).toMatchObject({
      results: [{ installation_id: INSTALLATION_ID }],
    });
  });

  it('adds an account the App is already on, for another space of the person who connected it', async () => {
    const { database, env, orgId, admin, app } = await setup();
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
         VALUES ('ada-own', ?, 'account-ada', 'active', 1, 1)`,
      )
      .run(admin.userId);
    // Connected first for the person's own projects, with GitHub's proof that they own the account.
    await install(env, app, admin.cookie, undefined);
    // GitHub sends the team's attempt on the same account to Configure, which returns without that proof.
    const started = await startGitHubInstallAction({
      request: post(admin.cookie, '/api/organizations/github/start', { orgId }),
      env: envWith({
        ...env,
        GITHUB_APP_CLIENT_ID: 'Iv1.test',
        GITHUB_APP_CLIENT_SECRET: 'secret',
        GITHUB_APP_PRIVATE_KEY: 'unused',
        GITHUB_APP_SLUG: 'cloudchef',
      }),
    });
    const state = /cloudchef_github_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
    const returned = await completeGitHubInstallAction({
      request: new Request(
        `${ORIGIN}/github/return?installation_id=${INSTALLATION_ID}&setup_action=update&state=${state}`,
        { headers: { cookie: `${admin.cookie}; cloudchef_github_state=${state}` } },
      ),
      env,
      app,
    });
    expect(githubMessage(returned)).toBe('Connected GitHub.');
    expect(database.prepare('SELECT connection_id FROM github_installations ORDER BY connection_id').all()).toEqual([
      { connection_id: 'acme-connection' },
      { connection_id: 'ada-own' },
    ]);
  });

  it("refuses an installation the admin can see but doesn't own", async () => {
    const { env, orgId, admin } = await setup();
    const { pem } = await pkcs8Pem();
    // Another GitHub user's installation shows up for anyone who can read one of its repositories.
    const { app } = fakeGitHub(pem, 'mallory');
    const refused = await install(env, app, admin.cookie, orgId);
    expect(refused.status).toBe(303);
    expect(githubMessage(refused)).toBe('Only the owner of that GitHub account or organization can connect it.');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM github_installations').first()).toEqual({ n: 0 });
  });

  it('sends a browser back to Settings when D1 or the network fails while recording an installation', async () => {
    const { env, orgId, admin, app } = await setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failingD1 = envWith({
      ...env,
      DB: withStatementHook(env.DB, (query) => {
        if (query.includes('INSERT INTO github_installations')) {
          throw new Error('D1_ERROR: storage operation exceeded timeout');
        }
      }),
    });
    const unsaved = await install(failingD1, app, admin.cookie, orgId);
    expect(unsaved.status).toBe(303);
    expect(githubMessage(unsaved)).toBe("GitHub couldn't be connected just now. Try again.");

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Network connection lost.');
    });
    const unreached = await install(env, app, admin.cookie, orgId);
    expect(unreached.status).toBe(303);
    expect(githubMessage(unreached)).toBe("GitHub couldn't be connected just now. Try again.");
    expect(logged).toHaveBeenCalledWith('A CloudChef installation failed', 'TypeError: Network connection lost.');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM github_installations').first()).toEqual({ n: 0 });
    logged.mockRestore();
  });

  it('sends a browser back to Settings when D1 fails before GitHub is asked anything', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const returnFailing = async (failing: string, query: string) => {
      const { env, orgId, admin, app } = await setup();
      const started = await startGitHubInstallAction({
        request: post(admin.cookie, '/api/organizations/github/start', { orgId }),
        env: envWith({
          ...env,
          GITHUB_APP_CLIENT_ID: 'Iv1.test',
          GITHUB_APP_CLIENT_SECRET: 'secret',
          GITHUB_APP_PRIVATE_KEY: 'unused',
          GITHUB_APP_SLUG: 'cloudchef',
        }),
      });
      const state = /cloudchef_github_state=([^;]+)/.exec(started.headers.get('set-cookie') ?? '')?.[1] ?? '';
      return completeGitHubInstallAction({
        request: new Request(`${ORIGIN}/github/return?installation_id=${INSTALLATION_ID}&${query}&state=${state}`, {
          headers: { cookie: `${admin.cookie}; cloudchef_github_state=${state}` },
        }),
        env: envWith({
          ...env,
          DB: withStatementHook(env.DB, (statement) => {
            if (statement.includes(failing)) {
              throw new Error('D1_ERROR: storage operation exceeded timeout');
            }
          }),
        }),
        app,
      });
    };

    for (const [failing, query] of [
      ['UPDATE github_install_states', 'code=c&setup_action=install'],
      ['FROM github_installations', 'setup_action=update'],
      ['FROM cloudflare_auth_sessions', 'code=c&setup_action=install'],
      ['FROM organization_members', 'code=c&setup_action=install'],
    ]) {
      const returned = await returnFailing(failing ?? '', query ?? '');
      expect(returned.status).toBe(303);
      expect(githubMessage(returned)).toBe("GitHub couldn't be connected just now. Try again.");
    }
    expect(logged).toHaveBeenCalledWith(
      'A CloudChef installation failed',
      'Error: D1_ERROR: storage operation exceeded timeout',
    );
    logged.mockRestore();
  });

  it('returns to the page the installation started from once it is connected', async () => {
    const { env, orgId, admin, app } = await setup();
    const installed = await install(env, app, admin.cookie, orgId, INSTALLATION_ID, `${ORIGIN}/?import=github`);
    const location = new URL(installed.headers.get('location') ?? '/', ORIGIN);
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('import')).toBe('github');
    expect(githubMessage(installed)).toBe('Connected GitHub.');

    // A refusal goes to Settings, the page that says why, wherever it started.
    const refused = await install(env, app, admin.cookie, orgId, 999, `${ORIGIN}/?import=github`);
    expect(new URL(refused.headers.get('location') ?? '/', ORIGIN).pathname).toBe('/settings');
  });

  it("doesn't let a member connect GitHub", async () => {
    const { env, orgId, member } = await setup();
    const started = await startGitHubInstallAction({
      request: post(member.cookie, '/api/organizations/github/start', { orgId }),
      env: envWith({
        ...env,
        GITHUB_APP_CLIENT_ID: 'Iv1.test',
        GITHUB_APP_CLIENT_SECRET: 'secret',
        GITHUB_APP_PRIVATE_KEY: 'unused',
        GITHUB_APP_SLUG: 'cloudchef',
      }),
    });
    expect(started.status).toBe(403);
  });

  it('lets a person with Cloudflare connected install the App for their own projects', async () => {
    const { database, env, admin, app } = await setup();
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
         VALUES ('ada-own', ?, 'account-ada', 'active', 1, 1)`,
      )
      .run(admin.userId);
    const installed = await install(env, app, admin.cookie, undefined);
    expect(githubMessage(installed)).toBe('Connected GitHub.');
    expect(database.prepare('SELECT connection_id FROM github_installations').all()).toEqual([
      { connection_id: 'ada-own' },
    ]);
  });
});

/** The address of one of the fake GitHub's repositories, by its id (99 is one no installation reaches). */
const repositoryUrl = (repoId: number) =>
  `https://github.com/${[...REPOSITORIES, ...LABS_REPOSITORIES].find(({ id }) => id === repoId)?.full_name ?? 'ada/missing'}`;

/** A GitHub import as the runtime registers one: in a team (`orgId`) or the person's own account. */
const register = (
  env: Env,
  userId: string,
  { orgId, ...request }: { orgId?: string } & { url: string; name?: string },
  app: GitHubApp | null,
  gitRequest?: typeof fetch,
) =>
  answeringOrganizationErrors(async () => {
    const scope = await requireProjectScope(env.DB, userId, orgId);
    const registered = await registerGitHubImport(env, { scope, actorId: userId, request, app, gitRequest });
    return registered instanceof Response ? registered : Response.json(registered, { status: 201 });
  });

describe('projects', () => {
  const giveRole = (env: Env, cookie: string, body: Record<string, string | null>) =>
    setProjectAccessAction({ request: post(cookie, '/api/organizations/projects/access', body), env });

  it('imports repositories the installation reaches, and gives members the projects and roles admins choose', async () => {
    const { database, env, orgId, admin, member, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const imported = (repoId: number, user = admin) =>
      register(env, user.userId, { orgId, url: repositoryUrl(repoId), name: `Repo ${repoId}` }, app);

    expect((await imported(99)).status).toBe(404);
    expect((await imported(11, member)).status).toBe(403);
    const site = await imported(11);
    expect(site.status).toBe(201);
    expect((await imported(11)).status).toBe(409);
    expect((await imported(12)).status).toBe(201);
    const { projectId } = z.object({ projectId: z.string() }).parse(await site.json());
    // Imported on first open: no Artifacts repository yet, and the branch that is GitHub's default.
    expect(
      database
        .prepare('SELECT import_repo_full_name, import_branch, artifact_repo FROM org_projects ORDER BY name')
        .all(),
    ).toEqual([
      { import_repo_full_name: 'ada/site', import_branch: 'main', artifact_repo: null },
      { import_repo_full_name: 'ada/blog', import_branch: 'trunk', artifact_repo: null },
    ]);

    // Admins own every project; a member has none until given one.
    expect(await myProjects(env, admin.cookie)).toEqual(['ada/site: edit', 'ada/blog: edit']);
    expect(await myProjects(env, member.cookie)).toEqual([]);
    const role = (cookie: string, value: 'view' | 'edit' | null) =>
      giveRole(env, cookie, { orgId, projectId, userId: member.userId, role: value });
    expect((await role(admin.cookie, 'view')).status).toBe(204);
    expect(await myProjects(env, member.cookie)).toEqual(['ada/site: view']);
    expect((await role(member.cookie, 'edit')).status).toBe(403);
    expect((await role(admin.cookie, 'edit')).status).toBe(204);
    expect(await myProjects(env, member.cookie)).toEqual(['ada/site: edit']);

    // The admin's team view lists who may view or edit each project.
    const listed = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: admin.cookie } }),
      env,
    });
    const view = z
      .object({
        organizations: z.array(
          z.object({
            github: z.array(z.object({ accountLogin: z.string() })),
            projects: z.array(
              z.object({
                importRepoFullName: z.string().nullable(),
                repo: z.string().nullable(),
                access: z.array(z.object({ userId: z.string(), role: z.string() })),
              }),
            ),
          }),
        ),
      })
      .parse(await listed.json());
    expect(view.organizations[0].github.map((account) => account.accountLogin)).toEqual(['ada']);
    expect(view.organizations[0].projects.find((project) => project.importRepoFullName === 'ada/site')).toEqual({
      importRepoFullName: 'ada/site',
      repo: null,
      access: [{ userId: member.userId, role: 'edit' }],
    });

    expect((await role(admin.cookie, null)).status).toBe(204);
    expect(await myProjects(env, member.cookie)).toEqual([]);
  });

  it('imports from every GitHub account the team connected, and disconnects one without the other', async () => {
    const { database, env, orgId, admin, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const labs = await install(env, app, admin.cookie, orgId, LABS_INSTALLATION_ID);
    expect(githubMessage(labs)).toBe('Connected GitHub.');
    expect(database.prepare('SELECT account_login FROM github_installations ORDER BY account_login').all()).toEqual([
      { account_login: 'ada' },
      { account_login: 'ada-labs' },
    ]);
    const imported = (repoId: number) =>
      register(env, admin.userId, { orgId, url: repositoryUrl(repoId), name: `Repo ${repoId}` }, app);
    expect((await imported(21)).status).toBe(201);
    expect((await imported(11)).status).toBe(201);

    const disconnected = await disconnectGitHubAction({
      request: post(admin.cookie, '/api/organizations/github/disconnect', {
        orgId,
        installationId: LABS_INSTALLATION_ID,
      }),
      env,
    });
    expect(disconnected.status).toBe(204);
    expect(database.prepare('SELECT account_login FROM github_installations').all()).toEqual([
      { account_login: 'ada' },
    ]);
    expect((await imported(12)).status).toBe(201);
    expect((await imported(99)).status).toBe(404);
  });

  it('takes projects away from a member who is paused or removed', async () => {
    const { database, env, orgId, admin, member, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const imported = await register(env, admin.userId, { orgId, url: repositoryUrl(11), name: 'Site' }, app);
    const { projectId } = z.object({ projectId: z.string() }).parse(await imported.json());
    await giveRole(env, admin.cookie, { orgId, projectId, userId: member.userId, role: 'edit' });

    database.prepare('UPDATE organization_members SET paused_at = 1 WHERE user_id = ?').run(member.userId);
    expect(await myProjects(env, member.cookie)).toEqual([]);
    database.prepare('UPDATE organization_members SET paused_at = NULL WHERE user_id = ?').run(member.userId);
    expect(await myProjects(env, member.cookie)).toEqual(['ada/site: edit']);

    const removed = await updateMemberAction({
      request: post(admin.cookie, '/api/organizations/member', {
        orgId,
        userId: member.userId,
        action: 'remove',
        deleteWorkspace: false,
      }),
      env,
    });
    expect(removed.status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM org_project_access').first()).toEqual({ n: 0 });
  });

  it('grants no project to a member removed while the grant was being made', async () => {
    const { database, env, orgId, admin, member, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const imported = await register(env, admin.userId, { orgId, url: repositoryUrl(11), name: 'Site' }, app);
    const { projectId } = z.object({ projectId: z.string() }).parse(await imported.json());
    // Another admin's removal lands just before the grant is written.
    const racing = withStatementHook(env.DB, (query) => {
      if (query.includes('INSERT INTO org_project_access')) {
        database.prepare('DELETE FROM organization_members WHERE user_id = ?').run(member.userId);
      }
    });
    const grant = await giveRole(envWith({ ...env, DB: racing }), admin.cookie, {
      orgId,
      projectId,
      userId: member.userId,
      role: 'edit',
    });
    expect(grant.status).toBe(404);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM org_project_access').first()).toEqual({ n: 0 });
  });

  it('keeps when a grant was first given when its role changes', async () => {
    const { database, env, orgId, admin, member, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const imported = await register(env, admin.userId, { orgId, url: repositoryUrl(11), name: 'Site' }, app);
    const { projectId } = z.object({ projectId: z.string() }).parse(await imported.json());
    const role = (value: 'view' | 'edit') =>
      giveRole(env, admin.cookie, { orgId, projectId, userId: member.userId, role: value });
    expect((await role('edit')).status).toBe(204);
    database.prepare('UPDATE org_project_access SET granted_at = 1').run();
    expect((await role('view')).status).toBe(204);
    expect(database.prepare('SELECT user_id, role, granted_at FROM org_project_access').all()).toEqual([
      { user_id: member.userId, role: 'view', granted_at: 1 },
    ]);
  });

  it("imports a public repository by its address, for a person's own projects, with no GitHub App", async () => {
    const { database, env, orgId, admin, member } = await setup();
    database
      .prepare(
        `INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
         VALUES ('sam-own', ?, 'account-sam', 'active', 1, 1)`,
      )
      .run(member.userId);
    const asked: string[] = [];
    const gitRequest: typeof fetch = async (input) => {
      const url = String(input);
      asked.push(url);
      // GitHub's names are case-insensitive.
      if (url.toLowerCase() === 'https://github.com/ada/blog.git/info/refs?service=git-upload-pack') {
        return new Response(
          `001e# service=git-upload-pack\n00000155${'a'.repeat(40)} HEAD\0multi_ack thin-pack ` +
            'symref=HEAD:refs/heads/trunk object-format=sha1 agent=git/github\n0000',
        );
      }
      return new Response('Repository not found.', { status: 401 });
    };
    const importUrl = (url: string, user = member, extra: { orgId?: string } = {}) =>
      register(env, user.userId, { url, ...extra }, null, gitRequest);

    expect((await importUrl('https://gitlab.com/ada/blog')).status).toBe(400);
    const privateOne = await importUrl('https://github.com/ada/private');
    expect(privateOne.status).toBe(404);
    expect(await privateOne.json()).toMatchObject({ code: 'not_public' });
    const imported = await importUrl('https://github.com/ada/blog.git');
    expect(imported.status).toBe(201);
    expect((await importUrl('https://github.com/Ada/Blog')).status).toBe(409);
    expect(asked).toContain('https://github.com/ada/blog.git/info/refs?service=git-upload-pack');
    expect(
      database.prepare('SELECT connection_id, org_id, name, import_repo_id, import_branch FROM org_projects').all(),
    ).toEqual([{ connection_id: 'sam-own', org_id: null, name: 'blog', import_repo_id: null, import_branch: 'trunk' }]);
    // Their own projects, in their own account; nobody else's, not even a team admin's.
    expect(await myProjects(env, member.cookie)).toEqual(['ada/blog: edit']);
    expect(await myProjects(env, admin.cookie)).toEqual([]);
    // A team import needs one of its admins.
    expect((await importUrl('https://github.com/ada/blog', member, { orgId })).status).toBe(403);
  });
});
