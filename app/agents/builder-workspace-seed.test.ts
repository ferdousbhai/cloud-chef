import { describe, expect, it, vi } from 'vitest';
import type { BuilderWorkspaceApi } from './builder-workspace-api';
import type { BuilderWorkspaceState } from '@cloudchef/user-workspace-runtime/protocol';
import { seedBuilderWorkspace } from './builder-workspace-seed';

const emptyState: BuilderWorkspaceState = {
  initialized: false,
  revision: 1,
  resetRevision: 1,
  fileCount: 0,
  totalBytes: 0,
  seeding: true,
};

describe('seedBuilderWorkspace', () => {
  it('replays an interrupted durable seed instead of leaving the workspace stuck', async () => {
    const ready = { ...emptyState, initialized: true, seeding: false, revision: 3, fileCount: 1, totalBytes: 5 };
    const workspace = seedWorkspace({ status: 'seeding', state: emptyState }, ready);

    await expect(
      seedBuilderWorkspace(workspace, 'template-seed', [{ path: '/home/project/a.txt', content: 'hello' }]),
    ).resolves.toEqual(ready);

    expect(workspace.appendSeed).toHaveBeenCalledWith('template-seed', [
      { path: '/home/project/a.txt', content: 'hello' },
    ]);
    expect(workspace.commitSeed).toHaveBeenCalledWith('template-seed', { fileCount: 1, totalBytes: 5 });
    expect(workspace.abortSeed).not.toHaveBeenCalled();
  });

  it('does no seed work when another attempt already committed the workspace', async () => {
    const ready = { ...emptyState, initialized: true, seeding: false };
    const workspace = seedWorkspace({ status: 'initialized', state: ready }, ready);

    await expect(seedBuilderWorkspace(workspace, 'template-seed', [])).resolves.toEqual(ready);

    expect(workspace.appendSeed).not.toHaveBeenCalled();
    expect(workspace.commitSeed).not.toHaveBeenCalled();
  });

  it('clears a failed seed so the next initialization can start cleanly', async () => {
    const workspace = seedWorkspace({ status: 'started', seedId: 'template-seed', state: emptyState }, emptyState);
    vi.mocked(workspace.appendSeed).mockRejectedValueOnce(new Error('write interrupted'));

    await expect(
      seedBuilderWorkspace(workspace, 'template-seed', [{ path: '/home/project/a.txt', content: 'hello' }]),
    ).rejects.toThrow('write interrupted');

    expect(workspace.abortSeed).toHaveBeenCalledWith('template-seed');
  });
});

function seedWorkspace(
  beginResult: Awaited<ReturnType<BuilderWorkspaceApi['beginSeed']>>,
  committed: BuilderWorkspaceState,
): BuilderWorkspaceApi {
  return {
    beginSeed: vi.fn().mockResolvedValue(beginResult),
    appendSeed: vi.fn().mockResolvedValue(emptyState),
    commitSeed: vi.fn().mockResolvedValue(committed),
    abortSeed: vi.fn().mockResolvedValue(emptyState),
  } as unknown as BuilderWorkspaceApi;
}
