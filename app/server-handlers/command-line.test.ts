import { afterEach, describe, expect, it, vi } from 'vitest';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import { USER_WORKSPACE_RUNTIME_SHA256 } from '~/generated/user-workspace-runtime.generated';
import { USER_WORKSPACE_SANDBOX_BASE_IMAGE } from '~/workflows/user-workspace-runtime-provisioning';
import { createCommandLineToken } from '~/lib/cloudflare/data/command-line-tokens.server';
import { controlPlaneDatabase, envWith } from '~/test/control-plane-d1';
import { createAuthSession } from '~/lib/.server/auth';
import { findReadableProject } from '~/lib/cloudflare/data/org-projects.server';
import {
  commandLineCopyProjectAction,
  commandLineGitAction,
  commandLineProjectsAction,
  commandLineVisibilityAction,
  exploreAction,
  isCommandLineGitPath,
  setUsernameAction,
} from './command-line';

const PROJECT = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const { database, db } = controlPlaneDatabase();
  database.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('user-1', 'Person', 'person@example.com', 1, 1, 1);
  `);
  const { token } = await createCommandLineToken(db, 'user-1', 'Laptop');
  return { env: envWith({ DB: db }), token };
}

function git(path: string, authorization?: string) {
  return new Request(`https://cloudchef.build${path}`, authorization ? { headers: { authorization } } : undefined);
}

describe('git from the command line', () => {
  it('answers only a project repository’s git paths', () => {
    expect(isCommandLineGitPath(`/git/${PROJECT}.git/info/refs`)).toBe(true);
    expect(isCommandLineGitPath(`/git/${PROJECT}.git/git-receive-pack`)).toBe(true);
    expect(isCommandLineGitPath(`/git/${PROJECT}.git/HEAD`)).toBe(false);
    expect(isCommandLineGitPath('/git/../api/settings.git/info/refs')).toBe(false);
  });

  it('asks git for a token, in a way git prompts for and its credential helpers store', async () => {
    const { env } = await setup();

    const answer = await commandLineGitAction({ request: git(`/git/${PROJECT}.git/info/refs`), env });

    expect(answer.status).toBe(401);
    expect(answer.headers.get('WWW-Authenticate')).toContain('Basic');
    expect(await answer.text()).toContain('command-line token');
  });

  it('refuses a password that is not a live token', async () => {
    const { env } = await setup();

    const answer = await commandLineGitAction({
      request: git(`/git/${PROJECT}.git/info/refs`, `Basic ${btoa('me:not-a-token')}`),
      env,
    });

    expect(answer.status).toBe(401);
  });

  it('says a project the person may not see is not there, with a token as git sends it', async () => {
    const { env, token } = await setup();

    const answer = await commandLineGitAction({
      request: git(`/git/${PROJECT}.git/info/refs?service=git-upload-pack`, `Basic ${btoa(`anyone:${token}`)}`),
      env,
    });

    expect(answer.status).toBe(404);
  });

  it('lists projects only for a token, as a Bearer token', async () => {
    const { env, token } = await setup();

    const refused = await commandLineProjectsAction({
      request: new Request('https://cloudchef.build/api/command-line/projects'),
      env,
    });
    expect(refused.status).toBe(401);

    const listed = await commandLineProjectsAction({
      request: new Request('https://cloudchef.build/api/command-line/projects', {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ projects: [] });
  });
});

describe('choosing a username', () => {
  async function signedInAs(userId: string) {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username)
        VALUES ('user-1', 'Person', 'person@example.com', 1, 1, 1, NULL),
               ('user-2', 'Other', 'other@example.com', 1, 1, 1, 'taken');
    `);
    const env = envWith({ DB: db });
    const cookie = (await createAuthSession(env, userId, new Request('https://cloudchef.build/'))).cookie.split(
      ';',
    )[0]!;
    const save = (username: string) =>
      setUsernameAction({
        request: new Request('https://cloudchef.build/api/profile/username', {
          method: 'POST',
          headers: { cookie, origin: 'https://cloudchef.build', 'content-type': 'application/json' },
          body: JSON.stringify({ username }),
        }),
        env,
      });
    return { database, save };
  }

  it('saves a free one, in lowercase', async () => {
    const { database, save } = await signedInAs('user-1');

    const answer = await save('Ferdous');

    expect(answer.status).toBe(200);
    expect(database.prepare(`SELECT username FROM "user" WHERE id = 'user-1'`).get()).toEqual({ username: 'ferdous' });
  });

  it('refuses one that is taken, kept back, or not an address', async () => {
    const { save } = await signedInAs('user-1');

    expect((await save('taken')).status).toBe(409);
    expect((await save('settings')).status).toBe(400);
    expect((await save('two words')).status).toBe(400);
  });
});

describe('public projects', () => {
  const SITE = '22222222-2222-4222-8222-222222222222';

  async function world() {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
        ('ada', 'Ada', 'ada@example.com', 1, 1, 1, 'ada'), ('bo', 'Bo', 'bo@example.com', 1, 1, 1, 'bo');
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('ada-own', 'ada', 'account', 'active', 1, 1);
      INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, deploys_with, created_by,
        created_at) VALUES ('${SITE}', 'ada-own', 'Site', 'site', 't-site', 'zip', 'cloudchef', 'ada', 1);
    `);
    const env = envWith({ DB: db });
    const bo = (await createCommandLineToken(db, 'bo', 'Laptop')).token;
    const ada = (await createCommandLineToken(db, 'ada', 'Laptop')).token;
    return { database, db, env, bo, ada };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const basic = (token: string) => ({ authorization: `Basic ${btoa(`x:${token}`)}` });

  it('stay private until their owner makes them public, and only their owner can', async () => {
    const { db, env, bo, ada } = await world();
    const change = (token: string, visibility: string) =>
      commandLineVisibilityAction({
        request: new Request('https://cloudchef.build/api/command-line/projects/visibility', {
          method: 'POST',
          headers: { ...bearer(token), 'content-type': 'application/json' },
          body: JSON.stringify({ project: SITE, visibility }),
        }),
        env,
      });

    expect(await findReadableProject(db, { owner: 'ada', slug: 'site' }, 'bo')).toBeNull();
    expect((await change(bo, 'public')).status).toBe(403);
    expect((await change(ada, 'public')).status).toBe(200);
    expect(await findReadableProject(db, { owner: 'ada', slug: 'site' }, 'bo')).toMatchObject({
      id: SITE,
      role: 'public',
      fullName: 'ada/site',
    });
    expect(await findReadableProject(db, { id: SITE }, 'ada')).toMatchObject({ role: 'edit' });
  });

  it('show in Explore once public, for anyone signed in', async () => {
    const { database, env, bo } = await world();
    const explore = () =>
      exploreAction({ request: new Request('https://cloudchef.build/api/explore', { headers: bearer(bo) }), env });

    expect(await (await explore()).json()).toEqual({ projects: [] });
    database.exec(`UPDATE org_projects SET visibility = 'public'`);
    expect(await (await explore()).json()).toEqual({
      projects: [
        expect.objectContaining({
          id: SITE,
          fullName: 'ada/site',
          owner: { username: 'ada', name: 'Ada' },
          copiedFrom: null,
        }),
      ],
    });
    expect((await exploreAction({ request: new Request('https://cloudchef.build/api/explore'), env })).status).toBe(
      401,
    );
  });

  it('let others clone but never push, and stay hidden while private', async () => {
    const { database, env, bo } = await world();
    const git = (path: string, init: RequestInit = {}) =>
      commandLineGitAction({ request: new Request(`https://cloudchef.build/ada/site.git${path}`, init), env });

    expect((await git('/info/refs?service=git-upload-pack', { headers: basic(bo) })).status).toBe(404);
    database.exec(`UPDATE org_projects SET visibility = 'public'`);
    const push = await git('/info/refs?service=git-receive-pack', { headers: basic(bo) });
    expect(push.status).toBe(403);
    expect(await push.text()).toContain('Make a copy');
    const pack = await git('/git-receive-pack', { method: 'POST', headers: basic(bo), body: '0000' });
    expect(pack.status).toBe(403);
  });

  it('stay readable through a teammate’s runtime after whoever made them leaves the team', async () => {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
        ('ada', 'Ada', 'ada@example.com', 1, 1, 1, 'ada'), ('bo', 'Bo', 'bo@example.com', 1, 1, 1, 'bo'),
        ('cy', 'Cy', 'cy@example.com', 1, 1, 1, 'cy'), ('di', 'Di', 'di@example.com', 1, 1, 1, 'di');
      INSERT INTO organizations (id, name, created_at, updated_at) VALUES ('team', 'Sites', 1, 1);
      INSERT INTO organization_members (org_id, user_id, role, joined_at) VALUES
        ('team', 'di', 'member', 1), ('team', 'cy', 'admin', 2);
      INSERT INTO cloudflare_connections (id, org_id, account_id, status, created_at, updated_at)
        VALUES ('team-connection', 'team', 'account', 'active', 1, 1);
      INSERT INTO org_projects (id, connection_id, org_id, name, slug, artifact_repo, created_from, deploys_with,
        created_by, created_at, visibility)
        VALUES ('${SITE}', 'team-connection', 'team', 'Site', 'site', 't-site', 'zip', 'cloudchef', 'ada', 1, 'public');
      INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
        runtime_version, status, last_error, created_at, updated_at, protocol_version) VALUES
        ('di', 'team-connection', 1, 'di-worker', 'https://di-runtime.test', 'old', 'ready', NULL, 1, 1, 2),
        ('cy', 'team-connection', 1, 'cy-worker', 'https://cy-runtime.test', 'old', 'ready', NULL, 1, 1, 2);
    `);
    const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const bo = (await createCommandLineToken(db, 'bo', 'Laptop')).token;
    const forwarded: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      forwarded.push(new URL(String(input)).origin);
      return new Response('refs');
    });
    const clone = () =>
      commandLineGitAction({
        request: new Request('https://cloudchef.build/ada/site.git/info/refs?service=git-upload-pack', {
          headers: { authorization: `Basic ${btoa(`x:${bo}`)}` },
        }),
        env,
      });

    // Ada made it and has left: an admin's runtime reads it, ahead of a member's who wasn't given it.
    expect((await clone()).status).toBe(200);
    expect(forwarded).toEqual(['https://cy-runtime.test']);

    database.exec(`DELETE FROM organization_members WHERE user_id = 'cy'`);
    const nobody = await clone();
    expect(nobody.status).toBe(409);
    database.exec(
      `INSERT INTO org_project_access (project_id, user_id, role, granted_at) VALUES ('${SITE}', 'di', 'view', 1)`,
    );
    expect((await clone()).status).toBe(200);
    expect(forwarded).toEqual(['https://cy-runtime.test', 'https://di-runtime.test']);
  });

  it('can be copied only by someone who may read them', async () => {
    const { env, bo } = await world();

    const copy = await commandLineCopyProjectAction({
      request: new Request('https://cloudchef.build/api/command-line/projects/copy', {
        method: 'POST',
        headers: { ...bearer(bo), 'content-type': 'application/json' },
        body: JSON.stringify({ project: SITE }),
      }),
      env,
    });

    expect(copy.status).toBe(404);
  });
});

describe('apps made in a chat', () => {
  const GARDEN = '44444444-4444-4444-8444-444444444444';

  async function world() {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
        ('ada', 'Ada', 'ada@example.com', 1, 1, 1, 'ada'), ('bo', 'Bo', 'bo@example.com', 1, 1, 1, 'bo');
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, created_at, updated_at)
        VALUES ('ada-own', 'ada', 'account', 'active', 1, 1);
      INSERT INTO apps (id, user_id, connection_id, repo, name, slug, site_url, created_at, updated_at)
        VALUES ('${GARDEN}', 'ada', 'ada-own', 'p-${GARDEN}', 'Garden', 'garden', 'https://garden.example', 1, 1);
    `);
    const env = envWith({ DB: db });
    const bo = (await createCommandLineToken(db, 'bo', 'Laptop')).token;
    const ada = (await createCommandLineToken(db, 'ada', 'Laptop')).token;
    return { database, env, bo, ada };
  }

  it('are listed for their owner, and become public only when the owner says', async () => {
    const { env, bo, ada } = await world();
    const listed = await commandLineProjectsAction({
      request: new Request('https://cloudchef.build/api/command-line/projects', {
        headers: { authorization: `Bearer ${ada}` },
      }),
      env,
    });
    expect(await listed.json()).toEqual({
      projects: [
        expect.objectContaining({
          id: GARDEN,
          kind: 'app',
          fullName: 'ada/garden',
          gitUrl: 'https://cloudchef.build/ada/garden.git',
          visibility: 'private',
        }),
      ],
    });

    const change = (token: string) =>
      commandLineVisibilityAction({
        request: new Request('https://cloudchef.build/api/command-line/projects/visibility', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ project: GARDEN, visibility: 'public' }),
        }),
        env,
      });
    expect((await change(bo)).status).toBe(403);
    expect((await change(ada)).status).toBe(200);

    const explore = await exploreAction({
      request: new Request('https://cloudchef.build/api/explore', { headers: { authorization: `Bearer ${bo}` } }),
      env,
    });
    expect(await explore.json()).toEqual({
      projects: [
        expect.objectContaining({ id: GARDEN, kind: 'app', fullName: 'ada/garden', siteUrl: 'https://garden.example' }),
      ],
    });
  });

  it('are hidden from others while private, and only read by them once public', async () => {
    const { database, env, bo } = await world();
    const basic = { authorization: `Basic ${btoa(`x:${bo}`)}` };
    const git = (path: string) =>
      commandLineGitAction({
        request: new Request(`https://cloudchef.build/ada/garden.git${path}`, { headers: basic }),
        env,
      });

    expect((await git('/info/refs?service=git-upload-pack')).status).toBe(404);
    database.exec(`UPDATE apps SET visibility = 'public'`);
    expect((await git('/info/refs?service=git-receive-pack')).status).toBe(403);
  });
});

describe('copying a public project', () => {
  const SITE = '33333333-3333-4333-8333-333333333333';
  const READ_ACCESS = {
    url: 'https://artifacts.test/git/cloudchef/t-site.git',
    authorization: 'Basic eDp0b2tlbg==',
    branch: 'main',
  };
  const REVOKED = {
    url: 'https://ada.runtime.test/v1/read-access/revoke',
    body: { orgProjectId: SITE, tokenId: 'token-1' },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Ada's public project, and Bo, who copies it into his own account; each has a runtime CloudChef reaches. */
  async function world(copyAnswer: () => Response) {
    const { database, db } = controlPlaneDatabase();
    database.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username) VALUES
        ('ada', 'Ada', 'ada@example.com', 1, 1, 1, 'ada'), ('bo', 'Bo', 'bo@example.com', 1, 1, 1, 'bo');
      INSERT INTO cloudflare_connections (id, user_id, account_id, status, connection_generation, created_at, updated_at)
        VALUES ('ada-own', 'ada', 'account-ada', 'active', 1, 1, 1), ('bo-own', 'bo', 'account-bo', 'active', 1, 1, 1);
      INSERT INTO org_projects (id, connection_id, name, slug, artifact_repo, created_from, deploys_with, created_by,
        created_at, visibility)
        VALUES ('${SITE}', 'ada-own', 'Site', 'site', 't-site', 'zip', 'cloudchef', 'ada', 1, 'public');
    `);
    const runtime = database.prepare(
      `INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
         runtime_version, image_digest, protocol_version, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'ready', 1, 1)`,
    );
    const current = [
      USER_WORKSPACE_RUNTIME_SHA256,
      USER_WORKSPACE_SANDBOX_BASE_IMAGE,
      USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
    ] as const;
    runtime.run('ada', 'ada-own', 'ada-runtime', 'https://ada.runtime.test', ...current);
    runtime.run('bo', 'bo-own', 'bo-runtime', 'https://bo.runtime.test', ...current);
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
        if (url === 'https://ada.runtime.test/v1/projects/read-access') {
          return Response.json({ ...READ_ACCESS, tokenId: 'token-1' });
        }
        if (url === 'https://bo.runtime.test/v1/projects/copy') {
          return copyAnswer();
        }
        return new Response(null, { status: 204 });
      }),
    );
    const env = envWith({ DB: db, CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const bo = (await createCommandLineToken(db, 'bo', 'Laptop')).token;
    const copy = () =>
      commandLineCopyProjectAction({
        request: new Request('https://cloudchef.build/api/command-line/projects/copy', {
          method: 'POST',
          headers: { authorization: `Bearer ${bo}`, 'content-type': 'application/json' },
          body: JSON.stringify({ project: SITE }),
        }),
        env,
      });
    return { calls, copy };
  }

  it('hands the copier’s runtime a token for one import, and revokes it once the copy is made', async () => {
    const { calls, copy } = await world(() =>
      Response.json({ projectId: '44444444-4444-4444-8444-444444444444', initialId: 'chat-9' }, { status: 201 }),
    );

    expect((await copy()).status).toBe(201);

    // The token's id, which revokes it, stays with CloudChef.
    expect(calls.find((call) => call.url === 'https://bo.runtime.test/v1/projects/copy')?.body).toEqual({
      name: 'Site',
      copiedFrom: SITE,
      source: READ_ACCESS,
    });
    expect(calls.at(-1)).toEqual(REVOKED);
  });

  it('revokes the token when the copy fails too', async () => {
    const { calls, copy } = await world(() => Response.json({ error: 'No room.' }, { status: 500 }));

    expect((await copy()).status).toBe(500);

    expect(calls.at(-1)).toEqual(REVOKED);
  });
});
