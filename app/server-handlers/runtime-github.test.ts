import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { upsertVerifiedEmailUser } from '~/lib/.server/auth';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';
import { GitHubApp } from '~/lib/.server/github/github-app';
import { bytesToBase64 } from '~/lib/hex-digest';
import {
  runtimeGitHubCommitAction,
  runtimeGitHubSnapshotAction,
  runtimeGitHubStatusAction,
  runtimeRequestProductionAction,
} from './runtime-github';
import { runtimeCredentialAction } from './runtime-credential';

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

/** One repository on GitHub: its default branch, the member branch if pushed, and what was written. */
function fakeRepository(options: { tarball: Uint8Array<ArrayBuffer>; mergeStatus?: number }) {
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
      return Response.json({
        check_runs: [
          {
            name: 'Workers Builds: site',
            status: 'completed',
            conclusion: 'success',
            details_url: 'https://dash.cloudflare.com/builds/1',
            output: { title: 'Preview ready', summary: 'Preview URL: https://cloudchef-ada-site.ada.workers.dev' },
            app: { slug: 'cloudflare-workers-and-pages' },
          },
        ],
      });
    }
    writes.push({ method, path, body });
    if (path === '/git/blobs') {
      return Response.json({ sha: `blob-${writes.length}` }, { status: 201 });
    }
    if (path === '/git/trees') {
      return Response.json({ sha: 'new-tree' }, { status: 201 });
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

async function setup(options: { tarball?: Uint8Array<ArrayBuffer>; mergeStatus?: number; grant?: boolean } = {}) {
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
  });
  const call = (path: string, body: Record<string, string | number | boolean | null | object[]>, bearer = secret) =>
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: sara.id, connectionId: 'conn-1', connectionGeneration: 2, ...body }),
    });
  return { database, env, sara, call, ...github };
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
          { path: 'old.txt', contentBase64: null, executable: false },
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
    const tree = JSON.parse(writes.find((write) => write.path === '/git/trees')?.body ?? '{}');
    expect(tree).toEqual({
      base_tree: `tree-of-${BASE.slice(0, 6)}`,
      tree: [
        { path: 'src/hero.tsx', mode: '100644', type: 'blob', sha: 'blob-1' },
        { path: 'old.txt', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(JSON.parse(writes.find((write) => write.path === '/git/commits')?.body ?? '{}')).toMatchObject({
      parents: [BASE],
    });
    // A new branch is created; no merge without publishing.
    expect(writes.map((write) => `${write.method} ${write.path}`)).toContain('POST /git/refs');
    expect(writes.some((write) => write.path === '/merges')).toBe(false);
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
    });
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
  it('sends a draft for review once, however many times the same request is submitted', async () => {
    const { database, env, call } = await setup();
    const request = (title: string) =>
      call('/api/cloudflare/runtime-github/request-production', {
        title,
        note: '',
        previewUrl: null,
        snapshot: 'H4sI',
        files: 1,
      });
    const sent = await runtimeRequestProductionAction({ request: request('Bookings'), env });
    expect(sent.status).toBe(201);
    const again = await runtimeRequestProductionAction({ request: request(' bookings '), env });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "“bookings” is already waiting for your admins' review." });
    const other = await runtimeRequestProductionAction({ request: request('Invoices'), env });
    expect(other.status).toBe(201);
    expect(database.prepare('SELECT COUNT(*) AS count FROM production_requests').get()).toEqual({ count: 2 });
  });
});
