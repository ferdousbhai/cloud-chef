import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceSeedStartResult } from '@cloudchef/user-workspace-runtime/protocol';
import { conversationAgentHarness, eventually, settle } from './harness';

/**
 * A new workspace is seeded outside the agent's startup, which Cloudflare cuts off after 30 seconds while a
 * seed can take minutes, and only once however many callers need it at the same time.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const TEAM_PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const READY_STATE = {
  initialized: true,
  revision: 3,
  resetRevision: 0,
  fileCount: 1,
  totalBytes: 10,
  seeding: false,
};

describe("a new workspace's seed", () => {
  it('does not run while the agent starts, and a failing workspace is thrown so the browser tries again', async () => {
    const beginSeed = vi.fn(async (): Promise<BuilderWorkspaceSeedStartResult> => {
      throw new Error('The workspace stopped answering.');
    });
    const harness = await conversationAgentHarness({
      workspace: { refresh: async () => ({ ...READY_STATE, initialized: false }), beginSeed },
    });
    expect(beginSeed).not.toHaveBeenCalled();

    // Thrown, not answered: the browser reads it as a lost connection and reconnects, which seeds again.
    await expect(harness.agent.prepareWorkspace()).rejects.toThrow('The workspace stopped answering.');
    expect(beginSeed).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'GitHub is no longer connected',
      () =>
        Response.json(
          { code: 'github_disconnected', error: 'Connect GitHub again in Settings to import this project.' },
          { status: 409 },
        ),
      'Connect GitHub again in Settings to import this project.',
    ],
    [
      "GitHub refuses CloudChef's App",
      () =>
        Response.json(
          {
            code: 'github_refused',
            error:
              "CloudChef's GitHub App can no longer reach this repository. Give it access on GitHub, then try again.",
          },
          { status: 502 },
        ),
      "CloudChef's GitHub App can no longer reach this repository. Give it access on GitHub, then try again.",
    ],
    [
      'the import itself fails',
      () =>
        Response.json({
          orgProjectId: TEAM_PROJECT_ID,
          name: 'Ada site',
          repo: null,
          defaultBranch: 'main',
          role: 'edit',
          importSource: { url: 'https://github.com/ada/site.git', branch: 'main', authorization: null },
        }),
      expect.stringContaining(
        "That repository wasn't found: it was removed, or it isn't public any more. If it's private now,",
      ),
    ],
    [
      'the control plane answers what the runtime cannot read',
      () => Response.json({ orgProjectId: TEAM_PROJECT_ID }),
      "CloudChef could not copy the project's files into your workspace.",
    ],
  ])("answers why a team project's workspace could not open when %s", async (_case, open, failure) => {
    const beginSeed = vi.fn(async (): Promise<BuilderWorkspaceSeedStartResult> => {
      throw new Error('Nothing is seeded from a project that did not open.');
    });
    const harness = await conversationAgentHarness({
      workspace: { refresh: async () => ({ ...READY_STATE, initialized: false }), beginSeed },
      cloudflareIdentity: true,
    });
    harness.database.prepare(`UPDATE workspaces SET org_project_id = ?`).run(TEAM_PROJECT_ID);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input instanceof Request ? input.url : input).includes('runtime-projects/open')
        ? open()
        : new Response('unavailable', { status: 503 }),
    );

    await expect(harness.agent.prepareWorkspace()).resolves.toEqual({ initialized: false, failure });
    expect(beginSeed).not.toHaveBeenCalled();
  });

  it('throws an outage while opening a team project, so the browser reconnects and tries again', async () => {
    const beginSeed = vi.fn(async (): Promise<BuilderWorkspaceSeedStartResult> => {
      throw new Error('Nothing is seeded from a project that did not open.');
    });
    const harness = await conversationAgentHarness({
      workspace: { refresh: async () => ({ ...READY_STATE, initialized: false }), beginSeed },
      cloudflareIdentity: true,
    });
    harness.database.prepare(`UPDATE workspaces SET org_project_id = ?`).run(TEAM_PROJECT_ID);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unavailable', { status: 503 }));

    await expect(harness.agent.prepareWorkspace()).rejects.toThrow('CloudChef could not open the project.');
    expect(beginSeed).not.toHaveBeenCalled();
  });

  it('runs once for callers that need it at the same time, and each gets the seeded workspace', async () => {
    let seeded = false;
    let finishSeed: () => void = () => undefined;
    const beginSeed = vi.fn(
      () =>
        new Promise<BuilderWorkspaceSeedStartResult>((resolve) => {
          finishSeed = () => {
            seeded = true;
            resolve({ status: 'initialized', state: READY_STATE });
          };
        }),
    );
    const harness = await conversationAgentHarness({
      workspace: { refresh: async () => (seeded ? READY_STATE : { ...READY_STATE, initialized: false }), beginSeed },
    });

    const first = harness.agent.prepareWorkspace();
    const second = harness.agent.prepareWorkspace();
    await eventually(() => beginSeed.mock.calls.length > 0);
    await settle();
    expect(beginSeed).toHaveBeenCalledOnce();

    finishSeed();
    await expect(first).resolves.toMatchObject({ initialized: true, revision: 3 });
    await expect(second).resolves.toMatchObject({ initialized: true, revision: 3 });
    expect(beginSeed).toHaveBeenCalledOnce();
  });
});
