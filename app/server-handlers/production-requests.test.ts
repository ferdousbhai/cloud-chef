import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession, prepareAuthSession, upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { GitHubApp } from '~/lib/.server/github/github-app';
import { promotedDraftFiles } from '~/lib/.server/github/promote-draft';
import { bytesToBase64 } from '~/lib/hex-digest';
import {
  approveProductionRequestAction,
  completeGitHubInstallAction,
  declineProductionRequestAction,
} from './github-projects';
import { listOrganizationsAction } from './organizations';

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

/** GitHub as the approval sees it: the admin `ada`, a new repository, and what CloudChef wrote to it. */
async function fakeGitHub(options: { appCannotReach?: boolean } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const calls: { method: string; path: string; body: string | null }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init?.body ? String(init.body) : null });
    if (url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: 'user-token' });
    }
    if (url.pathname === '/user') {
      return Response.json({ login: 'ada' });
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
  return { app, calls };
}

async function setup(options: { appCannotReach?: boolean } = {}) {
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
    expect(new URL(returned.headers.get('Location') ?? '').searchParams.get('github_message')).toBe(
      'Recipe box is now ada/new-app.',
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
    expect(database.prepare('SELECT status, snapshot_gzip_base64 FROM production_requests').get()).toEqual({
      status: 'approved',
      snapshot_gzip_base64: '',
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
    expect(new URL(returned.headers.get('Location') ?? '').searchParams.get('github_message')).toContain(
      "CloudChef's GitHub App can't reach it",
    );
    expect(database.prepare('SELECT status FROM production_requests').get()).toEqual({ status: 'pending' });
    expect(database.prepare('SELECT COUNT(*) AS n FROM org_projects').get()).toEqual({ n: 0 });
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
});

describe('promotedDraftFiles', () => {
  it("renames the draft's Cloudflare resources to the app's own", async () => {
    const files = await promotedDraftFiles(await gzipBase64(JSON.stringify(DRAFT_FILES)), 'new-app');
    const project = files.find((file) => file.path === 'cloudflare.project.json');
    expect(JSON.parse(atob(project?.contentBase64 ?? ''))).toEqual({
      name: 'new-app',
      d1: { name: 'new-app', id: '0' },
      r2: { name: 'new-app-storage' },
    });
    expect(files.find((file) => file.path === 'src/app.tsx')?.contentBase64).toBe(btoa('export const app = 1;'));
  });
});
