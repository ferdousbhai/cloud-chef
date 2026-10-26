import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { teamFixture } from '~/test/project-fixture';
import { GitHubApp } from '~/lib/.server/github/github-app';
import { bytesToBase64 } from '~/lib/hex-digest';
import type { WorkersBuildsAccountApi } from '~/lib/.server/cloudflare/workers-builds';
import { CloudflareAccountApiError, type WorkersBuild } from '~/lib/.server/cloudflare/user-account-api';
import {
  runtimeOpenProjectAction,
  runtimeProjectImportedAction,
  runtimeAbandonImportAction,
  runtimeRegisterImportAction,
  runtimeRequestProductionAction,
  runtimeProjectSiteAction,
  runtimeProjectStatusAction,
} from './runtime-projects';
import { listMyProjectsAction } from './projects';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SITE = '11111111-1111-4111-8111-111111111111';
const BLOG = '22222222-2222-4222-8222-222222222222';
const PROMOTED = '55555555-5555-4555-8555-555555555555';
const OWN = '66666666-6666-4666-8666-666666666666';
const COMMIT = 'a'.repeat(40);
const TAG = 'f'.repeat(32);

/** CloudChef's GitHub App, minting tokens from a GitHub that records what it was asked (or answers `status`). */
async function gitHubApp(status = 201) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const asked: { url: string; body: string | null }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), body: init?.body ? String(init.body) : null });
    return status === 201
      ? Response.json({ token: 'one-repo-token', expires_at: 'soon' }, { status })
      : Response.json({ message: 'unavailable' }, { status });
  });
  const app = new GitHubApp({
    clientId: 'Iv1.test',
    clientSecret: 'secret',
    privateKey: `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(der)}\n-----END PRIVATE KEY-----`,
    slug: 'cloudchef',
  });
  return { app, asked };
}

/**
 * The team's projects: Site, imported from a private repository and not yet in Artifacts; Blog, imported
 * from a public one and in Artifacts already; and a promoted draft. Sara views Blog and edits Site; she also
 * has a project of her own. The team connected two GitHub accounts: ada, which owns the repositories, and acme.
 */
async function setup() {
  const fixture = await teamFixture();
  const { database, sara } = fixture;
  database.exec(`
    INSERT INTO github_installations (connection_id, installation_id, account_login, account_type, created_at, updated_at)
      VALUES ('team-connection', 7, 'ada', 'User', 1, 1), ('team-connection', 8, 'acme', 'Organization', 1, 1);
    INSERT INTO org_projects (id, connection_id, org_id, name, import_repo_id, import_repo_full_name, import_branch, origin, created_at)
      VALUES ('${SITE}', 'team-connection', '33333333-3333-4333-8333-333333333333', 'Site', 11, 'ada/site', 'master', 'imported', 1);
    INSERT INTO org_projects (id, connection_id, org_id, name, import_repo_full_name, import_branch, artifact_repo, origin, created_at)
      VALUES ('${BLOG}', 'team-connection', '33333333-3333-4333-8333-333333333333', 'Blog', 'ada/blog', 'main', 't-${BLOG}', 'imported', 1);
    INSERT INTO org_projects (id, connection_id, org_id, name, artifact_repo, origin, created_at)
      VALUES ('${PROMOTED}', 'team-connection', '33333333-3333-4333-8333-333333333333', 'Recipes', 'p-recipes', 'promoted', 1);
    INSERT INTO org_projects (id, connection_id, name, import_repo_full_name, import_branch, origin, created_at)
      VALUES ('${OWN}', 'sara-own', 'Mine', 'sara/mine', 'main', 'imported', 1);
  `);
  database
    .prepare(`INSERT INTO org_project_access (project_id, user_id, role, granted_at) VALUES (?, ?, 'edit', 1)`)
    .run(SITE, sara.userId);
  database
    .prepare(`INSERT INTO org_project_access (project_id, user_id, role, granted_at) VALUES (?, ?, 'view', 1)`)
    .run(BLOG, sara.userId);
  return fixture;
}

describe('a runtime opening a project', () => {
  it("hands an editor importing a private repository a read-only token for that one repository, from its owner's installation", async () => {
    const { env, runtime } = await setup();
    const { app, asked } = await gitHubApp();
    const opened = await runtimeOpenProjectAction({
      request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId: SITE }),
      env,
      app,
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({
      orgProjectId: SITE,
      name: 'Site',
      repo: null,
      defaultBranch: 'main',
      role: 'edit',
      member: { name: 'sara.a', email: 'sara.a@example.com' },
      importSource: {
        url: 'https://github.com/ada/site.git',
        branch: 'master',
        authorization: `Basic ${btoa('x-access-token:one-repo-token')}`,
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].url).toBe('https://api.github.com/app/installations/7/access_tokens');
    expect(JSON.parse(asked[0].body ?? '{}')).toEqual({ permissions: { contents: 'read' }, repository_ids: [11] });
  });

  it('answers a GitHub outage without a refusal code, so the workspace tries again', async () => {
    const { env, runtime } = await setup();
    const { app } = await gitHubApp(503);
    const opened = await runtimeOpenProjectAction({
      request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId: SITE }),
      env,
      app,
    });
    expect(opened.status).toBe(503);
    expect(await opened.json()).toEqual({ error: 'GitHub could not be reached just now. Try again in a moment.' });
  });

  it('answers a project in Artifacts with its repository and the role, and no import', async () => {
    const { env, runtime, admin } = await setup();
    const viewed = await runtimeOpenProjectAction({
      request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId: BLOG }),
      env,
      app: null,
    });
    expect(await viewed.json()).toEqual({
      orgProjectId: BLOG,
      name: 'Blog',
      repo: `t-${BLOG}`,
      defaultBranch: 'main',
      role: 'view',
      member: { name: 'sara.a', email: 'sara.a@example.com' },
    });
    // Admins own every team project.
    const owned = await runtimeOpenProjectAction({
      request: await runtime(
        '/api/cloudflare/runtime-projects/open',
        { orgProjectId: PROMOTED },
        { userId: admin.userId },
      ),
      env,
      app: null,
    });
    expect(await owned.json()).toMatchObject({ repo: 'p-recipes', role: 'edit' });
  });

  it("imports a person's own public project with no authorization, and keeps it from their team's runtime", async () => {
    const { env, runtime } = await setup();
    const own = await runtimeOpenProjectAction({
      request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId: OWN }, { connection: 'own' }),
      env,
      app: null,
    });
    expect(await own.json()).toMatchObject({
      role: 'edit',
      importSource: { url: 'https://github.com/sara/mine.git', branch: 'main', authorization: null },
    });
    const elsewhere = await runtimeOpenProjectAction({
      request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId: OWN }),
      env,
      app: null,
    });
    expect(elsewhere.status).toBe(403);
    const teamFromOwn = await runtimeOpenProjectAction({
      request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId: SITE }, { connection: 'own' }),
      env,
      app: null,
    });
    expect(teamFromOwn.status).toBe(403);
  });

  it('refuses a project the member was not given, or while they are paused, and one GitHub no longer reaches', async () => {
    const { database, env, runtime, sara } = await setup();
    const open = async (orgProjectId: string) =>
      runtimeOpenProjectAction({
        request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId }),
        env,
        app: null,
      });
    expect((await open(PROMOTED)).status).toBe(403);
    database.prepare('DELETE FROM github_installations').run();
    const disconnected = await open(SITE);
    expect(disconnected.status).toBe(409);
    expect(await disconnected.json()).toMatchObject({ code: 'github_disconnected' });
    database.prepare('UPDATE organization_members SET paused_at = 1 WHERE user_id = ?').run(sara.userId);
    // A paused member's runtime isn't heard at all.
    expect((await open(SITE)).status).toBe(401);
  });
});

describe('a runtime recording an import', () => {
  it('records the repository once, only where an editor imports it', async () => {
    const { database, env, runtime } = await setup();
    const imported = async (orgProjectId: string, repo: string) =>
      runtimeProjectImportedAction({
        request: await runtime('/api/cloudflare/runtime-projects/imported', { orgProjectId, repo, commit: COMMIT }),
        env,
      });
    expect((await imported(SITE, 't-elsewhere')).status).toBe(409);
    expect((await imported(BLOG, `t-${BLOG}`)).status).toBe(403);
    const recorded = await imported(SITE, `t-${SITE}`);
    expect(recorded.status).toBe(200);
    expect(await recorded.json()).toEqual({ orgProjectId: SITE, repo: `t-${SITE}` });
    expect((await imported(SITE, `t-${SITE}`)).status).toBe(200);
    database.prepare("UPDATE org_projects SET artifact_repo = 't-other' WHERE id = ?").run(SITE);
    const conflict = await imported(SITE, `t-${SITE}`);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'already_imported' });
  });
});

/** Workers Builds in the team's account: the Workers there and what was built. */
function workersBuilds(
  options: { builds?: WorkersBuild[]; latest?: Map<string, WorkersBuild>; failing?: boolean } = {},
) {
  const calls: string[] = [];
  const api: WorkersBuildsAccountApi = {
    listWorkerScripts: async () => {
      calls.push('scripts');
      if (options.failing) {
        throw new CloudflareAccountApiError('Authentication error');
      }
      return [
        { tag: 'e'.repeat(32), name: 'other-site' },
        { tag: TAG, name: 'blog' },
      ];
    },
    latestWorkersBuilds: async (tags) => {
      calls.push(`latest:${tags.length}`);
      return options.latest ?? new Map();
    },
    listWorkersBuilds: async (tag) => {
      calls.push(`builds:${tag}`);
      return options.builds ?? [];
    },
    listWorkersBuildTriggers: async () => [],
    listWorkerPreviews: async () => [
      { names: ['cloudchef/sara-a-key'], urls: ['https://cloudchef-sara-a-key-blog.team.workers.dev'] },
    ],
    workerAddresses: async () => ({
      customDomains: ['blog.example.com'],
      workersDevUrl: 'https://blog.team.workers.dev',
    }),
  };
  return { api, calls, openAccount: async () => api };
}

function build(overrides: Partial<WorkersBuild>): WorkersBuild {
  return {
    id: 'build-1',
    status: 'stopped',
    outcome: 'success',
    branch: 'main',
    commit: COMMIT,
    createdOn: null,
    repository: {
      provider: 'artifacts',
      repoId: 'r',
      repoName: `t-${BLOG}`,
      accountId: null,
      accountName: 'cloudchef',
    },
    ...overrides,
  };
}

describe("a runtime asking about a project's builds and site", () => {
  it("finds the project's Worker by its Artifacts repository, remembers it, and reports a commit's build", async () => {
    const { database, env, runtime } = await setup();
    const latest = new Map([[TAG, build({})]]);
    const status = async (commit: string, builds: WorkersBuild[]) => {
      const fake = workersBuilds({ latest, builds });
      const response = await runtimeProjectStatusAction({
        request: await runtime('/api/cloudflare/runtime-projects/status', { orgProjectId: BLOG, commit }),
        env,
        openAccount: fake.openAccount,
      });
      return { body: await response.json(), calls: fake.calls };
    };
    const first = await status(COMMIT, [build({})]);
    expect(first.body).toEqual({
      state: 'succeeded',
      url: 'https://blog.example.com',
      logUrl: `https://dash.cloudflare.com/account-team/workers/services/view/blog/production/builds/build-1`,
    });
    expect(first.calls).toEqual(['scripts', 'latest:2', `builds:${TAG}`]);
    // The Worker and its live site, which the projects home shows, are remembered.
    expect(
      database.prepare('SELECT workers_builds_script_tag, site_url FROM org_projects WHERE id = ?').get(BLOG),
    ).toEqual({ workers_builds_script_tag: TAG, site_url: 'https://blog.example.com' });
    // Found once, the Worker is asked about directly.
    expect((await status(COMMIT, [build({ status: 'running', outcome: null })])).calls).toEqual([
      'scripts',
      `builds:${TAG}`,
    ]);
    expect((await status(COMMIT, [build({ status: 'running', outcome: null })])).body).toMatchObject({
      state: 'building',
    });
    expect((await status(COMMIT, [build({ status: 'queued', outcome: null })])).body).toMatchObject({
      state: 'queued',
    });
    expect((await status(COMMIT, [build({ outcome: 'fail' })])).body).toMatchObject({ state: 'failed' });
    expect((await status('b'.repeat(40), [build({})])).body).toEqual({ state: 'none' });
    expect((await status(COMMIT, [build({ branch: 'cloudchef/sara-a-key' })])).body).toMatchObject({
      state: 'succeeded',
      previewUrl: 'https://cloudchef-sara-a-key-blog.team.workers.dev',
    });
  });

  it('finds a Worker still built from the GitHub repository a project was imported from', async () => {
    const { env, runtime } = await setup();
    const latest = new Map([
      [
        TAG,
        build({
          repository: { provider: 'github', repoId: '11', repoName: 'site', accountId: '1', accountName: 'ada' },
        }),
      ],
    ]);
    const fake = workersBuilds({ latest, builds: [] });
    const response = await runtimeProjectStatusAction({
      request: await runtime('/api/cloudflare/runtime-projects/status', { orgProjectId: SITE, commit: COMMIT }),
      env,
      openAccount: fake.openAccount,
    });
    expect(await response.json()).toEqual({ state: 'none' });
    expect(fake.calls).toContain(`builds:${TAG}`);
  });

  it("remembers an imported project's live site when it is opened", async () => {
    const { database, env, runtime } = await setup();
    database.prepare('UPDATE org_projects SET workers_builds_script_tag = ? WHERE id = ?').run(TAG, BLOG);
    const opened = await runtimeOpenProjectAction({
      request: await runtime('/api/cloudflare/runtime-projects/open', { orgProjectId: BLOG }),
      env,
      openAccount: workersBuilds().openAccount,
    });
    expect(opened.status).toBe(200);
    expect(database.prepare('SELECT site_url FROM org_projects WHERE id = ?').get(BLOG)).toEqual({
      site_url: 'https://blog.example.com',
    });
  });

  it('reports the production and Preview origins as the site, and what Cloudflare refused', async () => {
    const { database, env, runtime } = await setup();
    database.prepare('UPDATE org_projects SET workers_builds_script_tag = ? WHERE id = ?').run(TAG, BLOG);
    const site = await runtimeProjectSiteAction({
      request: await runtime('/api/cloudflare/runtime-projects/site', { orgProjectId: BLOG }),
      env,
      openAccount: workersBuilds().openAccount,
    });
    expect(await site.json()).toEqual({
      origins: [
        'https://blog.example.com',
        'https://blog.team.workers.dev',
        'https://cloudchef-sara-a-key-blog.team.workers.dev',
      ],
    });
    const refused = await runtimeProjectSiteAction({
      request: await runtime('/api/cloudflare/runtime-projects/site', { orgProjectId: BLOG }),
      env,
      openAccount: workersBuilds({ failing: true }).openAccount,
    });
    expect(refused.status).toBe(502);
  });
});

describe('a runtime importing a GitHub repository as a new project', () => {
  /** github.com answering git's ref advertisement for one public repository only. */
  const gitRequest: typeof fetch = async (input) =>
    String(input) === 'https://github.com/ada/public.git/info/refs?service=git-upload-pack'
      ? new Response(
          `001e# service=git-upload-pack\n00000155${'a'.repeat(40)} HEAD\0multi_ack ` +
            'symref=HEAD:refs/heads/trunk object-format=sha1 agent=git/github\n0000',
        )
      : new Response('Repository not found.', { status: 401 });

  it("registers a public repository in the person's own account and says where to import it from", async () => {
    const { env, runtime, database } = await setup();
    const registered = await runtimeRegisterImportAction({
      request: await runtime(
        '/api/cloudflare/runtime-projects/register-import',
        { url: 'https://github.com/ada/public' },
        {
          connection: 'own',
        },
      ),
      env,
      app: null,
      gitRequest,
    });
    expect(registered.status).toBe(201);
    const answer = z
      .object({ projectId: z.string() })
      .passthrough()
      .parse(await registered.json());
    expect(answer).toEqual({
      projectId: expect.any(String),
      importSource: { url: 'https://github.com/ada/public.git', branch: 'trunk', authorization: null },
      workersBuildsFromGitHub: false,
    });
    expect(
      database
        .prepare('SELECT connection_id, name, artifact_repo FROM org_projects WHERE id = ?')
        .get(answer.projectId),
    ).toEqual({ connection_id: 'sara-own', name: 'public', artifact_repo: null });
  });

  it('takes back an import whose code was never copied, for the person who registered it only', async () => {
    const { env, runtime, database } = await setup();
    const registered = await runtimeRegisterImportAction({
      request: await runtime(
        '/api/cloudflare/runtime-projects/register-import',
        { url: 'https://github.com/ada/public' },
        { connection: 'own' },
      ),
      env,
      app: null,
      gitRequest,
    });
    const { projectId } = z.object({ projectId: z.string() }).parse(await registered.json());
    const abandon = async (orgProjectId: string) =>
      (
        await runtimeAbandonImportAction({
          request: await runtime(
            '/api/cloudflare/runtime-projects/abandon-import',
            { orgProjectId },
            {
              connection: 'own',
            },
          ),
          env,
        })
      ).json();
    // A project that already holds its code, or isn't this person's, stays.
    expect(await abandon(BLOG)).toEqual({ removed: false });
    expect(await abandon(projectId)).toEqual({ removed: true });
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_projects WHERE id = ?').get(projectId)).toEqual({ n: 0 });
  });

  it("takes a team's admin in a team, and refuses a private repository the App doesn't reach", async () => {
    const { env, runtime } = await setup();
    const asMember = await runtimeRegisterImportAction({
      request: await runtime('/api/cloudflare/runtime-projects/register-import', {
        url: 'https://github.com/ada/public',
      }),
      env,
      app: null,
      gitRequest,
    });
    expect(asMember.status).toBe(403);
    const privateOne = await runtimeRegisterImportAction({
      request: await runtime(
        '/api/cloudflare/runtime-projects/register-import',
        { url: 'https://github.com/ada/hidden' },
        {
          connection: 'own',
        },
      ),
      env,
      app: null,
      gitRequest,
    });
    expect(privateOne.status).toBe(404);
    expect(await privateOne.json()).toMatchObject({ code: 'not_public' });
  });
});

describe('a runtime asking for a draft to become a team project', () => {
  const ask = async (runtime: Awaited<ReturnType<typeof setup>>['runtime'], repo: string, env: Env) =>
    runtimeRequestProductionAction({
      request: await runtime('/api/cloudflare/runtime-projects/request-production', {
        draftId: 'draft-chat',
        draftRevision: 'r1',
        title: 'Recipes',
        repo,
        commit: COMMIT,
      }),
      env,
    });

  it("names only the draft's own repository", async () => {
    const { env, runtime, database, sara } = await setup();
    database.prepare('UPDATE organization_members SET drafts_allowed = 1 WHERE user_id = ?').run(sara.userId);
    expect((await ask(runtime, 'p-another-app', env)).status).toBe(400);
    expect((await ask(runtime, 'p-draft-chat-2', env)).status).toBe(400);
    expect((await ask(runtime, 'p-draft-chat', env)).status).toBe(201);
    expect((await ask(runtime, 'p-draft-chat', env)).status).toBe(200);
  });
});

describe('the projects home', () => {
  it("finds a published project's live address the first time it lists it, and remembers it", async () => {
    const { env, database, sara } = await setup();
    database.exec(
      `UPDATE org_projects SET artifact_repo = 'p-mine', workers_builds_script_tag = '${TAG}' WHERE id = '${OWN}'`,
    );
    const list = async (openAccount = workersBuilds().openAccount) => {
      const response = await listMyProjectsAction({
        request: new Request('https://cloudchef.build/api/org-projects', { headers: { cookie: sara.cookie } }),
        env,
        openAccount,
      });
      return z
        .object({ projects: z.array(z.object({ id: z.string(), siteUrl: z.string().nullable() })) })
        .parse(await response.json())
        .projects.find((project) => project.id === OWN);
    };
    expect(await list()).toEqual({ id: OWN, siteUrl: 'https://blog.example.com' });
    // Remembered: a later list doesn't ask Cloudflare again.
    expect(await list(workersBuilds({ failing: true }).openAccount)).toEqual({
      id: OWN,
      siteUrl: 'https://blog.example.com',
    });
  });
});
