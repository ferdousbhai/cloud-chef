import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderWorkspaceState } from '@cloudchef/user-workspace-runtime/protocol';
import { AGENT_NAME, conversationAgentHarness, CHAT_INITIAL_ID, type BuilderPublisher } from './harness';

/**
 * A chat is one project. A new conversation in it (a subchat) has an agent and a context of its own, and
 * works on the same workspace, Worker and repository; only the newest conversation changes the project.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A ProjectWorkspace holding its files in memory: each project id the namespace is asked for gets its own. */
function memoryWorkspace(): Partial<BuilderWorkspaceApi> {
  const files = new Map<string, string>();
  let revision = 3;
  const state = (): BuilderWorkspaceState => ({
    initialized: true,
    revision,
    resetRevision: 0,
    fileCount: files.size,
    totalBytes: [...files.values()].reduce((total, content) => total + content.length, 0),
    seeding: false,
  });
  return {
    refresh: async () => state(),
    getState: () => state(),
    applyClientChanges: async ({ changes }) => {
      for (const change of changes) {
        if (change.kind === 'write') {
          files.set(change.path, change.content);
        }
      }
      revision += 1;
      return { ok: true, state: state(), changedPaths: changes.map((change) => change.path) };
    },
  };
}

const WRITE = { kind: 'write', path: '/home/project/notes.md', content: 'from the first conversation' } as const;

describe('a new conversation in a chat', () => {
  it("works on the same project as the one before: the chat's workspace, with that one's files", async () => {
    const harness = await conversationAgentHarness({ newWorkspace: memoryWorkspace });
    await harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [WRITE] });

    const second = await harness.startConversation();

    // Keyed on the chat, by its first conversation's agent: the id that conversation's workspace always had.
    expect(second.projectId).toBe(`id-${CHAT_INITIAL_ID}`);
    expect(second.projectId).toBe(harness.projectId);
    await expect(second.agent.getWorkspaceState()).resolves.toMatchObject({ revision: 4, fileCount: 1 });
    await expect(
      second.agent.applyWorkspaceClientChanges({ baseRevision: 4, changes: [{ ...WRITE, content: 'and the next' }] }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('closes the one before: it keeps its transcript to read, and refuses to change the project', async () => {
    const harness = await conversationAgentHarness({ newWorkspace: memoryWorkspace });

    const second = await harness.startConversation();

    await expect(
      harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [WRITE] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(harness.agent.revertToCommit('a'.repeat(40))).rejects.toMatchObject({ status: 409 });
    await expect(harness.agent.getWorkspaceState()).resolves.toMatchObject({ revision: 3, fileCount: 0 });
    await harness.agent.prepareWorkspace();
    await second.agent.prepareWorkspace();
    expect(harness.agent.state.conversationClosed).toBe(true);
    expect(second.agent.state.conversationClosed).toBe(false);
  });

  it('takes over where production stands from the one before, which publishes nothing more', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({
      status: 'succeeded',
      id: 'deployment-2',
      productionUrl: 'https://app.example.workers.dev',
    }));
    const harness = await conversationAgentHarness({ newWorkspace: memoryWorkspace, publisher: { deploy } });
    const deployment = {
      status: 'succeeded',
      revision: 'b'.repeat(64),
      productionUrl: 'https://app.example.workers.dev',
    } as const;
    harness.agent.setState({
      ...harness.agent.state,
      deployment,
      productionRevision: 'b'.repeat(64),
      productionUrl: 'https://app.example.workers.dev',
      publicationPending: true,
    });

    const second = await harness.startConversation();
    const handover = await harness.agent.settleForSuccessor('owner-1');
    if (!handover) {
      throw new Error('A conversation that started hands its publication over.');
    }
    await second.agent.continuePublication('owner-1', handover);

    expect(second.agent.state).toMatchObject({
      deployment,
      productionRevision: 'b'.repeat(64),
      productionUrl: 'https://app.example.workers.dev',
    });
    // What it still owed is the newer conversation's to publish now, not its own.
    expect(harness.agent.state.publicationPending).toBe(false);
    deploy.mockClear();
    // eslint-disable-next-line dot-notation
    await harness.agent['publishLatestRevision'](null);
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe('an app a team adopted as one of its projects', () => {
  it('is kept to read once an admin approves it as a draft: nothing here changes or publishes its repository', async () => {
    const harness = await conversationAgentHarness({ newWorkspace: memoryWorkspace, cloudflareIdentity: true });
    Object.assign(harness.env, { CLOUDCHEF_SHARED_ACCOUNT: '1' });
    let adoptedBy: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/runtime-projects/adoption')
        ? Response.json({ orgProjectId: adoptedBy })
        : new Response('unavailable', { status: 503 }),
    );

    await harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [WRITE] });
    adoptedBy = 'team-project';

    // Restoring a version would commit this workspace over what the team has done since.
    const refused = harness.agent.revertToCommit('a'.repeat(40));
    await expect(refused).rejects.toMatchObject({ status: 409 });
    expect(await refused.catch((error: Response) => error.text())).toBe(
      'This app is now one of your team’s projects. Open it from Team projects to keep working on it.',
    );
    expect(harness.database.prepare('SELECT adopted_by_org_project_id FROM workspaces').get()).toEqual({
      adopted_by_org_project_id: 'team-project',
    });
    await expect(
      harness.agent.applyWorkspaceClientChanges({ baseRevision: 4, changes: [WRITE] }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(harness.agent.deployValidatedRevision()).rejects.toMatchObject({ status: 409 });
    await harness.agent.prepareWorkspace();
    expect(harness.agent.state).toMatchObject({ conversationClosed: true, conversationAdopted: true });
  });

  it('keeps the messages of a chat from before pi-durable to read, once, and leaves its old table in place', async () => {
    const harness = await conversationAgentHarness({
      legacyMessages: [
        { id: 'old-1', role: 'user', parts: [{ type: 'text', text: 'Build a todo app' }] },
        { id: 'old-2', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
      ],
    });

    expect((await harness.messages()).map((message) => message.id)).toEqual(['old-1', 'old-2']);
    // Started again on the same storage, it converts nothing twice; the table stays for a rollback.
    const restarted = await harness.restart();
    const again = await restarted.getTranscriptSnapshot({ agentName: AGENT_NAME, subchatIndex: 0 });
    expect(again.messages.map((message) => message.id)).toEqual(['old-1', 'old-2']);
    expect(
      harness.ctx.storage.sql
        .exec(`SELECT name FROM sqlite_master WHERE name = 'cf_agents_session_messages'`)
        .toArray(),
    ).toHaveLength(1);
  });
});
