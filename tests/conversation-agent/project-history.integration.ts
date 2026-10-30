import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceFileMetadata } from '~/agents/builder-workspace-api';
import type {
  BuilderWorkspaceClientChange,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
} from '@cloudchef/user-workspace-runtime/protocol';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { loadBuilderTemplate, STARTING_PROJECT_MESSAGE } from '~/agents/builder-template';
import { sha256Hex } from '~/lib/hex-digest';
import { fakeArtifacts, type FakeArtifacts } from '~/test/fake-artifacts';
import { chatProjectControlPlane, conversationAgentHarness } from './harness';

/**
 * A project's history: a new chat's project starts from CloudChef's starter as its first commit, and restoring a
 * version brings an earlier commit's files back into the workspace, for the agent to publish like any change.
 */
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const REPO = `t-${PROJECT_ID}`;
const READY = { initialized: true, revision: 3, resetRevision: 0, fileCount: 2, totalBytes: 10, seeding: false };

afterEach(() => {
  vi.restoreAllMocks();
});

/** The control plane, answering only that the person may edit the project. */
function editableProject() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
    String(input).endsWith('/runtime-projects/open')
      ? Response.json({
          orgProjectId: PROJECT_ID,
          name: 'Ada site',
          repo: REPO,
          defaultBranch: 'main',
          role: 'edit',
          deploysWith: 'cloudchef',
          createdFrom: 'chat',
        })
      : new Response('unavailable', { status: 503 }),
  );
}

function repositories(artifacts: FakeArtifacts) {
  return new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
}

describe("a new chat's project", () => {
  it("makes a new chat's project, its repository starting with the whole template, and seeds the workspace from it", async () => {
    const controlPlane = chatProjectControlPlane();
    const appended: BuilderWorkspaceFileInput[] = [];
    let initialized = false;
    let seededAs = '';
    const harness = await conversationAgentHarness({
      workspace: {
        refresh: async () => ({ ...READY, initialized }),
        beginSeed: async (seedId) => {
          seededAs = seedId;
          return { status: 'started', seedId, state: READY };
        },
        appendSeed: async (_seedId, entries) => {
          appended.push(...entries);
          return READY;
        },
        commitSeed: async () => {
          initialized = true;
          return READY;
        },
      },
      cloudflareIdentity: true,
    });
    await harness.agent.prepareWorkspace();

    // The chat's project is a project like any other, made from 'chat', and the chat's workspace is now its.
    const [project] = controlPlane.registered;
    expect(project).toMatchObject({ name: 'New project', repo: `t-${project?.orgProjectId}`, chat: true });
    expect(harness.database.prepare('SELECT org_project_id FROM workspaces').all()).toEqual([
      { org_project_id: project?.orgProjectId },
    ]);
    const repo = project?.repo ?? '';
    const template = await loadBuilderTemplate();
    const history = await repositories(harness.artifacts).log(repo, { limit: 5 });
    expect(history.map((commit) => [commit.message, commit.parents])).toEqual([[STARTING_PROJECT_MESSAGE, []]]);
    const committed = await harness.artifacts.filesAt(repo, 'main');
    expect(Object.keys(committed).sort()).toEqual(
      template.map((entry) => entry.path.slice('/home/project/'.length)).sort(),
    );
    expect(committed['package.json']).toBe(
      template.find((entry) => entry.path === '/home/project/package.json')?.content,
    );
    // The workspace is seeded from the project's main, as any project's is.
    expect(seededAs).toBe(`linked_${project?.orgProjectId}`);
    expect(appended.map((entry) => entry.path).sort()).toEqual(template.map((entry) => entry.path).sort());
  });
});

describe('reverting to a commit', () => {
  async function revertHarness(options: { baseUnknown?: boolean } = {}) {
    editableProject();
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
    const second = await repositories(artifacts).commitFiles({
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
    const linked: BuilderWorkspaceLinkedProject = {
      orgProjectId: PROJECT_ID,
      repository: REPO,
      name: 'Ada site',
      defaultBranch: 'main',
      baseCommit: old,
    };
    const applied: { baseRevision: number; changes: BuilderWorkspaceClientChange[] }[] = [];
    const harness = await conversationAgentHarness({
      artifacts,
      cloudflareIdentity: true,
      workspace: {
        linkedProject: async () => linked,
        knownMain: async () => (options.baseUnknown || !('commit' in second) ? null : second.commit),
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
    });
    return { harness, old, applied };
  }

  it("applies the commit's files as one change set, leaving main as it is for the agent to publish", async () => {
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
    const [entry] = await repositories(harness.artifacts).log(REPO, { limit: 1 });
    expect(entry?.message).toBe('Second');
  });

  it('is refused, changing nothing, when main took a push from elsewhere that the workspace never brought in', async () => {
    const { harness, old, applied } = await revertHarness();
    // Pushed from the person's computer after the workspace last took main.
    const pushed = await harness.artifacts.commitDirect(REPO, 'main', { 'index.html': 'from my computer' });

    let refused: (Error & { status?: number }) | null = null;
    try {
      await harness.agent.revertToCommit(old);
    } catch (error) {
      refused = error instanceof Error ? error : null;
    }
    expect(refused?.status).toBe(409);
    expect(refused?.message).toBe(
      'This project changed somewhere else since your copy was last updated, from your computer or another chat. ' +
        'Ask CloudChef to bring in the latest changes, then try again.',
    );
    expect(applied).toEqual([]);
    expect(await harness.artifacts.head(REPO)).toBe(pushed);
    expect(harness.agent.state.untoldChanges).toEqual([
      expect.stringContaining('pushed from elsewhere since git here last fetched'),
    ]);
  });

  it("says only that the copy needs bringing up to date when what it's based on isn't known", async () => {
    const { harness, old, applied } = await revertHarness({ baseUnknown: true });
    let refused: (Error & { status?: number }) | null = null;
    try {
      await harness.agent.revertToCommit(old);
    } catch (error) {
      refused = error instanceof Error ? error : null;
    }
    expect(refused?.status).toBe(409);
    expect(refused?.message).toBe(
      'CloudChef needs to bring your copy up to date with the project first. Ask it to, then try again.',
    );
    expect(applied).toEqual([]);
    expect(harness.agent.state.untoldChanges).toEqual([expect.stringContaining("hasn't fetched or pushed main yet")]);
  });

  it('is refused while a turn runs, and for a commit that is not one', async () => {
    const { harness, old, applied } = await revertHarness();
    harness.beginTurn();
    await expect(harness.agent.revertToCommit(old)).rejects.toMatchObject({ status: 409 });
    await expect(harness.agent.revertToCommit('main')).rejects.toMatchObject({ status: 400 });
    expect(applied).toEqual([]);
  });
});
