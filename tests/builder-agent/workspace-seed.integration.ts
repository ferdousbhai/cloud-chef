import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceSeedStartResult } from '@cloudchef/user-workspace-runtime/protocol';
import { builderAgentHarness, settle } from './harness';

/**
 * A new workspace is seeded outside the agent's startup, which Cloudflare cuts off after 30 seconds while a
 * seed can take minutes, and only once however many callers need it at the same time.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const READY_STATE = {
  initialized: true,
  revision: 3,
  resetRevision: 0,
  fileCount: 1,
  totalBytes: 10,
  seeding: false,
};

describe("a new workspace's seed", () => {
  it('does not run while the agent starts, and its failure is what preparing the workspace reports', async () => {
    const beginSeed = vi.fn(async (): Promise<BuilderWorkspaceSeedStartResult> => {
      throw new Error('The project download from GitHub ended early. Open the project again.');
    });
    const harness = await builderAgentHarness({
      workspace: { refresh: async () => ({ ...READY_STATE, initialized: false }), beginSeed },
    });
    expect(beginSeed).not.toHaveBeenCalled();

    await expect(harness.agent.prepareWorkspace()).rejects.toThrow('The project download from GitHub ended early.');
    expect(beginSeed).toHaveBeenCalledOnce();
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
    const harness = await builderAgentHarness({
      workspace: { refresh: async () => (seeded ? READY_STATE : { ...READY_STATE, initialized: false }), beginSeed },
    });

    const first = harness.agent.prepareWorkspace();
    const second = harness.agent.prepareWorkspace();
    await settle();
    expect(beginSeed).toHaveBeenCalledOnce();

    finishSeed();
    await expect(first).resolves.toMatchObject({ initialized: true, revision: 3 });
    await expect(second).resolves.toMatchObject({ initialized: true, revision: 3 });
    expect(beginSeed).toHaveBeenCalledOnce();
  });
});
