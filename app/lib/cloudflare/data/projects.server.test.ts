import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { envWith, userWorkspaceDatabase } from '~/test/control-plane-d1';
import { fakeArtifacts } from '~/test/fake-artifacts';
import { getAllWorkspaces } from './workspace-service.server';
import { DataNotFoundError, ProjectForbiddenError, ProjectRepositoryFailureError } from './errors';
import {
  forkProject,
  importProject,
  projectGitAddress,
  projectHistory,
  userRuntimeProjectArchiveAction,
  userRuntimeAppCopyAction,
  userRuntimeAppReadAccessAction,
  userRuntimeDeleteProjectRepositoryAction,
  userRuntimeProjectCopyAction,
  userRuntimeProjectCreateEmptyAction,
  userRuntimeProjectUploadAction,
  userRuntimeRevokeReadAccessAction,
  withRepositoryErrors,
} from './projects.server';
import { zipStream } from '~/lib/.server/cloudflare/zip-archive';

const OWNER = 'owner-1';
const CHAT = '6f1c2a7e-0000-4000-8000-000000000001';
const TEAM_PROJECT = '11111111-1111-4111-8111-111111111111';
const author = { name: 'Sara', email: 'sara@example.com' };

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const { database, db } = userWorkspaceDatabase();
  database.exec(`
    INSERT INTO workspaces (id, creator_id, initial_id, description, timestamp, has_messages)
      VALUES ('chat-1', '${OWNER}', '${CHAT}', 'My Bakery', '2026-10-20T00:00:00.000Z', 1);
    INSERT INTO conversations (workspace_id, conversation_index, agent_name, transition_token, created_at, updated_at)
      VALUES ('chat-1', 0, 'agent-1', 'token-1', 1, 1);
  `);
  const artifacts = fakeArtifacts();
  const repositories = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
  const commit = async (repo: string, content: string, message: string) => {
    const parent = await repositories.head(repo);
    const result = await repositories.commitFiles({
      repo,
      branch: 'main',
      parent,
      files: [{ path: 'index.html', mode: 0o644, bytes: new TextEncoder().encode(content) }],
      message,
      author,
    });
    return 'commit' in result ? result.commit : '';
  };
  const env = envWith({
    DB: db,
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_USER_ID: OWNER,
    CLOUDFLARE_ACCOUNT_ID: 'account-1',
    CLOUDCHEF_CONNECTION_ID: 'connection-1',
    CLOUDCHEF_CONNECTION_GENERATION: '1',
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://control-plane.test',
    CONTROL_PLANE_SECRET: 'runtime-secret',
  });
  return { database, env, artifacts, commit, store: () => repositories };
}

/** The control plane: the team project, as a member with `role` sees it, and an import's routes. */
function controlPlane(role: 'view' | 'edit', repo: string | null) {
  const calls: { route: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ route: url.slice(url.indexOf('/api/cloudflare/') + 16), body });
    if (url.endsWith('runtime-projects/open')) {
      return Response.json({ orgProjectId: body.orgProjectId, name: 'Team Site', repo, defaultBranch: 'main', role });
    }
    if (url.endsWith('runtime-projects/register-import')) {
      return Response.json({
        projectId: TEAM_PROJECT,
        importSource: { url: body.url, branch: 'main', authorization: null },
        workersBuildsFromGitHub: true,
      });
    }
    if (url.endsWith('runtime-projects/imported')) {
      return Response.json({ ok: true });
    }
    return new Response('unavailable', { status: 503 });
  });
  return calls;
}

describe("a project's history", () => {
  it("lists a CloudChef app's commits for its creator only, with the revisions they published", async () => {
    const { env, commit, store } = await setup();
    const first = await commit(`p-${CHAT}`, 'v1', `First\n\nCloudChef-Revision: ${'a'.repeat(64)}`);
    const second = await commit(`p-${CHAT}`, 'v2', 'Second');
    const history = await projectHistory(env, { sessionId: OWNER, chatInitialId: CHAT, limit: 10, offset: 0 }, store);
    expect(history).toEqual([
      { hash: second, message: 'Second', author, committedAt: expect.any(Number) },
      {
        hash: first,
        message: `First\n\nCloudChef-Revision: ${'a'.repeat(64)}`,
        author,
        committedAt: expect.any(Number),
        revision: 'a'.repeat(64),
      },
    ]);
    await expect(
      projectHistory(env, { sessionId: 'someone-else', chatInitialId: CHAT, limit: 10, offset: 0 }, store),
    ).rejects.toBeInstanceOf(DataNotFoundError);
  });

  it('is empty before the first commit', async () => {
    const { env, store } = await setup();
    expect(await projectHistory(env, { sessionId: OWNER, chatInitialId: CHAT, limit: 10, offset: 0 }, store)).toEqual(
      [],
    );
  });

  it("reads a team project's repository, by id or through its conversation, for a member who can view it", async () => {
    const { env, database, commit, store } = await setup();
    const head = await commit('t-team', 'team', 'Team commit');
    controlPlane('view', 't-team');
    expect(
      (await projectHistory(env, { sessionId: OWNER, orgProjectId: TEAM_PROJECT, limit: 10, offset: 0 }, store)).map(
        (entry) => entry.hash,
      ),
    ).toEqual([head]);
    database.prepare('UPDATE workspaces SET org_project_id = ?').run(TEAM_PROJECT);
    expect(
      (await projectHistory(env, { sessionId: OWNER, chatInitialId: CHAT, limit: 10, offset: 0 }, store)).map(
        (entry) => entry.hash,
      ),
    ).toEqual([head]);
    // Viewing is not copying.
    await expect(
      forkProject(env, { sessionId: OWNER, orgProjectId: TEAM_PROJECT, commit: head }, store),
    ).rejects.toBeInstanceOf(ProjectForbiddenError);
  });
});

describe("a project's git address", () => {
  it('names an app by its own id and a team project by its id, handing out no token of the repository', async () => {
    const { env, artifacts, database, commit } = await setup();
    await commit(`p-${CHAT}`, 'v1', 'First');
    const tokensBefore = artifacts.tokens.length;
    expect(await projectGitAddress(env, { sessionId: OWNER, chatInitialId: CHAT })).toEqual({ projectId: CHAT });

    database.exec(`UPDATE workspaces SET org_project_id = '${TEAM_PROJECT}'`);
    controlPlane('view', 't-site');
    expect(await projectGitAddress(env, { sessionId: OWNER, chatInitialId: CHAT })).toEqual({
      projectId: TEAM_PROJECT,
    });
    expect(artifacts.tokens).toHaveLength(tokensBefore);
  });

  it('is refused once the person can no longer see the team project, so a removed member has nothing to clone with', async () => {
    const { env } = await setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'Not a member.' }, { status: 403 }));
    await expect(projectGitAddress(env, { sessionId: OWNER, orgProjectId: TEAM_PROJECT })).rejects.toBeInstanceOf(
      ProjectForbiddenError,
    );
  });
});

describe('forking a project', () => {
  it('copies its history up to the commit into a new app, which lists as one', async () => {
    const { env, artifacts, database, commit, store } = await setup();
    const older = await commit(`p-${CHAT}`, 'v1', 'First');
    await commit(`p-${CHAT}`, 'v2', 'Second');
    const { initialId } = await forkProject(env, { sessionId: OWNER, chatInitialId: CHAT, commit: older }, store);
    expect(await artifacts.head(`p-${initialId}`)).toBe(older);
    expect(await artifacts.filesAt(`p-${initialId}`, 'main')).toEqual({ 'index.html': 'v1' });
    expect(database.prepare('SELECT description FROM workspaces WHERE initial_id = ?').get(initialId)).toEqual({
      description: 'My Bakery (fork)',
    });
    expect((await getAllWorkspaces(env.DB, { sessionId: OWNER })).map((chat) => chat.initialId)).toContain(initialId);
  });

  it('refuses a commit that is not in the project', async () => {
    const { env, commit, store } = await setup();
    await commit(`p-${CHAT}`, 'v1', 'First');
    await expect(
      withRepositoryErrors(forkProject(env, { sessionId: OWNER, chatInitialId: CHAT, commit: 'f'.repeat(40) }, store)),
    ).rejects.toBeInstanceOf(DataNotFoundError);
  });
});

describe('importing a repository', () => {
  it('registers the project, imports its history, reports it, and opens a chat on it', async () => {
    const { env, artifacts, database, store } = await setup();
    const head = await artifacts.addSource('https://github.com/acme/site', { 'a.txt': 'a' });
    const calls = controlPlane('edit', null);
    const result = await importProject(env, { sessionId: OWNER, url: 'https://github.com/acme/site' }, store);
    expect(result).toEqual({ projectId: TEAM_PROJECT, initialId: expect.any(String), workersBuildsFromGitHub: true });
    expect(calls.map((call) => call.route)).toEqual(['runtime-projects/register-import', 'runtime-projects/imported']);
    expect(calls[0]?.body).toEqual({ url: 'https://github.com/acme/site', name: 'site' });
    expect(calls[1]?.body).toEqual({ orgProjectId: TEAM_PROJECT, repo: `t-${TEAM_PROJECT}`, commit: head });
    expect(
      database.prepare('SELECT org_project_id FROM workspaces WHERE initial_id = ?').get(result.initialId),
    ).toEqual({
      org_project_id: TEAM_PROJECT,
    });
  });
});

describe('an import that breaks off', () => {
  it('answers with why, records nothing, and leaves the repository to import again', async () => {
    const { env, artifacts, store } = await setup();
    await artifacts.addSource('https://github.com/acme/site', {
      'a.txt': Array.from({ length: 100 }, () => crypto.randomUUID()).join(''),
    });
    artifacts.cutSource('https://github.com/acme/site', 100);
    const calls = controlPlane('edit', null);
    const attempt = withRepositoryErrors(
      importProject(env, { sessionId: OWNER, url: 'https://github.com/acme/site' }, store),
    );
    await expect(attempt).rejects.toBeInstanceOf(ProjectRepositoryFailureError);
    await expect(attempt).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('The project was added: open it under Imported projects in the menu'),
    });
    expect(calls.map((call) => call.route)).toEqual(['runtime-projects/register-import']);
    expect(await store().head(`t-${TEAM_PROJECT}`)).toBeNull();
  });
});

describe('downloading a commit', () => {
  it('streams the commit as a ZIP named after the project and the commit', async () => {
    const { env, commit, store } = await setup();
    const head = await commit(`p-${CHAT}`, 'v1', 'First');
    const response = await userRuntimeProjectArchiveAction(
      { url: new URL(`https://runtime.test/v1/projects/archive?chat=${CHAT}`), env, userId: OWNER },
      store,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="my-bakery-${head.slice(0, 7)}.zip"`,
    );
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  });

  it('answers in JSON when it cannot', async () => {
    const { env, store } = await setup();
    const archive = (query: string, userId = OWNER) =>
      userRuntimeProjectArchiveAction(
        { url: new URL(`https://runtime.test/v1/projects/archive?${query}`), env, userId },
        store,
      );
    expect((await archive(`chat=${CHAT}&project=x`)).status).toBe(400);
    expect((await archive(`chat=${CHAT}&ref=HEAD~1`)).status).toBe(400);
    const empty = await archive(`chat=${CHAT}`);
    expect(empty.status).toBe(404);
    expect(await empty.json()).toEqual({ error: 'This project has no saved versions yet.' });
    expect((await archive(`chat=${CHAT}`, 'someone-else')).status).toBe(404);
  });
});

describe('uploading a ZIP as a new project', () => {
  async function upload(env: Env, store: () => ProjectRepositories, body: BodyInit) {
    const url = new URL('https://runtime.test/v1/projects/upload?name=Bakery');
    return userRuntimeProjectUploadAction(
      { request: new Request(url, { method: 'POST', body }), url, env, userId: OWNER },
      store,
    );
  }

  /** The control plane, answering the upload's registration with `status`. */
  function registration(status: number) {
    const calls: { route: string; body: Record<string, string> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const route = url.slice(url.indexOf('/api/cloudflare/') + 16);
      calls.push({ route, body: JSON.parse(String(init?.body ?? '{}')) });
      if (route === 'runtime-projects/register-upload') {
        return status === 201
          ? Response.json({ projectId: calls.at(-1)?.body.orgProjectId }, { status })
          : Response.json({ error: 'Only an admin of the team can add projects.' }, { status });
      }
      return new Response('unavailable', { status: 503 });
    });
    return calls;
  }

  const archive = async () =>
    new Response(
      zipStream(
        [
          { path: 'bakery-main/index.html', mode: 0o644, read: async () => new TextEncoder().encode('<h1>Bread</h1>') },
          { path: 'bakery-main/run.sh', mode: 0o755, read: async () => new TextEncoder().encode('echo') },
        ],
        new Date('2026-10-26T00:00:00Z'),
      ),
    ).arrayBuffer();

  it('commits its files to a new repository, adds the project, and opens a chat on it', async () => {
    const { env, artifacts, database, store } = await setup();
    const calls = registration(201);
    const response = await upload(env, store, await archive());
    expect(response.status).toBe(201);
    const result = z.object({ projectId: z.string(), initialId: z.string() }).parse(await response.json());
    const repo = `t-${result.projectId}`;
    expect(calls.find((call) => call.route === 'runtime-projects/register-upload')?.body).toEqual({
      orgProjectId: result.projectId,
      name: 'Bakery',
      repo,
    });
    expect(await artifacts.filesAt(repo, 'main')).toEqual({ 'index.html': '<h1>Bread</h1>', 'run.sh': 'echo' });
    expect((await store().readTreeAt(repo, 'main')).files.find((file) => file.path === 'run.sh')?.mode).toBe('100755');
    expect(
      database.prepare('SELECT org_project_id FROM workspaces WHERE initial_id = ?').get(result.initialId),
    ).toEqual({
      org_project_id: result.projectId,
    });
  });

  it('deletes the repository again when the project is not added, and says why', async () => {
    const { env, artifacts, store } = await setup();
    const calls = registration(403);
    const response = await upload(env, store, await archive());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Only an admin of the team can add projects.' });
    const repo = calls.find((call) => call.route === 'runtime-projects/register-upload')?.body.repo ?? '';
    expect(await artifacts.get(repo).catch(() => null)).toBeFalsy();
  });

  it('keeps the code when the control plane gives no clear answer, since the project may have been added', async () => {
    const { env, artifacts, store } = await setup();
    const calls = registration(503);
    const response = await upload(env, store, await archive());
    expect(response.ok).toBe(false);
    expect(JSON.stringify(await response.json())).toContain('Reload the projects page');
    const repo = calls.find((call) => call.route === 'runtime-projects/register-upload')?.body.repo ?? '';
    expect(await artifacts.filesAt(repo, 'main')).toEqual({ 'index.html': '<h1>Bread</h1>', 'run.sh': 'echo' });
  });

  it("refuses a file that isn't a ZIP before anything is made", async () => {
    const { env, store } = await setup();
    const calls = registration(201);
    const response = await upload(env, store, 'plain text');
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('copying a project into this account', () => {
  const SOURCE = '33333333-3333-4333-8333-333333333333';
  const SOURCE_URL = 'https://other-account.artifacts.test/git/cloudchef/t-source.git';
  const AUTHORIZATION = `Basic ${btoa('x:read-token')}`;

  async function copy(env: Env, store: () => ProjectRepositories, authorization = AUTHORIZATION) {
    return userRuntimeProjectCopyAction(
      {
        request: new Request('https://runtime.test/v1/projects/copy', {
          method: 'POST',
          body: JSON.stringify({
            name: 'My bakery',
            copiedFrom: SOURCE,
            source: { url: SOURCE_URL, authorization, branch: 'main' },
          }),
        }),
        env,
        userId: OWNER,
      },
      store,
    );
  }

  function registration(status: number) {
    const calls: { route: string; body: Record<string, string> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const route = url.slice(url.indexOf('/api/cloudflare/') + 16);
      calls.push({ route, body: JSON.parse(String(init?.body ?? '{}')) });
      return route === 'runtime-projects/register-upload' && status === 201
        ? Response.json({ projectId: calls.at(-1)?.body.orgProjectId }, { status })
        : Response.json({ error: 'That project is no longer one you can copy.' }, { status });
    });
    return calls;
  }

  it('copies the whole history into a new repository and keeps it as a copy of its source', async () => {
    const { env, artifacts, database, store } = await setup();
    await artifacts.addSource(SOURCE_URL, { 'index.html': 'one' }, 'main', { authorization: AUTHORIZATION });
    const head = await artifacts.commitSource(SOURCE_URL, { 'index.html': 'two' }, 'Second version');
    const calls = registration(201);

    const response = await copy(env, store);

    expect(response.status).toBe(201);
    const result = z.object({ projectId: z.string(), initialId: z.string() }).parse(await response.json());
    const repo = `t-${result.projectId}`;
    expect(await artifacts.head(repo)).toBe(head);
    expect(await artifacts.filesAt(repo, 'main')).toEqual({ 'index.html': 'two' });
    expect(calls.find((call) => call.route === 'runtime-projects/register-upload')?.body).toEqual({
      orgProjectId: result.projectId,
      name: 'My bakery',
      repo,
      copiedFrom: SOURCE,
    });
    expect(
      database.prepare('SELECT org_project_id FROM workspaces WHERE initial_id = ?').get(result.initialId),
    ).toEqual({
      org_project_id: result.projectId,
    });
  });

  it('makes nothing when the source can’t be read, and deletes the copy when it isn’t kept', async () => {
    const { env, artifacts, store } = await setup();
    await artifacts.addSource(SOURCE_URL, { 'index.html': 'one' }, 'main', { authorization: AUTHORIZATION });

    const calls = registration(201);
    expect((await copy(env, store, `Basic ${btoa('x:wrong')}`)).ok).toBe(false);
    expect(calls.filter((call) => call.route === 'runtime-projects/register-upload')).toEqual([]);

    vi.restoreAllMocks();
    const refused = registration(403);
    expect((await copy(env, store)).status).toBe(409);
    const repo = refused.find((call) => call.route === 'runtime-projects/register-upload')?.body.repo ?? '';
    expect(await artifacts.get(repo).catch(() => null)).toBeFalsy();
  });
});

describe('making an empty project for history pushed from the command line', () => {
  it('makes its repository with no commits, keeps it as pushed, and opens a chat on it', async () => {
    const { env, artifacts, database, store } = await setup();
    const registered = z.object({ orgProjectId: z.string(), name: z.string(), repo: z.string(), pushed: z.boolean() });
    const calls: { route: string; body: z.infer<typeof registered> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const route = url.slice(url.indexOf('/api/cloudflare/') + 16);
      const body = registered.parse(JSON.parse(String(init?.body ?? '{}')));
      calls.push({ route, body });
      return Response.json({ projectId: body.orgProjectId }, { status: 201 });
    });

    const url = new URL('https://runtime.test/v1/projects/create-empty?name=Garden');
    const response = await userRuntimeProjectCreateEmptyAction({ url, env, userId: OWNER }, store);

    expect(response.status).toBe(201);
    const result = z.object({ projectId: z.string(), initialId: z.string() }).parse(await response.json());
    const repo = `t-${result.projectId}`;
    expect(await artifacts.head(repo)).toBeFalsy();
    expect(calls.find((call) => call.route === 'runtime-projects/register-upload')?.body).toEqual({
      orgProjectId: result.projectId,
      name: 'Garden',
      repo,
      pushed: true,
    });
    expect(
      database.prepare('SELECT org_project_id FROM workspaces WHERE initial_id = ?').get(result.initialId),
    ).toEqual({
      org_project_id: result.projectId,
    });
  });
});

describe('copying an app into a new app of this person', () => {
  const SOURCE_URL = 'https://other-account.artifacts.test/git/cloudchef/p-source.git';
  const AUTHORIZATION = `Basic ${btoa('x:read-token')}`;

  it('copies its whole history into the new app’s repository and lists it as theirs', async () => {
    const { env, artifacts, database, store } = await setup();
    await artifacts.addSource(SOURCE_URL, { 'index.html': 'one' }, 'main', { authorization: AUTHORIZATION });
    const head = await artifacts.commitSource(SOURCE_URL, { 'index.html': 'two' }, 'Second version');

    const response = await userRuntimeAppCopyAction(
      {
        request: new Request('https://runtime.test/v1/apps/copy', {
          method: 'POST',
          body: JSON.stringify({
            name: 'My garden',
            source: { url: SOURCE_URL, authorization: AUTHORIZATION, branch: 'main' },
          }),
        }),
        env,
        userId: OWNER,
      },
      store,
    );

    expect(response.status).toBe(201);
    const { initialId } = z.object({ initialId: z.string() }).parse(await response.json());
    expect(await artifacts.head(`p-${initialId}`)).toBe(head);
    expect(
      database
        .prepare('SELECT description, has_messages, org_project_id FROM workspaces WHERE initial_id = ?')
        .get(initialId),
    ).toEqual({ description: 'My garden', has_messages: 1, org_project_id: null });
  });

  it('gives a read token only for the person’s own app', async () => {
    const { env, store } = await setup();
    const ask = (appId: string) =>
      userRuntimeAppReadAccessAction(
        {
          request: new Request('https://runtime.test/v1/apps/read-access', {
            method: 'POST',
            body: JSON.stringify({ appId }),
          }),
          env,
          userId: OWNER,
        },
        store,
      );

    expect((await ask('99999999-9999-4999-8999-999999999999')).status).toBe(404);
  });

  it('gives none for a team’s draft an admin approved, whose repository is the team project’s now', async () => {
    const { env, store, commit } = await setup();
    await commit(`p-${CHAT}`, 'draft', 'Draft');
    const teamEnv = { ...env, CLOUDCHEF_SHARED_ACCOUNT: '1' };
    let adoptedBy: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('runtime-projects/adoption')
        ? Response.json({ orgProjectId: adoptedBy })
        : new Response('unavailable', { status: 503 }),
    );
    const ask = () =>
      userRuntimeAppReadAccessAction(
        {
          request: new Request('https://runtime.test/v1/apps/read-access', {
            method: 'POST',
            body: JSON.stringify({ appId: CHAT }),
          }),
          env: teamEnv,
          userId: OWNER,
        },
        store,
      );

    expect((await ask()).status).toBe(200);
    adoptedBy = TEAM_PROJECT;
    const refused = await ask();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'This app is now one of your team’s projects. Open it from Team projects to keep working on it.',
    });
  });

  it('gives a read token good for one copy, which is revoked by its id once the copy is done', async () => {
    const { env, artifacts, commit, store } = await setup();
    await commit(`p-${CHAT}`, 'v1', 'First');
    const answer = await userRuntimeAppReadAccessAction(
      {
        request: new Request('https://runtime.test/v1/apps/read-access', {
          method: 'POST',
          body: JSON.stringify({ appId: CHAT }),
        }),
        env,
        userId: OWNER,
      },
      store,
    );
    const { tokenId } = z.object({ tokenId: z.string() }).parse(await answer.json());
    expect(artifacts.tokens.find((token) => token.id === tokenId)).toMatchObject({ scope: 'read', ttl: 35 * 60 });

    const revoked = await userRuntimeRevokeReadAccessAction(
      {
        request: new Request('https://runtime.test/v1/read-access/revoke', {
          method: 'POST',
          body: JSON.stringify({ appId: CHAT, tokenId }),
        }),
        env,
      },
      store,
    );
    expect(revoked.status).toBe(204);
    expect(artifacts.revoked).toContain(tokenId);
  });
});

describe('deleting a project’s repository', () => {
  it('deletes it only once CloudChef says this person may delete the project, and again is done', async () => {
    const { env, artifacts, commit, store } = await setup();
    await commit('t-storefront', 'v1', 'First');
    let answer: Response = Response.json(
      { error: 'Only the project’s owner, or one of its team’s admins, can delete it.' },
      { status: 403 },
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('runtime-projects/deletable')
        ? answer.clone()
        : new Response('unavailable', { status: 503 }),
    );
    const ask = () =>
      userRuntimeDeleteProjectRepositoryAction(
        {
          request: new Request('https://runtime.test/v1/projects/delete-repository', {
            method: 'POST',
            body: JSON.stringify({ orgProjectId: TEAM_PROJECT }),
          }),
          env,
        },
        store,
      );

    expect((await ask()).status).toBe(403);
    expect(artifacts.repos.has('t-storefront')).toBe(true);

    answer = Response.json({ repo: 't-storefront' });
    expect((await ask()).status).toBe(204);
    expect(artifacts.repos.has('t-storefront')).toBe(false);
    expect((await ask()).status).toBe(204);
  });
});
