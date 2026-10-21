import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { GitHubApp } from '~/lib/.server/github/github-app';
import { bytesToBase64 } from '~/lib/hex-digest';
import {
  runtimeGitHubCommitAction,
  runtimeGitHubSiteAction,
  runtimeGitHubSnapshotAction,
  runtimeGitHubStatusAction,
  runtimeRequestProductionAction,
} from './runtime-github';
import { runtimeCredentialAction } from './runtime-credential';
import {
  RUNTIME_GENERATION_HEADER,
  RUNTIME_USER_HEADER,
  runtimeIdentityHeaders,
} from '~/lib/.server/cloudflare/runtime-identity-headers';
import { linkedBuildStatus } from '~/lib/.server/cloudflare/linked-project-client';

const ORIGIN = 'https://cloudchef.build';
const ENCRYPTION_KEY = btoa('k'.repeat(32));
const BASE = 'a'.repeat(40);
const MAIN_HEAD = 'b'.repeat(40);

/** A tar archive (ustar), gzipped the way GitHub serves a commit: everything under one top directory. */
async function gzippedTarball(
  files: { path: string; content: string; mode?: number }[],
): Promise<Uint8Array<ArrayBuffer>> {
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  const encoder = new TextEncoder();
  const header = (name: string, size: number, mode: number, type: string) => {
    const block = new Uint8Array(512);
    const write = (offset: number, value: string) => block.set(encoder.encode(value), offset);
    write(0, name);
    write(100, `${mode.toString(8).padStart(7, '0')}\0`);
    write(108, '0000000\0');
    write(116, '0000000\0');
    write(124, `${size.toString(8).padStart(11, '0')}\0`);
    write(136, '00000000000\0');
    write(156, type);
    write(257, 'ustar\0');
    write(263, '00');
    write(148, '        ');
    const checksum = block.reduce((sum, byte) => sum + byte, 0);
    write(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
    return block;
  };
  blocks.push(header('ada-site-abc/', 0, 0o755, '5'));
  for (const file of files) {
    const bytes = encoder.encode(file.content);
    blocks.push(header(`ada-site-abc/${file.path}`, bytes.length, file.mode ?? 0o644, '0'));
    const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    padded.set(bytes);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const stream = new Blob(blocks).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipBase64(value: string): Promise<string> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return bytesToBase64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** A draft's files as a production request carries them. */
function draftSnapshot(): Promise<string> {
  return gzipBase64(JSON.stringify([{ path: 'src/app.tsx', contentBase64: btoa('export const app = 1;') }]));
}

/** One repository on GitHub: its default branch, the member branch if pushed, and what was written. */
type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string;
  output: { title?: string; summary?: string };
  app?: { slug: string };
};

const WORKERS_BUILDS_SUCCESS: CheckRun = {
  name: 'Workers Builds: site',
  status: 'completed',
  conclusion: 'success',
  details_url: 'https://dash.cloudflare.com/builds/1',
  output: { title: 'Preview ready', summary: 'Preview URL: https://cloudchef-ada-site.ada.workers.dev' },
  app: { slug: 'cloudflare-workers-and-pages' },
};

function fakeRepository(options: {
  tarball: Uint8Array<ArrayBuffer>;
  mergeStatus?: number;
  homepage?: string | null;
  checkRuns?: CheckRun[];
  /** GitHub failing to read the default branch's head, or to serve its download. */
  failing?: 'head' | 'tarball';
}) {
  const refs = new Map<string, string>([['main', MAIN_HEAD]]);
  const writes: { method: string; path: string; body: string | null }[] = [];
  let tokenRequest: string | null = null;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : null;
    const path = url.pathname.replace('/repos/ada/site', '');
    if (url.pathname.endsWith('/access_tokens')) {
      tokenRequest = body;
      return Response.json({ token: 'repo-token', expires_at: 'soon' }, { status: 201 });
    }
    if (method === 'GET' && path === '') {
      return Response.json({ full_name: 'ada/site', homepage: options.homepage ?? null });
    }
    if (
      method === 'GET' &&
      ((options.failing === 'head' && path.startsWith('/git/ref/heads/')) ||
        (options.failing === 'tarball' && path.startsWith('/tarball/')))
    ) {
      return new Response('unavailable', { status: 503 });
    }
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
      const sha = refs.get(decodeURIComponent(path.slice('/git/ref/heads/'.length)));
      return sha ? Response.json({ object: { sha } }) : new Response('missing', { status: 404 });
    }
    if (method === 'GET' && path.startsWith('/tarball/')) {
      return new Response(options.tarball);
    }
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      return Response.json({ sha: path.slice(13), tree: { sha: `tree-of-${path.slice(13, 19)}` } });
    }
    if (method === 'GET' && path.includes('/check-runs')) {
      return Response.json({ check_runs: options.checkRuns ?? [WORKERS_BUILDS_SUCCESS] });
    }
    writes.push({ method, path, body });
    if (path === '/git/blobs') {
      return Response.json({ sha: `blob-${writes.length}` }, { status: 201 });
    }
    if (path === '/git/trees') {
      return Response.json({ sha: `tree-${writes.length}` }, { status: 201 });
    }
    if (path === '/git/commits') {
      return Response.json({ sha: 'c'.repeat(40) }, { status: 201 });
    }
    if (path === '/git/refs' || path.startsWith('/git/refs/heads/')) {
      return Response.json({ object: { sha: 'c'.repeat(40) } }, { status: method === 'POST' ? 201 : 200 });
    }
    if (path === '/merges') {
      return options.mergeStatus === 409
        ? new Response('conflict', { status: 409 })
        : Response.json({ sha: 'd'.repeat(40) }, { status: 201 });
    }
    return new Response('unexpected', { status: 500 });
  };
  const app = new GitHubApp(
    { clientId: 'Iv1.test', clientSecret: 'secret', privateKey: PRIVATE_KEY.pem, slug: 'cloudchef' },
    request,
  );
  return { app, writes, refs, tokenRequested: () => tokenRequest };
}

const PRIVATE_KEY = { pem: '' };

async function setup(
  options: {
    tarball?: Uint8Array<ArrayBuffer>;
    mergeStatus?: number;
    grant?: boolean;
    homepage?: string | null;
    checkRuns?: CheckRun[];
    failing?: 'head' | 'tarball';
  } = {},
) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  PRIVATE_KEY.pem = `-----BEGIN PRIVATE KEY-----\n${bytesToBase64(der)}\n-----END PRIVATE KEY-----`;
  const { database, db } = controlPlaneDatabase();
  const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY });
  const sara = await upsertVerifiedEmailUser(db, { email: 'Sara.A@example.com' });
  database.exec(`
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-1', 'Sara''s sites', 1, 1);
    INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('org-2', 'Other', 1, 1);
    INSERT INTO cloudflare_credentials (handle, ciphertext_base64, iv_base64, created_at) VALUES ('cred', 'x', 'y', 1);
    INSERT INTO cloudflare_connections (id, org_id, account_id, status, credential_handle, connection_generation, created_at, updated_at)
      VALUES ('conn-1', 'org-1', 'account-1', 'active', 'cred', 2, 1, 1);
    INSERT INTO github_installations (org_id, installation_id, account_login, account_type, created_at, updated_at)
      VALUES ('org-1', 7, 'ada', 'User', 1, 1);
    INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'org-1', 'Site', 11, 'ada/site', 'main', 'linked', 1);
    INSERT INTO org_projects (id, org_id, name, repo_id, repo_full_name, default_branch, origin, created_at)
      VALUES ('22222222-2222-4222-8222-222222222222', 'org-2', 'Other', 12, 'ada/other', 'main', 'linked', 1);
  `);
  database
    .prepare(`INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES ('org-1', ?, 'member', 1)`)
    .run(sara.id);
  if (options.grant !== false) {
    database
      .prepare(
        `INSERT INTO org_project_access (project_id, user_id, granted_at) VALUES ('11111111-1111-4111-8111-111111111111', ?, 1)`,
      )
      .run(sara.id);
  }
  const secret = await deriveUserWorkspaceRuntimeSecret({
    encryptionKeyBase64: ENCRYPTION_KEY,
    userId: sara.id,
    accountId: 'account-1',
    connectionGeneration: 2,
    organizationConnectionId: 'conn-1',
  });
  const github = fakeRepository({
    tarball: options.tarball ?? (await gzippedTarball([{ path: 'README.md', content: 'hello\n' }])),
    mergeStatus: options.mergeStatus,
    homepage: options.homepage,
    checkRuns: options.checkRuns,
    failing: options.failing,
  });
  const call = (path: string, body: Record<string, string | number | boolean | null | object[]>, bearer = secret) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: sara.id, connectionId: 'conn-1', connectionGeneration: 2, ...body }),
    });
  /** A call as a current runtime makes it: who it is in headers, the body carrying only the request. */
  const callNamed = (
    path: string,
    body: string,
    options: { bearer?: string; userId?: string; generation?: string } = {},
  ) => {
    const headers = new Headers({
      Authorization: `Bearer ${options.bearer ?? secret}`,
      'Content-Type': 'application/json',
      ...runtimeIdentityHeaders({ userId: options.userId ?? sara.id, connectionId: 'conn-1', connectionGeneration: 2 }),
    });
    if (options.generation !== undefined) {
      headers.set(RUNTIME_GENERATION_HEADER, options.generation);
    }
    return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body });
  };
  return { database, env, sara, secret, call, callNamed, ...github };
}

/**
 * The control-plane database with another tab in it: the first time a statement is prepared that
 * matches `query`, `meanwhile` runs first, as a concurrent request would between a check and its write.
 */
class RacingD1Database implements D1Database {
  private raced = false;

  constructor(
    private readonly db: D1Database,
    private readonly query: string,
    private readonly meanwhile: () => void,
  ) {}

  prepare(query: string): D1PreparedStatement {
    if (!this.raced && query.includes(this.query)) {
      this.raced = true;
      this.meanwhile();
    }
    return this.db.prepare(query);
  }

  batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.db.batch<T>(statements);
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.db.exec(query);
  }

  withSession(constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return this.db.withSession(constraintOrBookmark);
  }

  dump(): Promise<ArrayBuffer> {
    return this.db.dump();
  }
}

const SITE = '11111111-1111-4111-8111-111111111111';
const lineSchema = z.looseObject({});

async function lines(response: Response) {
  return (await response.text())
    .trim()
    .split('\n')
    .map((line) => lineSchema.parse(JSON.parse(line)));
}

describe('a member working on a GitHub project', () => {
  it("streams the default branch's files with their git blob ids, on a token limited to the repository", async () => {
    const tarball = await gzippedTarball([
      { path: 'README.md', content: 'hello\n' },
      { path: 'scripts/build.sh', content: '#!/bin/sh\n', mode: 0o755 },
    ]);
    const { env, app, call, tokenRequested } = await setup({ tarball });
    const response = await runtimeGitHubSnapshotAction({
      request: call('/api/cloudflare/runtime-github/snapshot', { orgProjectId: SITE }),
      env,
      app,
    });
    expect(response.status).toBe(200);
    expect(await lines(response)).toEqual([
      { commit: MAIN_HEAD, defaultBranch: 'main', repository: 'ada/site' },
      {
        path: 'README.md',
        contentBase64: btoa('hello\n'),
        executable: false,
        // `git hash-object` of "hello\n".
        blobSha: 'ce013625030ba8dba906f756967f9e9ca394464a',
      },
      expect.objectContaining({ path: 'scripts/build.sh', executable: true }),
      { done: true, files: 2 },
    ]);
    expect(JSON.parse(tokenRequested() ?? '{}')).toEqual({ permissions: { contents: 'read' }, repository_ids: [11] });
  });

  it.each([
    { failing: 'head', error: 'GitHub refused the request (503).' },
    { failing: 'tarball', error: 'GitHub refused the download (503).' },
  ] as const)(
    'answers with what GitHub refused when it fails to serve the default branch ($failing)',
    async ({ failing, error }) => {
      const { env, app, call } = await setup({ failing });
      const response = await runtimeGitHubSnapshotAction({
        request: call('/api/cloudflare/runtime-github/snapshot', { orgProjectId: SITE }),
        env,
        app,
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error });
    },
  );

  it('refuses a project the member was not given, one of another organization, and a wrong runtime secret', async () => {
    const ungranted = await setup({ grant: false });
    const refused = await runtimeGitHubSnapshotAction({
      request: ungranted.call('/api/cloudflare/runtime-github/snapshot', { orgProjectId: SITE }),
      env: ungranted.env,
      app: ungranted.app,
    });
    expect(refused.status).toBe(403);

    const { env, app, call } = await setup();
    const foreign = await runtimeGitHubSnapshotAction({
      request: call('/api/cloudflare/runtime-github/snapshot', {
        orgProjectId: '22222222-2222-4222-8222-222222222222',
      }),
      env,
      app,
    });
    expect(foreign.status).toBe(403);
    const forged = await runtimeGitHubSnapshotAction({
      request: call('/api/cloudflare/runtime-github/snapshot', { orgProjectId: SITE }, 'not-the-secret'),
      env,
      app,
    });
    expect(forged.status).toBe(401);
  });

  it("commits the workspace on top of the commit it was opened from, to the member's own branch", async () => {
    const { env, app, call, writes } = await setup();
    const response = await runtimeGitHubCommitAction({
      request: call('/api/cloudflare/runtime-github/commit', {
        orgProjectId: SITE,
        baseCommit: BASE,
        message: 'Update the hero copy',
        publish: false,
        changes: [
          { path: 'src/hero.tsx', contentBase64: btoa('new hero'), executable: false },
          { path: 'public/logo.png', contentBase64: btoa('\x89PNG\r\n\x1a\n\0\0'), executable: false },
          { path: 'old.txt', contentBase64: null, executable: false },
          { path: 'bin/run', contentBase64: bytesToBase64(new TextEncoder().encode('\uFEFFcafé')), executable: true },
          { path: 'public/empty.txt', contentBase64: '', executable: false },
        ],
      }),
      env,
      app,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commit: 'c'.repeat(40),
      branch: expect.stringMatching(/^cloudchef\/sara-a-/),
    });
    // Text goes in the tree as it is; only the image and the empty file are blobs of their own.
    expect(
      writes.filter((write) => write.path === '/git/blobs').map((write) => JSON.parse(write.body ?? '{}')),
    ).toEqual([
      { content: btoa('\x89PNG\r\n\x1a\n\0\0'), encoding: 'base64' },
      { content: '', encoding: 'base64' },
    ]);
    const tree = JSON.parse(writes.find((write) => write.path === '/git/trees')?.body ?? '{}');
    expect(tree).toEqual({
      base_tree: `tree-of-${BASE.slice(0, 6)}`,
      tree: [
        { path: 'src/hero.tsx', mode: '100644', type: 'blob', content: 'new hero' },
        { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
        { path: 'bin/run', mode: '100755', type: 'blob', content: '\uFEFFcafé' },
        { path: 'public/logo.png', mode: '100644', type: 'blob', sha: 'blob-1' },
        { path: 'public/empty.txt', mode: '100644', type: 'blob', sha: 'blob-2' },
      ],
    });
    expect(JSON.parse(writes.find((write) => write.path === '/git/commits')?.body ?? '{}')).toMatchObject({
      parents: [BASE],
    });
    // A new branch is created; no merge without publishing.
    expect(writes.map((write) => `${write.method} ${write.path}`)).toContain('POST /git/refs');
    expect(writes.some((write) => write.path === '/merges')).toBe(false);
  });

  it.each(['.github/workflows/ci.yml', '/src/hero.tsx', 'src/./hero.tsx', '.git/hooks/pre-commit'])(
    'refuses a change to %s before anything is written to GitHub',
    async (path) => {
      const { env, app, call, writes } = await setup();
      const response = await runtimeGitHubCommitAction({
        request: call('/api/cloudflare/runtime-github/commit', {
          orgProjectId: SITE,
          baseCommit: BASE,
          message: 'Publish',
          publish: true,
          changes: [
            { path: 'src/hero.tsx', contentBase64: btoa('new hero'), executable: false },
            { path, contentBase64: null, executable: false },
          ],
        }),
        env,
        app,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.stringContaining(path) });
      expect(writes).toEqual([]);
    },
  );

  it('builds a commit with more text than one tree request carries over several, each on the last', async () => {
    const { env, app, callNamed, writes } = await setup();
    const large = btoa('x'.repeat(900 * 1024));
    const response = await runtimeGitHubCommitAction({
      request: callNamed(
        '/api/cloudflare/runtime-github/commit',
        JSON.stringify({
          orgProjectId: SITE,
          baseCommit: BASE,
          message: 'Add the archive',
          publish: false,
          changes: Array.from({ length: 6 }, (_, index) => ({
            path: `archive/${index}.txt`,
            contentBase64: large,
            executable: false,
          })),
        }),
      ),
      env,
      app,
    });
    expect(response.status).toBe(200);
    const trees = writes.flatMap((write, index) =>
      write.path === '/git/trees'
        ? [
            {
              sha: `tree-${index + 1}`,
              body: z
                .object({ base_tree: z.string(), tree: z.array(z.object({ path: z.string() })) })
                .parse(JSON.parse(write.body ?? '{}')),
            },
          ]
        : [],
    );
    expect(trees.map((tree) => tree.body.tree.length)).toEqual([4, 2]);
    expect(trees.map((tree) => tree.body.base_tree)).toEqual([`tree-of-${BASE.slice(0, 6)}`, trees[0]?.sha]);
    expect(JSON.parse(writes.find((write) => write.path === '/git/commits')?.body ?? '{}')).toMatchObject({
      tree: trees[1]?.sha,
    });
  });

  it('refuses a commit with more files that are not text than it can send GitHub, before writing any', async () => {
    const { env, app, call, writes } = await setup();
    const response = await runtimeGitHubCommitAction({
      request: call('/api/cloudflare/runtime-github/commit', {
        orgProjectId: SITE,
        baseCommit: BASE,
        message: 'Add the photos',
        publish: false,
        changes: Array.from({ length: 600 }, (_, index) => ({
          path: `photos/${index}.jpg`,
          contentBase64: btoa(`\xff\xd8\xff\0${index}`),
          executable: false,
        })),
      }),
      env,
      app,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: expect.stringContaining("This holds 600 files that aren't text") });
    expect(writes).toEqual([]);
  });

  it('publishes by merging into the default branch, and reports overlapping changes', async () => {
    const published = await setup();
    const change = [{ path: 'a.txt', contentBase64: btoa('a'), executable: false }];
    const merged = await runtimeGitHubCommitAction({
      request: published.call('/api/cloudflare/runtime-github/commit', {
        orgProjectId: SITE,
        baseCommit: BASE,
        message: 'Publish',
        publish: true,
        changes: change,
      }),
      env: published.env,
      app: published.app,
    });
    expect(await merged.json()).toMatchObject({ published: 'd'.repeat(40) });
    expect(JSON.parse(published.writes.find((write) => write.path === '/merges')?.body ?? '{}')).toMatchObject({
      base: 'main',
    });

    const conflicted = await setup({ mergeStatus: 409 });
    const refused = await runtimeGitHubCommitAction({
      request: conflicted.call('/api/cloudflare/runtime-github/commit', {
        orgProjectId: SITE,
        baseCommit: BASE,
        message: 'Publish',
        publish: true,
        changes: change,
      }),
      env: conflicted.env,
      app: conflicted.app,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'merge_conflict' });
  });

  it("reads the pipeline's result and preview link for a commit", async () => {
    const { env, app, call } = await setup();
    const response = await runtimeGitHubStatusAction({
      request: call('/api/cloudflare/runtime-github/status', { orgProjectId: SITE, sha: 'c'.repeat(40) }),
      env,
      app,
    });
    expect(await response.json()).toEqual({
      state: 'success',
      previewUrl: 'https://cloudchef-ada-site.ada.workers.dev',
      detailsUrl: 'https://dash.cloudflare.com/builds/1',
      conclusion: null,
      workersBuilds: true,
    });
  });

  it('counts any finished run that did not pass as failed, and judges by Workers Builds once it has a check', async () => {
    const status = async (checkRuns: CheckRun[]) => {
      const { env, app, call } = await setup({ checkRuns });
      const response = await runtimeGitHubStatusAction({
        request: call('/api/cloudflare/runtime-github/status', { orgProjectId: SITE, sha: 'c'.repeat(40) }),
        env,
        app,
      });
      return response.json();
    };
    const ci: CheckRun = {
      name: 'test',
      status: 'completed',
      conclusion: 'success',
      output: {},
      app: { slug: 'github-actions' },
    };
    for (const conclusion of ['cancelled', 'action_required', 'startup_failure', 'timed_out', 'stale']) {
      expect(await status([{ ...WORKERS_BUILDS_SUCCESS, conclusion }])).toMatchObject({ state: 'failure', conclusion });
    }
    // Skipped and neutral runs let the build stand.
    expect(await status([WORKERS_BUILDS_SUCCESS, { ...ci, conclusion: 'skipped' }])).toMatchObject({
      state: 'success',
    });
    // A CI workflow finishing before Workers Builds posts its check is not the build, and says so.
    expect(await status([ci])).toMatchObject({ state: 'success', workersBuilds: false });
    // Once Workers Builds has a check, a failed CI run elsewhere doesn't decide, and its own pending run does.
    expect(
      await status([
        { ...ci, conclusion: 'failure' },
        { ...WORKERS_BUILDS_SUCCESS, status: 'in_progress', conclusion: null },
      ]),
    ).toMatchObject({ state: 'pending', workersBuilds: true });
    // Another app's run named like Workers Builds' is not its check; a run GitHub reports no app for is
    // known by its name.
    expect(
      await status([{ ...ci, name: 'Workers Builds: fake', conclusion: 'failure' }, WORKERS_BUILDS_SUCCESS]),
    ).toMatchObject({ state: 'success', workersBuilds: true });
    expect(await status([{ ...ci, name: 'Workers Builds: impostor' }])).toMatchObject({ workersBuilds: false });
    const { app: _app, ...appless } = WORKERS_BUILDS_SUCCESS;
    expect(await status([appless])).toMatchObject({ state: 'success', workersBuilds: true });
  });

  it("commits to the conversation's own branch when the workspace names one, and refuses a malformed name", async () => {
    const { env, app, call, writes } = await setup();
    const commit = (branchKey: string) =>
      runtimeGitHubCommitAction({
        request: call('/api/cloudflare/runtime-github/commit', {
          orgProjectId: SITE,
          branchKey,
          baseCommit: BASE,
          message: 'Update',
          publish: false,
          changes: [{ path: 'a.txt', contentBase64: btoa('a'), executable: false }],
        }),
        env,
        app,
      });
    const response = await commit('k3y4chat0001');
    expect(await response.json()).toEqual({
      commit: 'c'.repeat(40),
      branch: expect.stringMatching(/^cloudchef\/sara-a-[a-z0-9]{6}-k3y4chat0001$/),
    });
    expect(JSON.parse(writes.find((write) => write.path === '/git/refs')?.body ?? '{}')).toMatchObject({
      ref: expect.stringMatching(/^refs\/heads\/cloudchef\/sara-a-[a-z0-9]{6}-k3y4chat0001$/),
    });
    expect((await commit('../main')).status).toBe(400);
  });

  it("names the project's live site from what GitHub knows: its homepage and its pipeline's links", async () => {
    const { env, app, call, tokenRequested } = await setup({ homepage: 'www.example.com' });
    const response = await runtimeGitHubSiteAction({
      request: call('/api/cloudflare/runtime-github/site', { orgProjectId: SITE }),
      env,
      app,
    });
    expect(response.status).toBe(200);
    // The default branch's head reported the preview link; the member has no branch yet.
    expect(await response.json()).toEqual({
      origins: ['https://www.example.com', 'https://cloudchef-ada-site.ada.workers.dev'],
    });
    expect(JSON.parse(tokenRequested() ?? '{}')).toEqual({
      permissions: { contents: 'read', checks: 'read' },
      repository_ids: [11],
    });

    for (const homepage of ['http://example.com', 'https://127.0.0.1', 'https://localhost:8080', 'intranet', '']) {
      const unsafe = await setup({ homepage });
      const answered = await runtimeGitHubSiteAction({
        request: unsafe.call('/api/cloudflare/runtime-github/site', { orgProjectId: SITE }),
        env: unsafe.env,
        app: unsafe.app,
      });
      expect(await answered.json()).toEqual({ origins: ['https://cloudchef-ada-site.ada.workers.dev'] });
    }

    const ungranted = await setup({ grant: false, homepage: 'example.com' });
    const refused = await runtimeGitHubSiteAction({
      request: ungranted.call('/api/cloudflare/runtime-github/site', { orgProjectId: SITE }),
      env: ungranted.env,
      app: ungranted.app,
    });
    expect(refused.status).toBe(403);
  });

  it("never hands the organization's Cloudflare authorization to a member limited to GitHub projects", async () => {
    const { database, env, sara, call } = await setup();
    database.prepare('UPDATE organization_members SET drafts_allowed = 0 WHERE user_id = ?').run(sara.id);
    const withheld = await runtimeCredentialAction({ request: call('/api/cloudflare/runtime-credential', {}), env });
    expect(withheld.status).toBe(403);
    expect(await withheld.json()).toMatchObject({ code: 'cloudflare_token_withheld' });

    // Allowed drafts again, the request goes on to the credential itself (unreadable in this test).
    database.prepare('UPDATE organization_members SET drafts_allowed = 1 WHERE user_id = ?').run(sara.id);
    const allowed = await runtimeCredentialAction({ request: call('/api/cloudflare/runtime-credential', {}), env });
    expect(allowed.status).toBe(503);
  });
  describe("the runtime's identity", () => {
    it('is checked before a large commit is read, when the runtime names itself in headers', async () => {
      const { env, app, callNamed } = await setup();
      const request = callNamed('/api/cloudflare/runtime-github/commit', ' '.repeat(1024 * 1024), {
        bearer: 'f'.repeat(43),
      });
      const forged = await runtimeGitHubCommitAction({ request, env, app });
      expect(forged.status).toBe(401);
      expect(request.bodyUsed).toBe(false);

      const malformed = await runtimeGitHubCommitAction({
        request: callNamed('/api/cloudflare/runtime-github/commit', '{}', { generation: 'two' }),
        env,
        app,
      });
      expect(malformed.status).toBe(400);
    });

    it('commits a change over 64 KB from a runtime that names itself in headers', async () => {
      const { env, app, callNamed, writes } = await setup();
      const response = await runtimeGitHubCommitAction({
        request: callNamed(
          '/api/cloudflare/runtime-github/commit',
          JSON.stringify({
            orgProjectId: SITE,
            baseCommit: BASE,
            message: 'A large change',
            publish: false,
            changes: [{ path: 'big.txt', contentBase64: btoa('x'.repeat(96 * 1024)), executable: false }],
          }),
        ),
        env,
        app,
      });
      expect(response.status).toBe(200);
      expect(writes.some((write) => write.path === '/git/commits')).toBe(true);
    });

    it('reads at most 64 KB before authenticating a runtime that names itself only in its body', async () => {
      const { env, app, call, writes } = await setup();
      const response = await runtimeGitHubCommitAction({
        request: call('/api/cloudflare/runtime-github/commit', {
          orgProjectId: SITE,
          baseCommit: BASE,
          message: 'A large change',
          publish: false,
          changes: [{ path: 'big.txt', contentBase64: btoa('x'.repeat(96 * 1024)), executable: false }],
        }),
        env,
        app,
      });
      expect(response.status).toBe(413);
      expect(writes).toEqual([]);
    });

    it('refuses a body naming someone other than the headers', async () => {
      const { env, app, callNamed } = await setup();
      const response = await runtimeGitHubStatusAction({
        request: callNamed(
          '/api/cloudflare/runtime-github/status',
          JSON.stringify({ userId: 'someone-else', orgProjectId: SITE, sha: 'c'.repeat(40) }),
        ),
        env,
        app,
      });
      expect(response.status).toBe(400);
    });

    it('reaches the control plane in headers from the runtime client', async () => {
      const { env, app, sara, secret } = await setup();
      const seen: Headers[] = [];
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push(request.headers);
        return runtimeGitHubStatusAction({ request, env, app });
      });
      try {
        const status = await linkedBuildStatus(
          { CLOUDCHEF_CONTROL_PLANE_ENDPOINT: ORIGIN, CONTROL_PLANE_SECRET: secret },
          { userId: sara.id, connectionId: 'conn-1', connectionGeneration: 2 },
          SITE,
          'c'.repeat(40),
        );
        expect(status.state).toBe('success');
      } finally {
        vi.unstubAllGlobals();
      }
      expect(seen[0]?.get(RUNTIME_USER_HEADER)).toBe(sara.id);
      expect(seen[0]?.get(RUNTIME_GENERATION_HEADER)).toBe('2');
    });
  });

  describe('production requests', () => {
    const send = (
      call: Awaited<ReturnType<typeof setup>>['call'],
      env: Awaited<ReturnType<typeof setup>>['env'],
      draft: {
        draftId?: string;
        draftRevision?: string;
        title?: string;
        note?: string;
        previewUrl?: string;
        snapshot?: string;
      },
    ) =>
      draftSnapshot().then((snapshot) =>
        runtimeRequestProductionAction({
          request: call('/api/cloudflare/runtime-github/request-production', {
            draftId: draft.draftId ?? 'chat-1',
            draftRevision: draft.draftRevision ?? 'rev-1',
            title: draft.title ?? 'Bookings',
            note: draft.note ?? '',
            previewUrl: draft.previewUrl ?? null,
            snapshot: draft.snapshot ?? snapshot,
            files: 1,
          }),
          env,
        }),
      );
    const requests = (database: Awaited<ReturnType<typeof setup>>['database']) =>
      database
        .prepare('SELECT id, draft_id, draft_revision, title, note, status, updated_at FROM production_requests')
        .all();

    it('is refused to a member limited to GitHub projects', async () => {
      const { database, env, sara, call } = await setup();
      database.prepare('UPDATE organization_members SET drafts_allowed = 0 WHERE user_id = ?').run(sara.id);
      const refused = await send(call, env, {});
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'drafts_not_allowed' });
      expect(requests(database)).toEqual([]);
    });

    it("refuses a draft whose files can't be read, before any admin sees it", async () => {
      const { database, env, call } = await setup();
      for (const snapshot of [
        'not base64!',
        btoa('not gzip'),
        await gzipBase64('not json'),
        await gzipBase64(JSON.stringify({ path: 'src/app.tsx' })),
        await gzipBase64(JSON.stringify([{ path: 'src/app.tsx', contentBase64: 'not base64!' }])),
      ]) {
        const refused = await send(call, env, { snapshot });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toEqual({ error: "The draft's files could not be read. Send it again." });
      }
      const tooLarge = await send(call, env, { snapshot: await gzipBase64(' '.repeat(25 * 1024 * 1024)) });
      expect(tooLarge.status).toBe(413);
      expect(requests(database)).toEqual([]);
    });

    it('refuses a draft holding a GitHub Actions workflow or a path GitHub refuses, saying what to remove', async () => {
      const { database, env, call } = await setup();
      const draft = (path: string) => gzipBase64(JSON.stringify([{ path, contentBase64: btoa('on: push') }]));
      const workflow = await send(call, env, { snapshot: await draft('.github/workflows/deploy.yml') });
      expect(workflow.status).toBe(400);
      expect(await workflow.json()).toEqual({
        error:
          "GitHub Actions workflow files (.github/workflows/deploy.yml) can't be published through CloudChef. " +
          'Remove the changes under .github/workflows/ and try again: Workers Builds deploys the project.',
      });
      const malformed = await send(call, env, { snapshot: await draft('src/../app.tsx') });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: expect.stringContaining('src/../app.tsx') });
      expect(requests(database)).toEqual([]);
    });

    it("carries only a draft's workers.dev preview over https for admins to open", async () => {
      const { database, env, call } = await setup();
      for (const previewUrl of [
        'http://bookings.sara.workers.dev',
        'javascript:alert(1)',
        'https://phish.example.com/login',
        'https://workers.dev',
        'https://user:pass@bookings.sara.workers.dev',
        'https://bookings.sara.workers.dev:8443',
      ]) {
        expect((await send(call, env, { previewUrl })).status).toBe(400);
      }
      expect(requests(database)).toEqual([]);
      const sent = await send(call, env, { previewUrl: 'https://bookings.sara.workers.dev/' });
      expect(sent.status).toBe(201);
    });

    it('replaces the waiting request when the same draft is sent again with a newer version', async () => {
      const { database, env, call } = await setup();
      const sent = await send(call, env, {});
      expect(sent.status).toBe(201);
      const { requestId } = z.object({ requestId: z.string() }).parse(await sent.json());

      const updated = await send(call, env, {
        draftRevision: 'rev-2',
        title: 'Bookings v2',
        note: 'Now with a calendar',
      });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toEqual({ requestId, outcome: 'updated' });
      expect(requests(database)).toEqual([
        {
          id: requestId,
          draft_id: 'chat-1',
          draft_revision: 'rev-2',
          title: 'Bookings v2',
          note: 'Now with a calendar',
          status: 'pending',
          updated_at: expect.any(Number),
        },
      ]);
    });

    it('treats the same version sent again (a reload, a second tab) as already sent', async () => {
      const { database, env, call } = await setup();
      const sent = await send(call, env, {});
      const { requestId } = z.object({ requestId: z.string() }).parse(await sent.json());
      const again = await send(call, env, {});
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ requestId, outcome: 'unchanged' });
      expect(requests(database)).toEqual([expect.objectContaining({ id: requestId, updated_at: null })]);
    });

    it('asks a different draft under the same name for its own name, and sends one with its own', async () => {
      const { database, env, call } = await setup();
      await send(call, env, {});
      const sameName = await send(call, env, { draftId: 'chat-2', title: ' bookings ' });
      expect(sameName.status).toBe(409);
      expect(await sameName.json()).toEqual({
        error: 'Another app of yours named “bookings” is waiting for review. Give this one its own name.',
      });
      const ownName = await send(call, env, { draftId: 'chat-2', title: 'Invoices' });
      expect(ownName.status).toBe(201);
      expect(requests(database)).toHaveLength(2);
    });

    it('leaves a request an admin is approving as they saw it, and tells the member to wait', async () => {
      const { database, env, call } = await setup();
      await send(call, env, {});
      database.prepare("UPDATE production_requests SET status = 'approving', claimed_at = ?").run(Date.now());
      const meanwhile = await send(call, env, { draftRevision: 'rev-2' });
      expect(meanwhile.status).toBe(409);
      expect(await meanwhile.json()).toEqual({
        error: 'An admin is approving “Bookings” right now. Wait for their decision before sending it again.',
      });
      expect(requests(database)).toEqual([
        expect.objectContaining({ draft_revision: 'rev-1', status: 'approving', updated_at: null }),
      ]);
    });

    it('replaces a request whose approval never finished, ending that approval', async () => {
      const { database, env, call } = await setup();
      await send(call, env, {});
      database
        .prepare("UPDATE production_requests SET status = 'approving', claimed_at = ?")
        .run(Date.now() - 11 * 60_000);
      const replaced = await send(call, env, { draftRevision: 'rev-2' });
      expect(replaced.status).toBe(200);
      expect(database.prepare('SELECT status, claimed_at, draft_revision FROM production_requests').get()).toEqual({
        status: 'pending',
        claimed_at: null,
        draft_revision: 'rev-2',
      });
    });

    it('lets a draft take over a request sent under its name before drafts were tracked', async () => {
      const { database, env, call } = await setup();
      const sent = await send(call, env, {});
      const { requestId } = z.object({ requestId: z.string() }).parse(await sent.json());
      database.prepare('UPDATE production_requests SET draft_id = NULL, draft_revision = NULL').run();
      const adopted = await send(call, env, { title: 'BOOKINGS', draftRevision: 'rev-2' });
      expect(await adopted.json()).toEqual({ requestId, outcome: 'updated' });
      expect(requests(database)).toEqual([expect.objectContaining({ draft_id: 'chat-1', draft_revision: 'rev-2' })]);
    });

    it('replaces the request another tab recorded for the same draft between the check and the insert', async () => {
      const { database, env, sara, call } = await setup();
      const racing = envWith({
        ...env,
        DB: new RacingD1Database(env.DB, 'INSERT OR IGNORE INTO production_requests', () => {
          database
            .prepare(
              `INSERT INTO production_requests
                 (id, org_id, requested_by, draft_id, draft_revision, title, note, preview_url,
                  snapshot_gzip_base64, snapshot_files, status, created_at)
               VALUES ('other-tab', 'org-1', ?, 'chat-1', 'rev-1', 'Bookings', NULL, NULL, 'H4sI', 1, 'pending', 1)`,
            )
            .run(sara.id);
        }),
      });
      const sent = await send(call, racing, { draftRevision: 'rev-2' });
      expect(sent.status).toBe(200);
      expect(await sent.json()).toEqual({ requestId: 'other-tab', outcome: 'updated' });
      expect(requests(database)).toEqual([
        expect.objectContaining({ id: 'other-tab', draft_id: 'chat-1', draft_revision: 'rev-2', status: 'pending' }),
      ]);
    });
  });
});
