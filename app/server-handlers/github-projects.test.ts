import { describe, expect, it } from 'vitest';
import { gitHubReturnMessageText } from '~/lib/github-return-messages';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { createGitHubAppJwt } from '~/lib/.server/github/app-jwt';
import { GitHubApp } from '~/lib/.server/github/github-app';
import { bytesToBase64 } from '~/lib/hex-digest';
import { createOrganizationAction, listOrganizationsAction, updateMemberAction } from './organizations';
import {
  completeGitHubInstallAction,
  linkGitHubProjectAction,
  listMyProjectsAction,
  setProjectAccessAction,
  startGitHubInstallAction,
} from './github-projects';

const ORIGIN = 'https://cloudchef.build';
const INSTALLATION_ID = 4242;
const REPOSITORIES = [
  { id: 11, full_name: 'ada/site', default_branch: 'main', private: true },
  { id: 12, full_name: 'ada/blog', default_branch: 'trunk', private: false },
];

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

/** GitHub as CloudChef sees it: the App's one installation, on `ada`'s account, and what was asked of it. */
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
    if (url === `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`) {
      return Response.json({ token: 'installation-token', expires_at: '2026-10-19T12:00:00Z' }, { status: 201 });
    }
    if (url.startsWith('https://api.github.com/installation/repositories')) {
      return Response.json({ total_count: REPOSITORIES.length, repositories: REPOSITORIES });
    }
    return new Response('not found', { status: 404 });
  };
  const app = new GitHubApp(
    { clientId: 'Iv1.test', clientSecret: 'secret', privateKey: pem, slug: 'cloudchef' },
    request,
  );
  return { app, calls };
}

async function setup() {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db });
  const signIn = async (email: string) => {
    const user = await upsertVerifiedEmailUser(db, { email });
    const cookie = (await createAuthSession(env, await prepareAuthSession(user.id))).split(';')[0];
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

function post(cookie: string, path: string, body: Record<string, string | number | boolean>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** Installs the App for the organization the way a browser would: start here, return from GitHub. */
async function install(env: Env, app: GitHubApp, cookie: string, orgId: string, installationId = INSTALLATION_ID) {
  const started = await startGitHubInstallAction({
    request: post(cookie, '/api/organizations/github/start', { orgId }),
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

const myProjectsSchema = z.object({ projects: z.array(z.object({ id: z.string(), repoFullName: z.string() })) });

async function myProjects(env: Env, cookie: string) {
  const response = await listMyProjectsAction({
    request: new Request(`${ORIGIN}/api/org-projects`, { headers: { cookie } }),
    env,
  });
  return myProjectsSchema.parse(await response.json()).projects.map((project) => project.repoFullName);
}

describe('GitHub App', () => {
  it('signs a nine-minute RS256 token GitHub can verify', async () => {
    const { pem, publicKey } = await pkcs8Pem();
    const now = Date.UTC(2026, 9, 19, 12);
    const [header, claims, signature] = (await createGitHubAppJwt('Iv1.test', pem, now)).split('.');
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
    expect(githubMessage(await changeRepositories(INSTALLATION_ID + 1))).toMatch(/cancelled/);
    expect(await env.DB.prepare('SELECT installation_id FROM github_installations').all()).toMatchObject({
      results: [{ installation_id: INSTALLATION_ID }],
    });
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

  it('links repositories the installation reaches, and shows members only the projects they were given', async () => {
    const { env, orgId, admin, member, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const link = (repoId: number, cookie = admin.cookie) =>
      linkGitHubProjectAction({
        request: post(cookie, '/api/organizations/projects/link', { orgId, repoId, name: `Repo ${repoId}` }),
        env,
        app,
      });

    expect((await link(99)).status).toBe(404);
    expect((await link(11, member.cookie)).status).toBe(403);
    const linked = await link(11);
    expect(linked.status).toBe(201);
    expect((await link(11)).status).toBe(409);
    expect((await link(12)).status).toBe(201);
    const { projectId } = z.object({ projectId: z.string() }).parse(await linked.json());

    // The admin works on every project; the member on none until given one.
    expect(await myProjects(env, admin.cookie)).toEqual(['ada/site', 'ada/blog']);
    expect(await myProjects(env, member.cookie)).toEqual([]);
    const grant = await setProjectAccessAction({
      request: post(admin.cookie, '/api/organizations/projects/access', {
        orgId,
        projectId,
        userId: member.userId,
        allowed: true,
      }),
      env,
    });
    expect(grant.status).toBe(204);
    expect(await myProjects(env, member.cookie)).toEqual(['ada/site']);

    // The admin's organization view lists who may work on each project.
    const listed = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: admin.cookie } }),
      env,
    });
    const view = z
      .object({
        organizations: z.array(
          z.object({
            github: z.object({ accountLogin: z.string() }).nullable(),
            projects: z.array(z.object({ repoFullName: z.string(), memberIds: z.array(z.string()) })),
          }),
        ),
      })
      .parse(await listed.json());
    expect(view.organizations[0].github?.accountLogin).toBe('ada');
    expect(view.organizations[0].projects.find((project) => project.repoFullName === 'ada/site')?.memberIds).toEqual([
      member.userId,
    ]);
  });

  it('takes projects away from a member who is paused or removed', async () => {
    const { database, env, orgId, admin, member, app } = await setup();
    await install(env, app, admin.cookie, orgId);
    const linked = await linkGitHubProjectAction({
      request: post(admin.cookie, '/api/organizations/projects/link', { orgId, repoId: 11, name: 'Site' }),
      env,
      app,
    });
    const { projectId } = z.object({ projectId: z.string() }).parse(await linked.json());
    await setProjectAccessAction({
      request: post(admin.cookie, '/api/organizations/projects/access', {
        orgId,
        projectId,
        userId: member.userId,
        allowed: true,
      }),
      env,
    });

    database.prepare('UPDATE organization_members SET paused_at = 1 WHERE user_id = ?').run(member.userId);
    expect(await myProjects(env, member.cookie)).toEqual([]);
    database.prepare('UPDATE organization_members SET paused_at = NULL WHERE user_id = ?').run(member.userId);
    expect(await myProjects(env, member.cookie)).toEqual(['ada/site']);

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
});
