import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BuilderWorkspaceApi,
  BuilderWorkspaceCheckpoint,
  BuilderWorkspaceFileMetadata,
} from '~/agents/builder-workspace-api';
import type {
  BuilderWorkspaceClientChange,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceSyncEntry,
} from '@cloudchef/user-workspace-runtime/protocol';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { sha256Hex } from '~/lib/hex-digest';
import { fakeArtifacts, type FakeArtifacts } from '~/test/fake-artifacts';
import { builderAgentHarness, CHAT_INITIAL_ID, eventually, type BuilderAgentHarness } from './harness';

/**
 * A CloudChef app's history: the commits on main of its own repository (`p-<chat>`), made when the agent
 * commits; a revert brings an earlier commit's files back, commits and publishes them; and a fork's chat
 * starts from its repository.
 */
const REPO = `p-${CHAT_INITIAL_ID}`;
const CHECKPOINT: BuilderWorkspaceCheckpoint = { workspaceRevision: 3, revision: 'a'.repeat(64) };
const READY = { initialized: true, revision: 3, resetRevision: 0, fileCount: 2, totalBytes: 10, seeding: false };

afterEach(() => {
  vi.restoreAllMocks();
});

/** The control plane, unreachable: commits then name the person by their user id. */
function noControlPlane() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unavailable', { status: 503 }));
}

/** A workspace holding `files` (project-relative path to text) at CHECKPOINT. */
function holding(files: Record<string, string>, checkpoint: () => BuilderWorkspaceCheckpoint = () => CHECKPOINT) {
  const entries: BuilderWorkspaceSyncEntry[] = Object.entries(files).map(([path, content]) => ({
    kind: 'write',
    path: `/home/project/${path}`,
    content,
    encoding: 'utf8',
    size: content.length,
    sha256: '',
    revision: 1,
  }));
  const workspace: Partial<BuilderWorkspaceApi> = {
    projectId: 'project-1',
    linkedProject: async () => null,
    checkpoint: async () => checkpoint(),
    getSyncPage: async () => ({ state: READY, fromRevision: 0, targetRevision: 3, mode: 'snapshot', entries }),
  };
  return workspace;
}

async function publishedHarness(
  workspace: Partial<BuilderWorkspaceApi>,
  artifacts: FakeArtifacts = fakeArtifacts(),
  onDeployed: () => void = () => undefined,
) {
  const harness = await builderAgentHarness({
    cloudflareIdentity: true,
    workspace,
    artifacts,
    publisher: {
      deploy: async () => {
        onDeployed();
        return { status: 'succeeded', id: 'deployment-1' };
      },
    },
  });
  harness.database.exec(`
    INSERT INTO deployments (
      id, chat_id, user_id, connection_id, connection_generation, workspace_reference, status, plan_json,
      plan_digest, created_at, updated_at
    ) VALUES ('deployment-1', 'chat-1', 'owner-1', 'connection-1', 1, 'ref', 'succeeded', '{}', 'digest', 1, 1);
  `);
  return harness;
}

async function finishChangingTurn(harness: BuilderAgentHarness) {
  harness.beginTurn();
  harness.agent.setState({ ...harness.agent.state, publicationPending: true });
  await harness.endTurn('completed');
}

function repositories(artifacts: FakeArtifacts) {
  return new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
}

/** The agent's commit tool, as a CloudChef app's turn gets it. */
function commitTool(harness: BuilderAgentHarness) {
  // eslint-disable-next-line dot-notation
  return harness.agent['appProjectToolContext']();
}

describe("a CloudChef app's history", () => {
  it("commits the workspace to main when the agent commits, with the agent's message", async () => {
    noControlPlane();
    const harness = await publishedHarness(holding({ 'index.html': '<h1>Hi</h1>', '.dev.vars': 'TOKEN=1' }));

    const result = await commitTool(harness).commit({ message: 'Add a greeting' });

    expect(result).toMatchObject({ ok: true });
    const head = await harness.artifacts.head(REPO);
    expect(result.data).toEqual({ hash: head, unchanged: false });
    // Local secrets never go into a commit.
    expect(await harness.artifacts.filesAt(REPO, 'main')).toEqual({ 'index.html': '<h1>Hi</h1>' });
    const [entry] = await repositories(harness.artifacts).log(REPO, { limit: 5 });
    expect(entry?.message).toBe(`Add a greeting\n\nCloudChef-Revision: ${CHECKPOINT.revision}`);
    expect(entry?.author).toEqual({ name: 'CloudChef member', email: 'owner-1@users.noreply.cloudchef.build' });

    await expect(commitTool(harness).commit({ message: 'Again' })).resolves.toMatchObject({
      ok: true,
      data: { hash: head, unchanged: true },
    });
    expect(await repositories(harness.artifacts).log(REPO, { limit: 5 })).toHaveLength(1);
  });

  it('names the member as the control plane knows them', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('runtime-access')
        ? Response.json({ organizationAdmin: false, member: { name: 'Sara', email: 'sara@example.com' } })
        : new Response('unavailable', { status: 503 }),
    );
    const harness = await publishedHarness(holding({ 'index.html': 'hi' }));
    await commitTool(harness).commit({ message: 'Hi' });
    const [entry] = await repositories(harness.artifacts).log(REPO, { limit: 1 });
    expect(entry?.author).toEqual({ name: 'Sara', email: 'sara@example.com' });
  });

  it('commits nothing by itself when production is published', async () => {
    noControlPlane();
    const harness = await publishedHarness(holding({ 'index.html': 'hi' }));
    await finishChangingTurn(harness);
    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.artifacts.repos.has(REPO)).toBe(false);
  });

  it('commits nothing when the workspace moves while it is read', async () => {
    noControlPlane();
    let reads = 0;
    const harness = await publishedHarness(
      holding({ 'index.html': 'hi' }, () =>
        (reads += 1) > 1 ? { workspaceRevision: 4, revision: 'b'.repeat(64) } : CHECKPOINT,
      ),
    );
    await expect(commitTool(harness).commit({ message: 'Hi' })).resolves.toMatchObject({ ok: false });
    expect(harness.artifacts.repos.has(REPO)).toBe(false);
  });

  it("starts a fork's chat from its repository", async () => {
    const artifacts = fakeArtifacts();
    await repositories(artifacts).commitFiles({
      repo: REPO,
      branch: 'main',
      parent: null,
      files: [
        { path: 'index.html', mode: 0o644, bytes: new TextEncoder().encode('<h1>Forked</h1>') },
        { path: 'run.sh', mode: 0o755, bytes: new TextEncoder().encode('#!') },
      ],
      message: 'Forked',
      author: { name: 'Sara', email: 'sara@example.com' },
    });
    const appended: BuilderWorkspaceFileInput[] = [];
    let initialized = false;
    const harness = await builderAgentHarness({
      artifacts,
      workspace: {
        refresh: async () => ({ ...READY, initialized }),
        beginSeed: async (seedId) => ({ status: 'started', seedId, state: READY }),
        appendSeed: async (_seedId, entries) => {
          appended.push(...entries);
          return READY;
        },
        commitSeed: async () => {
          initialized = true;
          return READY;
        },
      },
    });
    await harness.agent.prepareWorkspace();
    expect(appended.map((entry) => [entry.path, entry.mode])).toEqual([
      ['/home/project/index.html', 0o644],
      ['/home/project/run.sh', 0o755],
    ]);
    expect(atob(appended[0]?.content ?? '')).toBe('<h1>Forked</h1>');
  });
});

describe('reverting to a commit', () => {
  async function revertHarness() {
    noControlPlane();
    const artifacts = fakeArtifacts();
    const first = await repositories(artifacts).commitFiles({
      repo: REPO,
      branch: 'main',
      parent: null,
      files: [{ path: 'index.html', mode: 0o644, bytes: new TextEncoder().encode('old') }],
      message: 'First',
      author: { name: 'Sara', email: 'sara@example.com' },
    });
    const old = 'commit' in first ? first.commit : '';
    await repositories(artifacts).commitFiles({
      repo: REPO,
      branch: 'main',
      parent: old,
      files: [{ path: 'index.html', mode: 0o644, bytes: new TextEncoder().encode('new') }],
      message: 'Second',
      author: { name: 'Sara', email: 'sara@example.com' },
    });
    const current: BuilderWorkspaceFileMetadata[] = [
      {
        path: '/home/project/index.html',
        encoding: 'utf8',
        size: 3,
        mode: 0o644,
        sha256: await sha256Hex('new'),
        revision: 2,
      },
      {
        path: '/home/project/extra.ts',
        encoding: 'utf8',
        size: 1,
        mode: 0o644,
        sha256: await sha256Hex('x'),
        revision: 2,
      },
    ];
    const applied: { baseRevision: number; changes: BuilderWorkspaceClientChange[] }[] = [];
    const harness = await builderAgentHarness({
      artifacts,
      cloudflareIdentity: true,
      workspace: {
        ...holding({ 'index.html': 'old' }),
        listFiles: () => current,
        readFile: async (path) => ({
          path,
          bytes: new Uint8Array(),
          encoding: 'utf8',
          size: 0,
          mode: 0o644,
          sha256: '',
          revision: 2,
        }),
        applyClientChanges: async (request) => {
          applied.push(request);
          return { ok: true, state: READY, changedPaths: request.changes.map((change) => change.path) };
        },
      },
      publisher: { deploy: async () => ({ status: 'succeeded', id: 'deployment-1' }) },
    });
    return { harness, old, applied };
  }

  it("applies the commit's files as one change set, commits them as a revert and publishes them", async () => {
    const { harness, old, applied } = await revertHarness();
    await harness.agent.revertToCommit(old);
    expect(applied).toEqual([
      {
        baseRevision: 3,
        changes: [
          { kind: 'write', path: '/home/project/index.html', content: btoa('old'), encoding: 'base64', mode: 0o644 },
          { kind: 'delete', path: '/home/project/extra.ts' },
        ],
      },
    ]);
    expect(harness.agent.state.publicationPending).toBe(true);
    const [entry] = await repositories(harness.artifacts).log(REPO, { limit: 1 });
    expect(entry?.message).toBe(`Restore version ${old.slice(0, 7)}\n\nCloudChef-Revision: ${CHECKPOINT.revision}`);
  });

  it('is refused while a turn runs, and for a commit that is not one', async () => {
    const { harness, old, applied } = await revertHarness();
    harness.beginTurn();
    await expect(harness.agent.revertToCommit(old)).rejects.toMatchObject({ status: 409 });
    await expect(harness.agent.revertToCommit('main')).rejects.toMatchObject({ status: 400 });
    expect(applied).toEqual([]);
  });
});

describe("a draft's production request", () => {
  it("commits the draft to its own repository and names that commit to the team's admins", async () => {
    const sent: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('runtime-projects/request-production')) {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ outcome: 'requested' });
      }
      return new Response('unavailable', { status: 503 });
    });
    const harness = await builderAgentHarness({
      cloudflareIdentity: true,
      workspace: holding({ 'index.html': 'draft' }),
    });
    // A team's runtime is deployed with the shared-account flag.
    harness.env.CLOUDCHEF_SHARED_ACCOUNT = '1';

    await expect(harness.agent.requestProduction({ title: 'Bookings', note: 'Please' })).resolves.toEqual({
      outcome: 'requested',
    });
    const head = await harness.artifacts.head(REPO);
    expect(sent).toEqual([
      expect.objectContaining({
        draftId: CHAT_INITIAL_ID,
        draftRevision: CHECKPOINT.revision,
        title: 'Bookings',
        repo: REPO,
        commit: head,
      }),
    ]);
    expect(await harness.artifacts.filesAt(REPO, 'main')).toEqual({ 'index.html': 'draft' });
  });
});
