import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from '~/agents/builder-workspace-api';
import type { BuilderWorkspaceLinkedProject } from '@cloudchef/user-workspace-runtime/protocol';
import { sha256Hex } from '~/lib/hex-digest';
import { fakeArtifacts, type FakeArtifacts } from '~/test/fake-artifacts';
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
    setGitRepository: async () => undefined,
    takeGitPushes: async () => [],
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

async function harnessWith(workspace: Partial<BuilderWorkspaceApi>) {
  return builderAgentHarness({ workspace, cloudflareIdentity: true, artifacts });
}

describe('an earlier conversation on a team project', () => {
  it('refuses saves and approvals once a newer conversation took over', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    const proposal = await harness.proposeCloudflareRequest();
    await close(harness);

    const save = harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [] });
    await expect(save).rejects.toMatchObject({ status: 409 });
    await expect(harness.agent.approveCloudflareExecution({ executionId: proposal.executionId })).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    expect(harness.cloudflareExecution(proposal.executionId)?.status).toBe('awaiting_approval');
  });

  it('refuses saves once the member deleted it, though its agent and turn live on', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    harness.database.prepare(`UPDATE chats SET org_project_id = ?, is_deleted = 1`).run(PROJECT_ID);

    await expect(harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [] })).rejects.toMatchObject({
      status: 409,
    });
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

describe("a team project's publication", () => {
  it('leaves nothing waiting for a CloudChef deployment, which a team project never has', async () => {
    const harness = await harnessWith(await linkedWorkspace());
    // Recorded by a turn before team projects stopped asking for CloudChef's publication.
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });

    harness.beginTurn();
    await harness.endTurn();

    expect(harness.agent.state.publicationPending).toBe(false);
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

describe("a team project's git push", () => {
  /** What the agent reports for a command that ran in the workspace (`pushResult` for exec). */
  function pushResult(harness: BuilderAgentHarness, toolCallId: string): Promise<CloudChefToolResult | undefined> {
    // eslint-disable-next-line dot-notation
    return harness.agent['gitPushResult'](toolCallId);
  }

  it('reports a push to main as publishing it, and to a branch as a preview, once each', async () => {
    const pushes = [
      { ref: 'refs/heads/feature', oldOid: '0'.repeat(40), newOid: 'a'.repeat(40) },
      { ref: 'refs/heads/main', oldOid: BASE, newOid: 'b'.repeat(40) },
    ];
    const harness = await harnessWith({
      ...(await linkedWorkspace()),
      takeGitPushes: async () => pushes.splice(0),
    });
    const live = await pushResult(harness, 'call-push');
    expect(live?.data).toMatchObject({ branch: 'main', commit: 'b'.repeat(40), live: true });
    expect(live?.summary).toContain('pushed to main');
    // Taken once: a later command that pushed nothing reports nothing.
    expect(await pushResult(harness, 'call-later')).toBeUndefined();

    pushes.push({ ref: 'refs/heads/feature', oldOid: 'a'.repeat(40), newOid: 'c'.repeat(40) });
    expect((await pushResult(harness, 'call-branch'))?.data).toMatchObject({ branch: 'feature', live: false });
  });

  it("tells a CloudChef app's agent its push to main goes live when the turn ends, and reports no branch deleted", async () => {
    const app = await harnessWith({
      ...(await linkedWorkspace()),
      linkedProject: async () => null,
      takeGitPushes: async () => [{ ref: 'refs/heads/main', oldOid: BASE, newOid: 'b'.repeat(40) }],
    });
    const pushed = await pushResult(app, 'call-1');
    expect(pushed?.summary).toContain('publishes it to the live site when this turn ends');
    // Owed at once, in the agent's state, so a restart before the turn ends still publishes it.
    expect(app.agent.state.publicationPending).toBe(true);
    // A CloudChef app's publish card is its deployment, not a team project's build.
    expect(pushed?.data).toBeUndefined();
    const deleted = await harnessWith({
      ...(await linkedWorkspace()),
      takeGitPushes: async () => [{ ref: 'refs/heads/old', oldOid: BASE, newOid: '0'.repeat(40) }],
    });
    expect(await pushResult(deleted, 'call-1')).toBeUndefined();
  });
});
