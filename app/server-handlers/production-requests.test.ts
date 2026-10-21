import { describe, expect, it, vi } from 'vitest';
import { gitHubReturnMessageText } from '~/lib/github-return-messages';
import { z } from 'zod';
import { controlPlaneDatabase, envWith, withStatementHook } from '~/test/control-plane-d1';
import { createAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { GitHubApp } from '~/lib/.server/github/github-app';
import { promotedDraftFiles, readDraftSnapshot } from '~/lib/.server/github/promote-draft';
import { bytesToBase64 } from '~/lib/hex-digest';
import { PayloadTooLargeError } from '~/lib/bounded-body';
import { GitHubError } from '~/lib/.server/github/github-api';
import {
  approveProductionRequestAction,
  completeGitHubInstallAction,
  declineProductionRequestAction,
} from './github-projects';
import { listOrganizationsAction } from './organizations';
import { updateMember } from '~/lib/cloudflare/data/organizations.server';
import { claimProductionRequestForApproval } from '~/lib/cloudflare/data/org-projects.server';

const ORIGIN = 'https://cloudchef.build';
const ORG = '33333333-3333-4333-8333-333333333333';
const REQUEST = '44444444-4444-4444-8444-444444444444';

async function gzipBase64(value: string): Promise<string> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return bytesToBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

const DRAFT_FILES = [
  { path: 'src/app.tsx', contentBase64: btoa('export const app = 1;') },
  {
    path: 'cloudflare.project.json',
    contentBase64: btoa(
      JSON.stringify({
        name: 'cloudchef-cloudflare-app',
        d1: { name: 'cloudchef-cloudflare-app', id: '0' },
        r2: { name: 'x' },
      }),
    ),
  },
];

/** What else happens while an approval runs: `commit` while CloudChef commits the draft. */
type DuringApproval = { commit?: () => Promise<void> };

/**
 * How GitHub differs from the usual: the App can't reach the new repository, or `ada/new-app` exists
 * already, with `commits` commits (none: still empty, which GitHub answers with a 409) and `paths` at the
 * top of its tree, created `createdAt` (just now unless named).
 */
type GitHubOptions = {
  appCannotReach?: boolean;
  nameTaken?: { commits: number; paths: string[]; createdAt?: string };
};

/** GitHub as the approval sees it: the admin `ada`, a new repository, and what CloudChef wrote to it. */
async function fakeGitHub(options: GitHubOptions = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const calls: { method: string; path: string; body: string | null; authorization: string | null }[] = [];
  const during: DuringApproval = {};
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      body: init?.body ? String(init.body) : null,
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    if (url.pathname.endsWith('/git/commits') && method === 'POST') {
      await during.commit?.();
    }
    if (url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: 'user-token' });
    }
    if (url.pathname === '/user') {
      return Response.json({ login: 'ada' });
    }
    if (url.pathname === '/user/repos' && options.nameTaken) {
      return Response.json({ message: 'name already exists on this account' }, { status: 422 });
    }
    if (url.pathname === '/repos/ada/new-app' && options.nameTaken) {
      return Response.json({
        id: 77,
        full_name: 'ada/new-app',
        default_branch: 'main',
        private: true,
        created_at: options.nameTaken.createdAt ?? new Date().toISOString(),
      });
    }
    if (url.pathname === '/repos/ada/new-app/commits' && options.nameTaken?.commits === 0) {
      return Response.json({ message: 'Git Repository is empty.' }, { status: 409 });
    }
    if (url.pathname === '/repos/ada/new-app/commits' && options.nameTaken) {
      return Response.json(Array.from({ length: options.nameTaken.commits }, (_, index) => ({ sha: `c${index}` })));
    }
    if (url.pathname === '/repos/ada/new-app/git/trees/main' && options.nameTaken) {
      return Response.json({ tree: options.nameTaken.paths.map((path) => ({ path })) });
    }
    if (url.pathname === '/user/repos') {
      return Response.json(
        { id: 77, full_name: 'ada/new-app', default_branch: 'main', private: true },
        { status: 201 },
      );
    }
    if (url.pathname === '/user/installations/9/repositories/77') {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/app/installations/9/access_tokens' && options.appCannotReach) {
      return new Response('repository not in installation', { status: 422 });
    }
    if (url.pathname === '/app/installations/9/access_tokens') {
      return Response.json({ token: 'repo-token', expires_at: 'soon' }, { status: 201 });
    }
    if (url.pathname === '/repos/ada/new-app/git/ref/heads/main') {
      return Response.json({ object: { sha: 'f'.repeat(40) } });
    }
    if (url.pathname.startsWith('/repos/ada/new-app/git/commits/')) {
      return Response.json({ sha: 'f'.repeat(40), tree: { sha: 'readme-tree' } });
    }
    if (url.pathname.endsWith('/git/blobs')) {
      return Response.json({ sha: `blob-${calls.length}` }, { status: 201 });
    }
    if (url.pathname.endsWith('/git/trees')) {
      return Response.json({ sha: 'tree' }, { status: 201 });
    }
    if (url.pathname.endsWith('/git/commits')) {
      return Response.json({ sha: 'e'.repeat(40) }, { status: 201 });
    }
    if (url.pathname.endsWith('/git/refs/heads/main')) {
      return Response.json({ object: { sha: 'e'.repeat(40) } });
    }
    return new Response('unexpected', { status: 500 });
  };
  const app = new GitHubApp(
    {
      clientId: 'Iv1.test',
      clientSecret: 'secret',
      privateKey: `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(der)}\n-----END PRIVATE KEY-----`,
      slug: 'cloudchef',
    },
    request,
  );
  return { app, calls, during };
}

async function setup(options: GitHubOptions = {}) {
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db });
  const signIn = async (email: string) => {
    const user = await upsertVerifiedEmailUser(db, { email });
    const cookie = (await createAuthSession(env, await prepareAuthSession(user.id))).split(';')[0];
    return { userId: user.id, cookie };
  };
  const admin = await signIn('ada@example.com');
  const sara = await signIn('sara@example.com');
  database.exec(`
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('${ORG}', 'Sites', 1, 1);
    INSERT INTO github_installations (org_id, installation_id, account_login, account_type, created_at, updated_at)
      VALUES ('${ORG}', 9, 'ada', 'User', 1, 1);
  `);
  database
    .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)`)
    .run(ORG, admin.userId);
  database
    .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)`)
    .run(ORG, sara.userId);
  database
    .prepare(
      `INSERT INTO production_requests (id, org_id, requested_by, title, note, preview_url, snapshot_gzip_base64,
         snapshot_files, status, created_at)
       VALUES (?, ?, ?, 'Recipe box', 'For the family', 'https://draft.example.workers.dev', ?, 2, 'pending', 1)`,
    )
    .run(REQUEST, ORG, sara.userId, await gzipBase64(JSON.stringify(DRAFT_FILES)));
  return { database, env, admin, sara, ...(await fakeGitHub(options)) };
}

function post(cookie: string, path: string, body: Record<string, string | boolean>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

/** What Settings shows for the code a return from GitHub carries. */
function returnedMessage(response: Response): string | null {
  return gitHubReturnMessageText(
    new URL(response.headers.get('Location') ?? '').searchParams.get('github_message') ?? '',
  );
}

describe('production requests', () => {
  it("approves a member's draft into a new repository that becomes their project", async () => {
    const { database, env, admin, sara, app, calls } = await setup();
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    expect(started.status).toBe(201);
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returned.status).toBe(303);
    expect(returnedMessage(returned)).toBe(
      'The app is now a GitHub repository, and a project its requester can work on.',
    );

    // The repository was created in the admin's account, and the draft is its first commit.
    expect(JSON.parse(calls.find((call) => call.path === '/user/repos')?.body ?? '{}')).toEqual({
      name: 'new-app',
      private: true,
      description: 'Recipe box',
      auto_init: true,
    });
    expect(
      JSON.parse(calls.find((call) => call.path.endsWith('/git/commits') && call.method === 'POST')?.body ?? '{}'),
    ).toMatchObject({ parents: ['f'.repeat(40)] });
    expect(database.prepare('SELECT repo_full_name, origin FROM org_projects').get()).toEqual({
      repo_full_name: 'ada/new-app',
      origin: 'promoted',
    });
    expect(database.prepare('SELECT user_id FROM org_project_access').get()).toEqual({ user_id: sara.userId });
    // The request keeps only its title, file count and the decision.
    expect(
      database
        .prepare(
          `SELECT status, title, snapshot_files, snapshot_gzip_base64, note, preview_url, project_id IS NOT NULL AS linked
           FROM production_requests`,
        )
        .get(),
    ).toEqual({
      status: 'approved',
      title: 'Recipe box',
      snapshot_files: 2,
      snapshot_gzip_base64: '',
      note: null,
      preview_url: null,
      linked: 1,
    });

    // Sara sees it decided.
    const listed = await listOrganizationsAction({
      request: new Request(`${ORIGIN}/api/organizations`, { headers: { cookie: sara.cookie } }),
      env,
    });
    const view = z
      .object({ organizations: z.array(z.object({ ownRequests: z.array(z.object({ status: z.string() })) })) })
      .parse(await listed.json());
    expect(view.organizations[0].ownRequests).toEqual([expect.objectContaining({ status: 'approved' })]);
  });

  it('makes no project of a request withdrawn while its repository was being made, and says so', async () => {
    const { database, env, admin, sara, app, during } = await setup();
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    // Sara is removed while CloudChef commits her draft.
    during.commit = () =>
      updateMember(env.DB, { orgId: ORG, actorId: admin.userId, userId: sara.userId, action: 'remove' });

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });

    expect(returnedMessage(returned)).toContain('the request was withdrawn and the repository is not a project');
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_projects').get()).toEqual({ n: 0 });
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_project_access').get()).toEqual({ n: 0 });
    expect(database.prepare('SELECT status, project_id, note FROM production_requests').get()).toEqual({
      status: 'declined',
      project_id: null,
      note: null,
    });
  });

  it('approves into the project its new repository was already linked as, when an approval is retried', async () => {
    const { database, env, admin, sara, app } = await setup();
    // The first try made the repository; an admin linked it, empty, before the approval was retried.
    database
      .prepare(
        `INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_by, created_at)
         VALUES ('linked-project', ?, 'new-app', 77, 'ada/new-app', 'main', 'linked', ?, 1)`,
      )
      .run(ORG, admin.userId);
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });

    expect(returned.status).toBe(303);
    expect(returnedMessage(returned)).toBe(
      'The app is now a GitHub repository, and a project its requester can work on.',
    );
    expect(database.prepare('SELECT id FROM org_projects').all()).toEqual([{ id: 'linked-project' }]);
    expect(database.prepare('SELECT project_id, user_id FROM org_project_access').all()).toEqual([
      { project_id: 'linked-project', user_id: sara.userId },
    ]);
    expect(database.prepare('SELECT status, project_id FROM production_requests').get()).toEqual({
      status: 'approved',
      project_id: 'linked-project',
    });
  });

  it('gives an admin who claimed in the same millisecond as another no hold on the request', async () => {
    const { database, env, admin } = await setup();
    const bo = await upsertVerifiedEmailUser(env.DB, { email: 'bo@example.com' });
    database
      .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)`)
      .run(ORG, bo.id);
    const claim = (adminId: string, state: string, now: number) =>
      claimProductionRequestForApproval(env.DB, {
        orgId: ORG,
        requestId: REQUEST,
        adminId,
        approval: { state, repoName: 'new-app', private: true, ttlMs: 600_000 },
        now,
      });
    const now = Date.now();

    expect(await claim(admin.userId, 'state-ada', now)).toBe(now);
    expect(await claim(bo.id, 'state-bo', now)).toBeNull();
    // Nor later: the claim is still Ada's.
    expect(await claim(bo.id, 'state-bo-again', now + 1)).toBeNull();
    expect(database.prepare('SELECT user_id FROM github_approval_states').all()).toEqual([{ user_id: admin.userId }]);
  });

  it('claims a request only together with the approval that finishes it', async () => {
    const { database, env, admin, app } = await setup();
    database.exec(`
      CREATE TRIGGER refuse_approval_state BEFORE INSERT ON github_approval_states
      BEGIN SELECT RAISE(ABORT, 'refused'); END;
    `);

    await expect(
      approveProductionRequestAction({
        request: post(admin.cookie, '/api/organizations/production-requests/approve', {
          orgId: ORG,
          requestId: REQUEST,
          repoName: 'new-app',
          private: true,
        }),
        env,
        app,
      }),
    ).rejects.toThrow('refused');

    // Nothing holds the request: it can still be decided at once.
    expect(database.prepare('SELECT status, claimed_at FROM production_requests').get()).toEqual({
      status: 'pending',
      claimed_at: null,
    });
  });

  it("hands the request back, saying what to do, when CloudChef's App can't reach the new repository", async () => {
    const { database, env, admin, app } = await setup({ appCannotReach: true });
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returnedMessage(returned)).toContain("CloudChef's GitHub App can't reach it");
    expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'pending' });
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_projects').get()).toEqual({ n: 0 });
  });

  it.each([
    { existing: 'has history of its own', nameTaken: { commits: 2, paths: ['README.md'] } },
    { existing: 'was first committed with more than a README', nameTaken: { commits: 1, paths: ['README.md', 'src'] } },
  ])(
    "refuses a repository name taken by one that $existing, without giving CloudChef's App access to it",
    async ({ nameTaken }) => {
      const { database, env, admin, app, calls } = await setup({ nameTaken });
      const started = await approveProductionRequestAction({
        request: post(admin.cookie, '/api/organizations/production-requests/approve', {
          orgId: ORG,
          requestId: REQUEST,
          repoName: 'new-app',
          private: true,
        }),
        env,
        app,
      });
      const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
      const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
      const returned = await completeGitHubInstallAction({
        request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
          headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
        }),
        env,
        app,
      });
      expect(returnedMessage(returned)).toBe(
        'A repository with that name already exists. Approve again with another name.',
      );
      expect(calls.filter((call) => call.path.startsWith('/user/installations/'))).toEqual([]);
      expect(calls.filter((call) => call.method !== 'GET' && call.path.startsWith('/repos/'))).toEqual([]);
      // Read as the admin: the App has no access to it, and is never given any.
      const reads = calls.filter(
        (call) => call.path === '/repos/ada/new-app/commits' || call.path === '/repos/ada/new-app/git/trees/main',
      );
      expect(reads.map((call) => call.path)).toEqual(
        nameTaken.commits === 1
          ? ['/repos/ada/new-app/commits', '/repos/ada/new-app/git/trees/main']
          : ['/repos/ada/new-app/commits'],
      );
      expect(reads.every((call) => call.authorization === 'Bearer user-token')).toBe(true);
      expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'pending' });
    },
  );

  it.each([
    {
      made: 'moments ago, by an approval, says to approve again in a minute',
      createdAt: undefined,
      message: 'GitHub created the repository but not its first branch yet. Approve again in a minute.',
    },
    // Made empty by hand, not by an approval moments ago: it will never gain GitHub's first commit.
    {
      made: 'an hour ago says the name is taken',
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      message: 'A repository with that name already exists. Approve again with another name.',
    },
  ])('an empty repository of that name made $made', async ({ createdAt, message }) => {
    const { database, env, admin, app, calls } = await setup({ nameTaken: { commits: 0, paths: [], createdAt } });
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returnedMessage(returned)).toBe(message);
    expect(calls.filter((call) => call.path.startsWith('/user/installations/'))).toEqual([]);
    expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'pending' });
  });

  it('approves into a repository of the same name that an earlier try created and left as GitHub made it', async () => {
    const { database, env, admin, app, calls } = await setup({ nameTaken: { commits: 1, paths: ['README.md'] } });
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returnedMessage(returned)).toBe(
      'The app is now a GitHub repository, and a project its requester can work on.',
    );
    expect(calls.some((call) => call.path === '/user/installations/9/repositories/77')).toBe(true);
    expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'approved' });
  });

  it('holds the draft the admin reviewed from the moment they click Approve', async () => {
    const { database, env, admin, app, calls } = await setup();
    const approve = (cookie: string) =>
      approveProductionRequestAction({
        request: post(cookie, '/api/organizations/production-requests/approve', {
          orgId: ORG,
          requestId: REQUEST,
          repoName: 'new-app',
          private: true,
        }),
        env,
        app,
      });
    const started = await approve(admin.cookie);
    expect(started.status).toBe(201);
    // The member's runtime finds it being approved and is told to wait (runtime-github.test.ts).
    expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'approving' });

    // Another admin can't start a second approval; the same admin, in a new tab, can.
    const other = await upsertVerifiedEmailUser(env.DB, { email: 'bo@example.com' });
    database
      .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES (?, ?, 'admin', 1)`)
      .run(ORG, other.id);
    const otherCookie = (await createAuthSession(env, await prepareAuthSession(other.id))).split(';')[0];
    expect((await approve(otherCookie)).status).toBe(409);
    const again = await approve(admin.cookie);
    expect(again.status).toBe(201);
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await again.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returnedMessage(returned)).toBe(
      'The app is now a GitHub repository, and a project its requester can work on.',
    );
    const trees = calls.filter((call) => call.path.endsWith('/git/trees')).map((call) => call.body ?? '');
    expect(trees.some((body) => body.includes('"content":"export const app = 1;"'))).toBe(true);
  });

  it('refuses to finish an approval whose draft was replaced after its claim lapsed', async () => {
    const { database, env, admin, app, calls } = await setup();
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    // Long after, the member sends another version, as the runtime replaces a request whose claim lapsed.
    database
      .prepare(
        `UPDATE production_requests SET status = 'pending', claimed_at = NULL, snapshot_gzip_base64 = ?, updated_at = 2`,
      )
      .run(await gzipBase64(JSON.stringify([{ path: 'src/app.tsx', contentBase64: btoa('swapped') }])));

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returnedMessage(returned)).toBe(
      'That request was decided or changed, or its requester left the team, while you were on GitHub. Review it and approve again.',
    );
    expect(calls.some((call) => call.path === '/user/repos')).toBe(false);
    expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'pending' });
  });

  it('creates nothing on GitHub for a draft whose files cannot be read, and says to decline it', async () => {
    const { database, env, admin, app, calls } = await setup();
    database.prepare('UPDATE production_requests SET snapshot_gzip_base64 = ?').run(await gzipBase64('not json'));
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returned.status).toBe(303);
    expect(returnedMessage(returned)).toBe(
      "CloudChef can't read this draft's files, so nothing was created on GitHub. Decline the request, and ask the " +
        'member to send it again.',
    );
    expect(calls.some((call) => call.path === '/user/repos')).toBe(false);
    expect(database.prepare('SELECT status, claimed_at FROM production_requests').get()).toEqual({
      status: 'pending',
      claimed_at: null,
    });
  });

  it('creates nothing on GitHub for a draft holding a GitHub Actions workflow, and says to decline it', async () => {
    const { database, env, admin, app, calls } = await setup();
    database
      .prepare('UPDATE production_requests SET snapshot_gzip_base64 = ?')
      .run(
        await gzipBase64(
          JSON.stringify([...DRAFT_FILES, { path: '.github/workflows/deploy.yml', contentBase64: btoa('on: push') }]),
        ),
      );
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(returnedMessage(returned)).toContain('GitHub Actions workflows');
    expect(calls.some((call) => call.path === '/user/repos')).toBe(false);
    expect(database.prepare('SELECT status, claimed_at FROM production_requests').get()).toEqual({
      status: 'pending',
      claimed_at: null,
    });
  });

  it('hands the request back when the admin cancels on GitHub', async () => {
    const { database, env, admin, app } = await setup();
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?error=access_denied&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });
    expect(database.prepare('SELECT status, claimed_at FROM production_requests').get()).toEqual({
      status: 'pending',
      claimed_at: null,
    });
  });

  it('hands the request back and returns to Settings when D1 or the network fails during an approval', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const approveWith = async (
      fails: (query: string) => boolean,
      during?: DuringApproval['commit'],
      draft: { snapshot?: string; message?: string } = {},
    ) => {
      const { database, env, admin, app, during: duringApproval } = await setup();
      const started = await approveProductionRequestAction({
        request: post(admin.cookie, '/api/organizations/production-requests/approve', {
          orgId: ORG,
          requestId: REQUEST,
          repoName: 'new-app',
          private: true,
        }),
        env,
        app,
      });
      const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
      const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
      duringApproval.commit = during;
      if (draft.snapshot) {
        database.prepare('UPDATE production_requests SET snapshot_gzip_base64 = ?').run(draft.snapshot);
      }
      const failing = withStatementHook(env.DB, (query) => {
        if (fails(query)) {
          throw new Error('D1_ERROR: storage operation exceeded timeout');
        }
      });
      const returned = await completeGitHubInstallAction({
        request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
          headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
        }),
        env: envWith({ ...env, DB: failing }),
        app,
      });
      expect(returned.status).toBe(303);
      expect(returnedMessage(returned)).toBe(draft.message ?? 'GitHub refused part of the approval. Approve again.');
      expect(returned.headers.get('Set-Cookie')).toContain('cloudchef_github_approval=;');
      return database.prepare('SELECT status, claimed_at, project_id FROM production_requests').get();
    };
    const released = { status: 'pending', claimed_at: null, project_id: null };

    // D1 fails recording the approved request: the claim is released.
    expect(await approveWith((query) => query.includes("SET status = 'approved'"))).toEqual(released);
    // The network fails while the draft is committed.
    expect(
      await approveWith(
        () => false,
        async () => {
          throw new TypeError('Network connection lost.');
        },
      ),
    ).toEqual(released);
    expect(logged).toHaveBeenCalledWith('A production approval failed', 'TypeError: Network connection lost.');
    // D1 can't release the claim either: the browser still returns to Settings, and the claim lapses later.
    expect(
      await approveWith(
        (query) => query.includes("SET status = 'approved'") || query.includes("SET status = 'pending'"),
      ),
    ).toMatchObject({ status: 'approving' });
    // Nor when GitHub refuses, or the draft is too large, and D1 can't release the claim.
    const releaseFails = (query: string) => query.includes("SET status = 'pending'");
    expect(
      await approveWith(releaseFails, async () => {
        throw new GitHubError('Server Error', 502);
      }),
    ).toMatchObject({ status: 'approving' });
    expect(
      await approveWith(releaseFails, undefined, {
        snapshot: await gzipBase64(' '.repeat(25 * 1024 * 1024)),
        message: 'This draft is larger than CloudChef can commit. Ask the member to slim it down and send it again.',
      }),
    ).toMatchObject({ status: 'approving' });
    // D1 fails at any step before GitHub is asked: the claim is released once this return has used its state.
    for (const step of [
      'SELECT org_id FROM production_requests',
      'FROM cloudflare_auth_sessions',
      'FROM organization_members',
      'FROM github_installations',
      'UPDATE production_requests SET claimed_at',
    ]) {
      expect(await approveWith((query) => query.includes(step))).toEqual(released);
    }
    // Using the state itself fails: nothing says this return holds the claim, which lapses later.
    expect(await approveWith((query) => query.includes('UPDATE github_approval_states'))).toMatchObject({
      status: 'approving',
    });
    logged.mockRestore();
  });

  it('lets an approval that never finished lapse, so the request can still be decided', async () => {
    const { database, env, admin } = await setup();
    database
      .prepare(`UPDATE production_requests SET status = 'approving', claimed_at = ?`)
      .run(Date.now() - 11 * 60_000);
    const declined = await declineProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/decline', {
        orgId: ORG,
        requestId: REQUEST,
        note: '',
      }),
      env,
    });
    expect(declined.status).toBe(204);
  });

  it('lets only an admin decide, and only once', async () => {
    const { env, admin, sara, app } = await setup();
    const byMember = await approveProductionRequestAction({
      request: post(sara.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    expect(byMember.status).toBe(403);
    const declined = await declineProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/decline', {
        orgId: ORG,
        requestId: REQUEST,
        note: 'Not now',
      }),
      env,
    });
    expect(declined.status).toBe(204);
    const again = await declineProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/decline', {
        orgId: ORG,
        requestId: REQUEST,
        note: '',
      }),
      env,
    });
    expect(again.status).toBe(409);
  });

  it('says an approval that expired at GitHub has to be started again', async () => {
    const { database, env, admin, app } = await setup();
    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });
    const { authorizeUrl } = z.object({ authorizeUrl: z.string() }).parse(await started.json());
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    database.prepare('UPDATE github_approval_states SET expires_at = 1').run();

    const returned = await completeGitHubInstallAction({
      request: new Request(`${ORIGIN}/github/return?code=c&state=${state}`, {
        headers: { cookie: `${admin.cookie}; cloudchef_github_approval=${state}` },
      }),
      env,
      app,
    });

    expect(returnedMessage(returned)).toBe('That approval expired. Approve again.');
    expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'pending' });
  });

  it('refuses to approve a request from someone no longer in the team', async () => {
    const { database, env, admin, sara, app } = await setup();
    database.prepare('DELETE FROM organization_members WHERE user_id = ?').run(sara.userId);

    const started = await approveProductionRequestAction({
      request: post(admin.cookie, '/api/organizations/production-requests/approve', {
        orgId: ORG,
        requestId: REQUEST,
        repoName: 'new-app',
        private: true,
      }),
      env,
      app,
    });

    expect(started.status).toBe(409);
    expect(await started.json()).toEqual({
      error: 'That request was already decided, its requester left the team, or another admin is approving it.',
    });
  });
});

describe('promotedDraftFiles', () => {
  it("renames the draft's Cloudflare resources to the app's own", async () => {
    const draft = await readDraftSnapshot(await gzipBase64(JSON.stringify(DRAFT_FILES)));
    const files = promotedDraftFiles(draft && 'files' in draft ? draft.files : [], 'new-app');
    const project = files.find((file) => file.path === 'cloudflare.project.json');
    expect(JSON.parse(atob(project?.contentBase64 ?? ''))).toEqual({
      name: 'new-app',
      d1: { name: 'new-app', id: '0' },
      r2: { name: 'new-app-storage' },
    });
    expect(files.find((file) => file.path === 'src/app.tsx')?.contentBase64).toBe(btoa('export const app = 1;'));
  });

  it('stops decompressing a draft that inflates past 24 MB', async () => {
    // About 25 KB of gzip that would inflate to 25 MB.
    const bomb = await gzipBase64(' '.repeat(25 * 1024 * 1024));
    expect(atob(bomb).length).toBeLessThan(64 * 1024);
    await expect(readDraftSnapshot(bomb)).rejects.toThrow(PayloadTooLargeError);
  });

  it.each(['.github/workflows/ci.yml', '/src/app.tsx', 'src//app.tsx', 'src/../app.tsx', '.git/config', 'src/'])(
    'refuses a draft holding %s, which GitHub would not take from CloudChef',
    async (path) => {
      expect(
        await readDraftSnapshot(await gzipBase64(JSON.stringify([...DRAFT_FILES, { path, contentBase64: btoa('x') }]))),
      ).toEqual({ refused: expect.stringContaining(path) });
    },
  );

  it('refuses a draft with more files that are not text than an approval can send GitHub', async () => {
    const photos = Array.from({ length: 600 }, (_, index) => ({
      path: `public/${index}.jpg`,
      contentBase64: btoa(`\xff\xd8\xff\0${index}`),
    }));
    expect(await readDraftSnapshot(await gzipBase64(JSON.stringify([...DRAFT_FILES, ...photos])))).toEqual({
      refused: expect.stringContaining("This holds 600 files that aren't text"),
    });
  });

  it('leaves a project file it cannot read as the draft had it', () => {
    const unreadable = btoa('{ not json');
    expect(promotedDraftFiles([{ path: 'cloudflare.project.json', contentBase64: unreadable }], 'new-app')).toEqual([
      { path: 'cloudflare.project.json', contentBase64: unreadable, executable: false },
    ]);
  });
});
