import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from '~/agents/builder-workspace-api';
import type { BuilderWorkspaceLinkedProject } from '~/agents/builder-workspace-types';
import { sha256Hex } from '~/lib/hex-digest';
import { builderAgentHarness, type BuilderAgentHarness } from './harness';

/**
 * A GitHub project's conversation that a newer one took over is kept to read: nothing changes its
 * workspace or reaches GitHub from it, and it stops when the newer one starts, before that one copies it.
 */

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'a'.repeat(40);
const COMMIT = 'c'.repeat(40);
const MERGED = 'd'.repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function linkedWorkspace(
  setLinkedProject: (value: BuilderWorkspaceLinkedProject) => void = () => undefined,
): Promise<Partial<BuilderWorkspaceApi>> {
  const linked: BuilderWorkspaceLinkedProject = {
    orgProjectId: PROJECT_ID,
    repository: 'ada/site',
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
      throw new Error('An archived conversation must not reach the workspace.');
    },
  };
}

function archive(harness: BuilderAgentHarness) {
  harness.database.prepare(`UPDATE chats SET org_project_id = ?, archived_at = 1`).run(PROJECT_ID);
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

/** The control plane's commit endpoint: records each request, and answers like GitHub merged it. */
function controlPlane(onCommit: () => void = () => undefined) {
  const commits: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('runtime-github/commit')) {
      commits.push(String(init?.body));
      onCommit();
      return Response.json({ commit: COMMIT, branch: 'cloudchef/sara-abc123-k3y4chat0001', published: MERGED });
    }
    return new Response('unavailable', { status: 503 });
  });
  return commits;
}

describe('an earlier conversation on a GitHub project', () => {
  it('refuses saves, approvals and publishing once a newer conversation took over', async () => {
    const harness = await builderAgentHarness({ workspace: await linkedWorkspace(), cloudflareIdentity: true });
    const proposal = await harness.proposeCloudflareRequest();
    const commits = controlPlane();
    archive(harness);

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
    expect(published.summary).toContain('continues in a newer one');
    expect(commits).toEqual([]);
  });

  it('stops its running turn when the newer conversation asks, and says it is archived', async () => {
    // Workers' scheduler, which a cancellation waits on, is not Node's.
    vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) });
    const harness = await builderAgentHarness({ workspace: await linkedWorkspace(), cloudflareIdentity: true });
    harness.agent.setState({
      ...harness.agent.state,
      activeTurn: { id: 'turn-1', requestId: 'request-1', status: 'accepted' },
      linkedProject: { repository: 'ada/site', defaultBranch: 'main' },
    });
    // Still the current conversation: nothing stops it.
    await expect(harness.agent.settleForSuccessor('owner-1')).rejects.toMatchObject({ status: 409 });
    expect(harness.agent.state.activeTurn).not.toBeNull();

    archive(harness);
    await expect(harness.agent.settleForSuccessor('someone-else')).rejects.toMatchObject({ status: 404 });
    await harness.agent.settleForSuccessor('owner-1');
    expect(harness.agent.state.activeTurn).toBeNull();
    expect(harness.agent.state.lastCompletedTurn).toMatchObject({ id: 'turn-1', status: 'aborted' });
    expect(harness.agent.state.linkedProject).toMatchObject({ archived: true });
  });
});

describe("a GitHub project's publish", () => {
  it('holds back the newer conversation until a publish already on its way to GitHub lands', async () => {
    vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) });
    const bases: string[] = [];
    const harness = await builderAgentHarness({
      workspace: await linkedWorkspace((value) => bases.push(value.baseCommit)),
      cloudflareIdentity: true,
    });
    let committing = false;
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('runtime-github/commit')) {
        committing = true;
        await answered;
        return Response.json({ commit: COMMIT, branch: 'cloudchef/sara-abc123-k3y4chat0001', published: MERGED });
      }
      return new Response('unavailable', { status: 503 });
    });
    // The publish tool as the model's turn holds it.
    // eslint-disable-next-line dot-notation
    const tools = await harness.agent['createLinkedProjectToolContext']();
    const publishing = tools?.publish({ message: 'Ship it', live: true }, { toolCallId: 'call-1' });
    await vi.waitFor(() => expect(committing).toBe(true));

    archive(harness);
    let settled = false;
    const settling = harness.agent.settleForSuccessor('owner-1').then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    answer();
    await settling;
    await publishing;
    // The base the newer conversation copies is the commit that went live.
    expect(bases).toEqual([COMMIT]);
  });

  it('leaves nothing waiting for a CloudChef deployment, which a GitHub project never has', async () => {
    const harness = await builderAgentHarness({ workspace: await linkedWorkspace(), cloudflareIdentity: true });
    // Recorded by a turn before GitHub projects stopped asking for CloudChef's publication.
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });

    harness.beginTurn();
    await harness.endTurn();

    expect(harness.agent.state.publicationPending).toBe(false);
  });

  it("commits to the conversation's own branch, and is called off only before anything reaches GitHub", async () => {
    const harness = await builderAgentHarness({ workspace: await linkedWorkspace(), cloudflareIdentity: true });
    const commits = controlPlane();
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      publishTool(harness)({ message: 'Ship it', live: false }, { toolCallId: 'call-1', abortSignal: stopped.signal }),
    ).rejects.toThrow();
    expect(commits).toEqual([]);

    await publishTool(harness)({ message: 'Ship it', live: false }, { toolCallId: 'call-2' });
    expect(JSON.parse(commits[0] ?? '{}')).toMatchObject({ branchKey: 'k3y4chat0001', baseCommit: BASE });
  });

  it('returns what GitHub did when the turn is stopped after the commit, and keeps its commit as the base', async () => {
    const bases: string[] = [];
    const harness = await builderAgentHarness({
      workspace: await linkedWorkspace((value) => bases.push(value.baseCommit)),
      cloudflareIdentity: true,
    });
    const stop = new AbortController();
    controlPlane(() => stop.abort());

    const result = await publishTool(harness)(
      { message: 'Ship it', live: true },
      { toolCallId: 'call-1', abortSignal: stop.signal },
    );
    expect(stop.signal.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      data: { commit: MERGED, live: true, build: 'pending', defaultBranch: 'main' },
    });
    // The commit made from this workspace is the new base: its tree is exactly the workspace.
    expect(bases).toEqual([COMMIT]);
  });
});
