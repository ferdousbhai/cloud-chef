import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from '~/agents/builder-workspace-api';
import type { BuilderWorkspaceLinkedProject } from '@cloudchef/user-workspace-runtime/protocol';
import { sha256Hex } from '~/lib/hex-digest';
import { fakeArtifacts, type FakeArtifacts } from '~/test/fake-artifacts';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { builderAgentHarness, type BuilderAgentHarness } from './harness';

/**
 * A team project's conversation that a newer one in its chat took over is kept to read: nothing changes the
 * workspace or reaches the repository from it, and it stops when the newer one starts, before that one works
 * on the workspace.
 */

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const REPO = `t-${PROJECT_ID}`;
/** The project's repository, holding the commit every workspace below was opened from. */
let artifacts: FakeArtifacts;
let BASE: string;

beforeEach(async () => {
  artifacts = fakeArtifacts();
  await artifacts.create(REPO);
  BASE = await artifacts.commitDirect(REPO, 'main', { 'README.md': 'hello' }, 'Initial commit');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function linkedWorkspace(
  setLinkedProject: (value: BuilderWorkspaceLinkedProject) => void = () => undefined,
): Promise<Partial<BuilderWorkspaceApi>> {
  const linked: BuilderWorkspaceLinkedProject = {
    orgProjectId: PROJECT_ID,
    repository: REPO,
    name: 'Ada site',
    defaultBranch: 'main',
    baseCommit: BASE,
    baseManifest: [{ path: 'README.md', sha256: await sha256Hex('hello'), executable: false }],
    branchKey: 'k3y4chat0001',
    workspaceModes: true,
  };
  const file: BuilderWorkspaceFileMetadata = {
    path: '/home/project/README.md',
    encoding: 'utf8',
    size: 7,
    mode: 0o644,
    sha256: await sha256Hex('changed'),
    revision: 4,
  };
  return {
    linkedProject: async () => linked,
    setLinkedProject: async (value) => setLinkedProject(value),
    listFiles: () => [file],
    readFile: async (path) => {
      const bytes = new TextEncoder().encode('changed');
      return { path, bytes, encoding: 'utf8', size: bytes.length, mode: 0o644, sha256: file.sha256, revision: 4 };
    },
    cancelActiveValidation: async () => undefined,
    applyClientChanges: async () => {
      throw new Error('A closed conversation must not reach the workspace.');
    },
  };
}

/** The person started a newer conversation in the project's chat, which closes this one. */
async function close(harness: BuilderAgentHarness) {
  harness.database.prepare(`UPDATE chats SET org_project_id = ?`).run(PROJECT_ID);
  await harness.startConversation();
}

type Publish = (
  input: { message: string; live: boolean },
  options: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<CloudChefToolResult>;

/** The publish tool's implementation, which the model's `publish` and `publish_preview` call. */
function publishTool(harness: BuilderAgentHarness): Publish {
  // Element access reaches the private method TypeScript-checked, as the model tools' context calls it;
  // dot access would not compile, and a public method would be Durable Object RPC.
  // eslint-disable-next-line dot-notation
  return (input, options) => harness.agent['publishLinkedProject'](input, options);
}

/** The control plane opening the project for its member, who may edit it. */
function controlPlane() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('runtime-projects/open')) {
      return Response.json({
        orgProjectId: PROJECT_ID,
        name: 'Ada site',
        repo: REPO,
        defaultBranch: 'main',
        role: 'edit',
        member: { name: 'Sara', email: 'sara@example.com' },
      });
    }
    return new Response('unavailable', { status: 503 });
  });
  return artifacts.pushes;
}

/** Runs `during` as each push reaches the repository, before the repository answers it. */
function onPush(during: () => Promise<void> | void) {
  const fetchRepository = artifacts.fetch;
  artifacts.fetch = async (input, init) => {
    if (String(input).endsWith('/git-receive-pack')) {
      await during();
    }
    return fetchRepository(input, init);
  };
}

async function harnessWith(workspace: Partial<BuilderWorkspaceApi>) {
  return builderAgentHarness({ workspace, cloudflareIdentity: true, artifacts });
}

describe('an earlier conversation on a team project', () => {
  it('refuses saves, approvals and publishing once a newer conversation took over', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    const proposal = await harness.proposeCloudflareRequest();
    const commits = controlPlane();
    await close(harness);

    const save = harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [] });
    await expect(save).rejects.toMatchObject({ status: 409 });
    await expect(harness.agent.approveCloudflareExecution({ executionId: proposal.executionId })).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    expect(harness.cloudflareExecution(proposal.executionId)?.status).toBe('awaiting_approval');

    const published = await publishTool(harness)({ message: 'Ship it', live: true }, { toolCallId: 'call-1' });
    expect(published).toMatchObject({ ok: false });
    expect(published.summary).toContain('A newer chat continues this project.');
    expect(commits).toEqual([]);
  });

  it('refuses saves and publishing once the member deleted it, though its agent and turn live on', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    const commits = controlPlane();
    // A deleted chat's project is going away: a publish from its running turn must not reach the repository.
    harness.database.prepare(`UPDATE chats SET org_project_id = ?, is_deleted = 1`).run(PROJECT_ID);

    await expect(harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [] })).rejects.toMatchObject({
      status: 409,
    });
    const published = await publishTool(harness)({ message: 'Ship it', live: true }, { toolCallId: 'call-1' });
    expect(published).toMatchObject({ ok: false });
    expect(published.summary).toContain('was deleted');
    expect(commits).toEqual([]);
  });

  it('holds back the newer conversation until an editor save that found it current lands', async () => {
    vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) });
    let saving = false;
    let finishSave: () => void = () => undefined;
    const saved = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const harness = await builderAgentHarness({
      workspace: {
        ...(await linkedWorkspace()),
        applyClientChanges: async () => {
          saving = true;
          await saved;
          return { ok: true, state: READY_STATE, changedPaths: ['README.md'] };
        },
      },
      cloudflareIdentity: true,
    });
    const save = harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [] });
    await vi.waitFor(() => expect(saving).toBe(true));

    await close(harness);
    let settled = false;
    const settling = harness.agent.settleForSuccessor('owner-1').then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    finishSave();
    await expect(save).resolves.toMatchObject({ ok: true });
    await settling;
  });

  it('stops its running turn when the newer conversation asks, and says it is closed', async () => {
    // Workers' scheduler, which a cancellation waits on, is not Node's.
    vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) });
    const harness = await harnessWith(await linkedWorkspace());
    harness.agent.setState({
      ...harness.agent.state,
      activeTurn: { id: 'turn-1', requestId: 'request-1', status: 'accepted' },
      linkedProject: { repository: 'Ada site', repo: REPO, defaultBranch: 'main' },
    });
    // Still the current conversation: nothing stops it.
    await expect(harness.agent.settleForSuccessor('owner-1')).rejects.toMatchObject({ status: 409 });
    expect(harness.agent.state.activeTurn).not.toBeNull();

    await close(harness);
    await expect(harness.agent.settleForSuccessor('someone-else')).rejects.toMatchObject({ status: 404 });
    await harness.agent.settleForSuccessor('owner-1');
    expect(harness.agent.state.activeTurn).toBeNull();
    expect(harness.agent.state.lastCompletedTurn).toMatchObject({ id: 'turn-1', status: 'aborted' });
    expect(harness.agent.state.conversationClosed).toBe(true);
  });
});

describe("a team project's publish", () => {
  it('holds back the newer conversation until a publish already on its way to the repository lands', async () => {
    vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) });
    const bases: string[] = [];
    const harness = await harnessWith(await linkedWorkspace((value) => bases.push(value.baseCommit)));
    controlPlane();
    let committing = false;
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    onPush(async () => {
      committing = true;
      await answered;
    });
    // The publish tool as the model's turn holds it.
    // eslint-disable-next-line dot-notation
    const tools = await harness.agent['createLinkedProjectToolContext']();
    const publishing = tools?.publish({ message: 'Ship it', live: true }, { toolCallId: 'call-1' });
    await vi.waitFor(() => expect(committing).toBe(true));

    await close(harness);
    let settled = false;
    const settling = harness.agent.settleForSuccessor('owner-1').then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    answer();
    await settling;
    await publishing;
    // The base the newer conversation works from is the commit made from this workspace.
    const branchCommit = await artifacts.head(REPO, 'cloudchef/sara-owner0-k3y4chat0001');
    expect(bases).toEqual([branchCommit]);
  });

  it('leaves nothing waiting for a CloudChef deployment, which a team project never has', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    // Recorded by a turn before team projects stopped asking for CloudChef's publication.
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });

    harness.beginTurn();
    await harness.endTurn();

    expect(harness.agent.state.publicationPending).toBe(false);
  });

  it("commits to the conversation's own branch on top of its base, and is called off only before the commit", async () => {
    const harness = await harnessWith(await linkedWorkspace());
    const pushes = controlPlane();
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      publishTool(harness)({ message: 'Ship it', live: false }, { toolCallId: 'call-1', abortSignal: stopped.signal }),
    ).rejects.toThrow();
    expect(pushes).toEqual([]);

    const result = await publishTool(harness)({ message: 'Ship it', live: false }, { toolCallId: 'call-2' });
    const branch = 'cloudchef/sara-owner0-k3y4chat0001';
    expect(pushes.map((push) => push.ref)).toEqual([`refs/heads/${branch}`]);
    expect(result).toMatchObject({ ok: true, data: { branch, live: false, build: 'pending' } });
    expect(await artifacts.filesAt(REPO, branch)).toEqual({ 'README.md': 'changed' });
    expect(await artifacts.head(REPO)).toBe(BASE);
    // Published again, the branch is replaced: still one commit on top of the base.
    await publishTool(harness)({ message: 'Again', live: false }, { toolCallId: 'call-3' });
    const head = await artifacts.head(REPO, branch);
    const repositories = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
    expect((await repositories.resolve(REPO, head ?? ''))?.parents).toEqual([BASE]);
  });

  it('returns what the repository did when the turn is stopped after the commit, and keeps its commit as the base', async () => {
    const bases: string[] = [];
    const harness = await harnessWith(await linkedWorkspace((value) => bases.push(value.baseCommit)));
    controlPlane();
    const stop = new AbortController();
    onPush(() => stop.abort());

    const result = await publishTool(harness)(
      { message: 'Ship it', live: true },
      { toolCallId: 'call-1', abortSignal: stop.signal },
    );
    expect(stop.signal.aborted).toBe(true);
    const main = await artifacts.head(REPO);
    expect(result).toMatchObject({
      ok: true,
      data: { commit: main, live: true, build: 'pending', defaultBranch: 'main' },
    });
    expect(await artifacts.filesAt(REPO, 'main')).toEqual({ 'README.md': 'changed' });
    // The commit made from this workspace is the new base: its tree is exactly the workspace.
    expect(bases).toEqual([await artifacts.head(REPO, 'cloudchef/sara-owner0-k3y4chat0001')]);
  });

  it('keeps work that overlaps newer work on main on its branch, and nothing goes live', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    controlPlane();
    const moved = await artifacts.commitDirect(REPO, 'main', { 'README.md': 'theirs' });

    const result = await publishTool(harness)({ message: 'Ship it', live: true }, { toolCallId: 'call-1' });
    expect(result).toMatchObject({
      ok: false,
      data: { branch: 'cloudchef/sara-owner0-k3y4chat0001', conflict: true, defaultBranch: 'main' },
    });
    expect(await artifacts.head(REPO)).toBe(moved);
  });

  it('commits nothing for a member who may only view the project', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ orgProjectId: PROJECT_ID, name: 'Ada site', repo: REPO, defaultBranch: 'main', role: 'view' }),
    );
    const result = await publishTool(harness)({ message: 'Ship it', live: true }, { toolCallId: 'call-1' });
    expect(result).toMatchObject({ ok: false });
    expect(result.summary).toContain('view the project but not change it');
    expect(artifacts.pushes).toEqual([]);
  });

  it('tells the model which local secrets it left out, with a commit and without one', async () => {
    const base = await linkedWorkspace();
    const linked = await base.linkedProject?.();
    if (!linked) {
      throw new Error('The linked workspace names its project.');
    }
    const secret: BuilderWorkspaceFileMetadata = {
      path: '/home/project/.env.production',
      encoding: 'utf8',
      size: 5,
      mode: 0o644,
      sha256: await sha256Hex('KEY=2'),
      revision: 4,
    };
    const readme = base.listFiles?.()[0];
    const withSecretEdited = async (readmeChanged: boolean): Promise<Partial<BuilderWorkspaceApi>> => ({
      ...base,
      linkedProject: async () => ({
        ...linked,
        baseManifest: [
          ...linked.baseManifest.map((file) => (readmeChanged ? file : { ...file, sha256: readme?.sha256 ?? '' })),
          { path: '.env.production', sha256: await sha256Hex('KEY=1'), executable: false },
        ],
      }),
      listFiles: () => (readme ? [readme, secret] : [secret]),
    });

    const unchanged = await harnessWith(await withSecretEdited(false));
    const pushes = controlPlane();
    const nothing = await publishTool(unchanged)({ message: 'Ship it', live: false }, { toolCallId: 'call-1' });
    expect(nothing).toMatchObject({ ok: false });
    expect(nothing.summary).toContain('Nothing has changed');
    expect(nothing.summary).toContain('never publishes: .env.production.');
    expect(pushes).toEqual([]);

    const changed = await harnessWith(await withSecretEdited(true));
    const result = await publishTool(changed)({ message: 'Ship it', live: false }, { toolCallId: 'call-2' });
    expect(result).toMatchObject({ ok: true, data: { build: 'pending' } });
    expect(result.summary).toContain('never publishes: .env.production.');
    expect(Object.keys(await artifacts.filesAt(REPO, 'cloudchef/sara-owner0-k3y4chat0001'))).toEqual(['README.md']);
  });
});

const READY_STATE = {
  initialized: true,
  revision: 4,
  resetRevision: 0,
  fileCount: 1,
  totalBytes: 7,
  seeding: false,
};
