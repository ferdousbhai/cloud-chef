import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { envWith, userWorkspaceDatabase } from '~/test/control-plane-d1';
import { fakeArtifacts } from '~/test/fake-artifacts';
import { getAllChats } from './chat-service.server';
import { DataNotFoundError, ProjectForbiddenError, ProjectRepositoryFailureError } from './errors';
import {
  forkProject,
  importProject,
  projectCloneAccess,
  projectHistory,
  userRuntimeProjectArchiveAction,
  withRepositoryErrors,
} from './projects.server';

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
    INSERT INTO chats (id, creator_id, initial_id, description, timestamp, has_messages)
      VALUES ('chat-1', '${OWNER}', '${CHAT}', 'My Bakery', '2026-10-20T00:00:00.000Z', 1);
    INSERT INTO chat_transcripts (chat_id, subchat_index, agent_name, transition_token, created_at, updated_at)
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
      return Response.json({ projectId: TEAM_PROJECT, workersBuildsFromGitHub: true });
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
    database.prepare('UPDATE chats SET org_project_id = ?').run(TEAM_PROJECT);
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

describe("a project's clone access", () => {
  it('is a git clone command with a read token, and when it expires', async () => {
    const { env, commit, store } = await setup();
    await commit(`p-${CHAT}`, 'v1', 'First');
    expect(await projectCloneAccess(env, { sessionId: OWNER, chatInitialId: CHAT }, store)).toEqual({
      remote: `https://artifacts.test/git/cloudchef/p-${CHAT}.git`,
      token: 'art_v2_x_0123456789abcdef',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
      command: `git clone https://x:art_v2_x_0123456789abcdef@artifacts.test/git/cloudchef/p-${CHAT}.git my-bakery`,
    });
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
    expect(database.prepare('SELECT description FROM chats WHERE initial_id = ?').get(initialId)).toEqual({
      description: 'My Bakery (fork)',
    });
    expect((await getAllChats(env.DB, { sessionId: OWNER })).map((chat) => chat.initialId)).toContain(initialId);
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
    expect(database.prepare('SELECT org_project_id FROM chats WHERE initial_id = ?').get(result.initialId)).toEqual({
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
    await expect(attempt).rejects.toMatchObject({ status: 503, message: expect.stringContaining('Try again') });
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
    expect(await empty.json()).toEqual({ error: 'This project has no commits yet.' });
    expect((await archive(`chat=${CHAT}`, 'someone-else')).status).toBe(404);
  });
});
