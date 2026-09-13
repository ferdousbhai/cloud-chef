import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { BuilderWorkspaceClientChange, BuilderWorkspaceSyncEntry } from '~/agents/builder-workspace-types';

const workbench = vi.hoisted(() => ({
  activateWorkspace: vi.fn(),
  isWorkspaceActive: vi.fn((_workspaceId: string) => true),
  setWorkspaceChangeListener: vi.fn(),
  clearWorkspaceChangeListener: vi.fn(),
  applyWorkspaceSyncEntries: vi.fn(async (_entries: BuilderWorkspaceSyncEntry[]) => undefined),
  replaceWorkspaceSnapshot: vi.fn(
    async (_entries: BuilderWorkspaceSyncEntry[], _preservedPaths?: Set<string>) => undefined,
  ),
}));

vi.mock('./workbench.client', () => ({ workbenchStore: workbench }));

import { BuilderWorkspaceSyncController } from './builder-workspace-sync.client';

describe('BuilderWorkspaceSyncController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('does not populate a workspace after its initialization owner is disposed', async () => {
    let releaseState: () => void = () => undefined;
    const stateBlocked = new Promise<void>((resolve) => {
      releaseState = resolve;
    });
    let current = true;
    const agent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          await stateBlocked;
          return workspaceState(1);
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    const initializing = BuilderWorkspaceSyncController.initialize(agent, {
      workspaceId: 'disposed-workspace',
      isCurrent: () => current,
    });
    await vi.waitFor(() => expect(agent.call).toHaveBeenCalledWith('getWorkspaceState', [], expect.anything()));
    current = false;
    releaseState();

    await expect(initializing).rejects.toThrow('durable workspace connection was superseded');
    expect(workbench.setWorkspaceChangeListener).not.toHaveBeenCalled();
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  test('does not leave a workbench listener when ownership is lost during preload', async () => {
    let releasePull: () => void = () => undefined;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let current = true;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(0, 0, 0);
        }
        if (method === 'getWorkspaceSyncPage') {
          await pullBlocked;
          const request = args[0] as { fromRevision: number };
          return syncPage(request.fromRevision, 0, 'current', [], workspaceState(0, 0, 0));
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    const initializing = BuilderWorkspaceSyncController.initialize(agent, {
      workspaceId: 'preloading-workspace',
      isCurrent: () => current,
    });
    await vi.waitFor(() =>
      expect(agent.call).toHaveBeenCalledWith('getWorkspaceSyncPage', expect.anything(), expect.anything()),
    );
    current = false;

    expect(workbench.setWorkspaceChangeListener).not.toHaveBeenCalled();
    releasePull();
    await expect(initializing).rejects.toThrow('durable workspace connection was superseded');
    expect(workbench.setWorkspaceChangeListener).not.toHaveBeenCalled();
  });

  test('never promotes browser files when the durable workspace is unavailable', async () => {
    const agent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          return { ...workspaceState(0), initialized: false };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    await expect(BuilderWorkspaceSyncController.initialize(agent)).rejects.toThrow(
      'durable project workspace is not initialized',
    );
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  test('rejects late workspace initialization after an account-scoped workspace supersedes it', async () => {
    let activeWorkspace = '';
    workbench.activateWorkspace.mockImplementation((workspaceId: string) => {
      activeWorkspace = workspaceId;
    });
    workbench.isWorkspaceActive.mockImplementation((workspaceId: string) => activeWorkspace === workspaceId);
    let releaseFirstAccount: () => void = () => undefined;
    const firstAccountBlocked = new Promise<void>((resolve) => {
      releaseFirstAccount = resolve;
    });
    const firstAgent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          await firstAccountBlocked;
          return workspaceState(1);
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };
    const secondAgent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(1);
        }
        if (method === 'getWorkspaceSyncPage') {
          const request = args[0] as { fromRevision: number };
          return syncPage(request.fromRevision, 1, 'snapshot', []);
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    const firstInitialization = BuilderWorkspaceSyncController.initialize(firstAgent, {
      workspaceId: 'account-a:shared-agent',
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(firstAgent.call).toHaveBeenCalledWith('getWorkspaceState', [], expect.anything()));
    const secondController = await BuilderWorkspaceSyncController.initialize(secondAgent, {
      workspaceId: 'account-b:shared-agent',
    });
    releaseFirstAccount();

    await expect(firstInitialization).resolves.toEqual(
      expect.objectContaining({ message: 'The durable workspace connection was superseded.' }),
    );
    expect(activeWorkspace).toBe('account-b:shared-agent');
    expect(firstAgent.call).toHaveBeenCalledTimes(1);
    secondController.dispose();
  });

  test('rejects a stale manual edit and replaces the presentation cache from the durable snapshot', async () => {
    const applyRequests: unknown[] = [];
    let conflicted = false;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            if (request.fromRevision === 0) {
              return conflicted
                ? syncPage(0, 2, 'snapshot', [
                    write('/home/project/src/local.ts', 'server-version', 2),
                    write('/home/project/src/remote.ts', 'remote-change', 2),
                  ])
                : syncPage(0, 1, 'snapshot', [write('/home/project/src/local.ts', 'initial', 1)]);
            }
            return syncPage(1, 2, 'delta', [
              write('/home/project/src/local.ts', 'server-version', 2),
              write('/home/project/src/remote.ts', 'remote-change', 2),
            ]);
          }
          case 'applyWorkspaceClientChanges':
            applyRequests.push(args[0]);
            conflicted = true;
            return { ok: false, conflict: true, state: workspaceState(2) };
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    workbench.applyWorkspaceSyncEntries.mockClear();
    const localChange: BuilderWorkspaceClientChange = {
      kind: 'write',
      path: '/home/project/src/local.ts',
      content: 'browser-version',
    };

    await controller.push([localChange]);

    expect(applyRequests).toEqual([{ baseRevision: 1, changes: [localChange] }]);
    expect(workbench.replaceWorkspaceSnapshot).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({ path: '/home/project/src/local.ts', content: 'server-version' }),
        expect.objectContaining({ path: '/home/project/src/remote.ts', content: 'remote-change' }),
      ],
      undefined,
    );
    expect(controller.revision).toBe(2);
  });

  test('presents unrelated delta entries without advancing a stale own-save baseline', async () => {
    let revision = 1;
    let durableContent = 'initial';
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(revision);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            return request.fromRevision === 0
              ? syncPage(0, revision, 'snapshot', [write('/home/project/src/local.ts', durableContent, revision)])
              : syncPage(request.fromRevision, revision, 'delta', [
                  write('/home/project/src/local.ts', durableContent, revision),
                  write('/home/project/src/remote.ts', 'remote change', revision),
                ]);
          }
          case 'applyWorkspaceClientChanges':
            revision = 2;
            durableContent = 'older edit';
            return {
              ok: true,
              state: workspaceState(revision),
              changedPaths: ['/home/project/src/local.ts'],
            };
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    const listener = workbench.setWorkspaceChangeListener.mock.calls[0]?.[0] as (
      changes: BuilderWorkspaceClientChange[],
      isCurrentChange: () => boolean,
    ) => Promise<unknown>;
    workbench.applyWorkspaceSyncEntries.mockClear();
    workbench.replaceWorkspaceSnapshot.mockClear();

    await listener([{ kind: 'write', path: '/home/project/src/local.ts', content: 'older edit' }], () => false);

    expect(agent.call).toHaveBeenCalledWith(
      'getWorkspaceSyncPage',
      [{ fromRevision: 1 }],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(controller.revision).toBe(2);
    expect(workbench.applyWorkspaceSyncEntries).toHaveBeenCalledOnce();
    expect(workbench.applyWorkspaceSyncEntries).toHaveBeenCalledWith([
      expect.objectContaining({ path: '/home/project/src/remote.ts', content: 'remote change' }),
    ]);
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  test('selectively reconciles a snapshot after a successful stale own-save', async () => {
    let revision = 1;
    let saved = false;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(revision);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            return saved
              ? syncPage(request.fromRevision, revision, 'snapshot', [
                  write('/home/project/src/local.ts', 'older edit', revision),
                  write('/home/project/src/remote.ts', 'remote change', revision),
                ])
              : syncPage(request.fromRevision, revision, 'snapshot', [
                  write('/home/project/src/local.ts', 'initial', revision),
                ]);
          }
          case 'applyWorkspaceClientChanges':
            revision = 2;
            saved = true;
            return {
              ok: true,
              state: workspaceState(revision),
              changedPaths: ['/home/project/src/local.ts'],
            };
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    const listener = workbench.setWorkspaceChangeListener.mock.calls[0]?.[0] as (
      changes: BuilderWorkspaceClientChange[],
      isCurrentChange: () => boolean,
    ) => Promise<unknown>;
    workbench.replaceWorkspaceSnapshot.mockClear();

    await listener([{ kind: 'write', path: '/home/project/src/local.ts', content: 'older edit' }], () => false);

    expect(workbench.replaceWorkspaceSnapshot).toHaveBeenCalledOnce();
    expect(workbench.replaceWorkspaceSnapshot).toHaveBeenCalledWith(
      [
        expect.objectContaining({ path: '/home/project/src/local.ts', content: 'older edit' }),
        expect.objectContaining({ path: '/home/project/src/remote.ts', content: 'remote change' }),
      ],
      new Set(['/home/project/src/local.ts']),
    );
    expect(controller.revision).toBe(2);
  });

  test('does not present a pull that completes after the controller is disposed and the same workspace remounts', async () => {
    let revision = 1;
    let releasePull: () => void = () => undefined;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(revision);
        }
        if (method === 'getWorkspaceSyncPage') {
          const request = args[0] as { fromRevision: number };
          if (request.fromRevision === 0) {
            return syncPage(0, 1, 'snapshot', [write('/home/project/src/local.ts', 'initial', 1)]);
          }
          await pullBlocked;
          return syncPage(request.fromRevision, revision, 'delta', [
            write('/home/project/src/remote.ts', 'old mount', revision),
          ]);
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent, { workspaceId: 'same-workspace' });
    workbench.applyWorkspaceSyncEntries.mockClear();
    revision = 2;
    const pull = controller.pull();
    await vi.waitFor(() =>
      expect(agent.call).toHaveBeenCalledWith(
        'getWorkspaceSyncPage',
        [{ fromRevision: 1 }],
        expect.objectContaining({ timeout: 30_000 }),
      ),
    );

    controller.dispose();
    workbench.activateWorkspace('same-workspace');
    releasePull();

    await expect(pull).rejects.toThrow('durable workspace connection was closed');
    expect(workbench.applyWorkspaceSyncEntries).not.toHaveBeenCalled();
  });

  test('does not present an in-flight conflict after the controller is disposed and the same workspace remounts', async () => {
    let releaseConflict: () => void = () => undefined;
    const conflictBlocked = new Promise<void>((resolve) => {
      releaseConflict = resolve;
    });
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(1);
        }
        if (method === 'getWorkspaceSyncPage') {
          const request = args[0] as { fromRevision: number };
          return syncPage(request.fromRevision, 1, 'snapshot', [write('/home/project/src/local.ts', 'initial', 1)]);
        }
        if (method === 'applyWorkspaceClientChanges') {
          await conflictBlocked;
          return { ok: false, conflict: true, state: workspaceState(2) };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent, { workspaceId: 'same-workspace' });
    workbench.replaceWorkspaceSnapshot.mockClear();
    const push = controller.push([{ kind: 'write', path: '/home/project/src/local.ts', content: 'stale local edit' }]);
    await vi.waitFor(() =>
      expect(agent.call).toHaveBeenCalledWith(
        'applyWorkspaceClientChanges',
        [expect.anything()],
        expect.objectContaining({ timeout: 30_000 }),
      ),
    );

    controller.dispose();
    workbench.activateWorkspace('same-workspace');
    releaseConflict();

    await expect(push).rejects.toThrow('durable workspace connection was closed');
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenCalled();
  });

  test('atomically replaces stale rows when the server restarts a paged delta as a snapshot', async () => {
    let restarting = false;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number; cursor?: string; targetRevision?: number };
            if (!restarting && request.fromRevision === 0) {
              return syncPage(0, 1, 'snapshot', [write('/home/project/src/stale.ts', 'stale', 1)]);
            }
            if (request.fromRevision === 1) {
              restarting = true;
              return { ...syncPage(1, 2, 'snapshot', []), restart: true };
            }
            if (!request.cursor) {
              return {
                ...syncPage(0, 2, 'snapshot', [write('/home/project/src/one.ts', 'one', 2)], workspaceState(2, 2, 6)),
                nextCursor: syncCursor(2, 1),
              };
            }
            expect(request).toEqual({ fromRevision: 0, targetRevision: 2, cursor: syncCursor(2, 1) });
            return syncPage(0, 2, 'snapshot', [write('/home/project/src/two.ts', 'two', 2)], workspaceState(2, 2, 6));
          }
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);

    await controller.pull();

    expect(workbench.replaceWorkspaceSnapshot).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({ path: '/home/project/src/one.ts', content: 'one' }),
        expect.objectContaining({ path: '/home/project/src/two.ts', content: 'two' }),
      ],
      undefined,
    );
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenLastCalledWith([
      expect.objectContaining({ path: '/home/project/src/stale.ts' }),
    ]);
    expect(controller.revision).toBe(2);
  });

  test('does not silently retry a failed manual edit during a later pull', async () => {
    let applyCount = 0;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            return request.fromRevision === 0
              ? syncPage(0, 1, 'snapshot', [])
              : syncPage(request.fromRevision, 2, 'snapshot', []);
          }
          case 'applyWorkspaceClientChanges':
            applyCount += 1;
            if (applyCount === 1) {
              throw new Error('temporary connection failure');
            }
            return {
              ok: true,
              state: workspaceState(2),
              changedPaths: [(args[0] as { changes: BuilderWorkspaceClientChange[] }).changes[0]!.path],
            };
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    const change: BuilderWorkspaceClientChange = {
      kind: 'write',
      path: '/home/project/src/retry.ts',
      content: 'retry me',
    };

    await expect(controller.push([change])).rejects.toThrow('temporary connection failure');
    await expect(controller.pull()).resolves.toBeUndefined();

    expect(applyCount).toBe(1);
    expect(controller.revision).toBe(2);
  });

  test('serializes push and pull operations through one workspace queue', async () => {
    let revision = 1;
    let activeApplyCalls = 0;
    let maximumActiveApplyCalls = 0;
    let releaseFirstApply: () => void = () => undefined;
    let firstApply = true;
    const agent = {
      call: vi.fn(async (method: string, args: unknown[]) => {
        switch (method) {
          case 'getWorkspaceState':
            return workspaceState(1);
          case 'getWorkspaceSyncPage': {
            const request = args[0] as { fromRevision: number };
            return request.fromRevision === 0
              ? syncPage(0, 1, 'snapshot', [])
              : request.fromRevision === revision
                ? syncPage(request.fromRevision, revision, 'current', [])
                : syncPage(request.fromRevision, revision, 'snapshot', []);
          }
          case 'applyWorkspaceClientChanges': {
            activeApplyCalls += 1;
            maximumActiveApplyCalls = Math.max(maximumActiveApplyCalls, activeApplyCalls);
            if (firstApply) {
              firstApply = false;
              await new Promise<void>((resolve) => {
                releaseFirstApply = resolve;
              });
            }
            revision += 1;
            activeApplyCalls -= 1;
            return {
              ok: true,
              state: workspaceState(revision),
              changedPaths: (args[0] as { changes: BuilderWorkspaceClientChange[] }).changes.map(
                (change) => change.path,
              ),
            };
          }
          default:
            throw new Error(`Unexpected RPC: ${method}`);
        }
      }),
    };
    const controller = await BuilderWorkspaceSyncController.initialize(agent);
    const firstPush = controller.push([{ kind: 'write', path: '/home/project/src/one.ts', content: 'one' }]);
    await vi.waitFor(() => expect(activeApplyCalls).toBe(1));
    const pull = controller.pull();
    const secondPush = controller.push([{ kind: 'write', path: '/home/project/src/two.ts', content: 'two' }]);

    releaseFirstApply();
    await Promise.all([firstPush, pull, secondPush]);

    expect(maximumActiveApplyCalls).toBe(1);
    expect(agent.call.mock.calls.filter(([method]) => method === 'applyWorkspaceClientChanges')).toHaveLength(2);
  });

  test('rejects a sync cursor that does not advance to the next entry', async () => {
    const agent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(1);
        }
        if (method === 'getWorkspaceSyncPage') {
          return {
            ...syncPage(0, 1, 'snapshot', [write('/home/project/src/one.ts', 'one', 1)]),
            nextCursor: syncCursor(1, 0),
          };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    await expect(BuilderWorkspaceSyncController.initialize(agent)).rejects.toThrow(
      'sync cursor did not advance to the next entry',
    );
    expect(workbench.applyWorkspaceSyncEntries).not.toHaveBeenCalled();
  });

  test.each([
    ['path', { ...write('/home/project/src/file.ts', 'one', 1), path: '/tmp/file.ts' }],
    ['encoding', { ...write('/home/project/src/file.ts', 'one', 1), encoding: 'hex' }],
    ['hash', { ...write('/home/project/src/file.ts', 'one', 1), sha256: '1' }],
  ])('rejects a sync entry with an invalid %s before committing it', async (_field, invalidEntry) => {
    const agent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(1);
        }
        if (method === 'getWorkspaceSyncPage') {
          return {
            ...syncPage(0, 1, 'snapshot', [write('/home/project/src/file.ts', 'one', 1)]),
            entries: [invalidEntry],
          };
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    await expect(BuilderWorkspaceSyncController.initialize(agent)).rejects.toThrow(
      'Invalid durable workspace sync response',
    );
    expect(workbench.applyWorkspaceSyncEntries).not.toHaveBeenCalled();
  });

  test('rejects sync content that does not match its declared hash', async () => {
    const entry = { ...write('/home/project/src/file.ts', 'one', 1), content: 'two' };
    const agent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(1);
        }
        if (method === 'getWorkspaceSyncPage') {
          return syncPage(0, 1, 'snapshot', [entry]);
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    await expect(BuilderWorkspaceSyncController.initialize(agent)).rejects.toThrow(
      'content hash does not match for /home/project/src/file.ts',
    );
    expect(workbench.replaceWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(workbench.applyWorkspaceSyncEntries).not.toHaveBeenCalled();
  });

  test('rejects a target revision change between pages before committing entries', async () => {
    let page = 0;
    const agent = {
      call: vi.fn(async (method: string) => {
        if (method === 'getWorkspaceState') {
          return workspaceState(2);
        }
        if (method === 'getWorkspaceSyncPage') {
          page += 1;
          return page === 1
            ? {
                ...syncPage(0, 2, 'snapshot', [write('/home/project/src/one.ts', 'one', 2)], workspaceState(2, 2, 6)),
                nextCursor: syncCursor(2, 1),
              }
            : syncPage(0, 3, 'snapshot', [write('/home/project/src/two.ts', 'two', 3)], workspaceState(3, 2, 6));
        }
        throw new Error(`Unexpected RPC: ${method}`);
      }),
    };

    await expect(BuilderWorkspaceSyncController.initialize(agent)).rejects.toThrow(
      'target revision changed between pages',
    );
    expect(workbench.applyWorkspaceSyncEntries).not.toHaveBeenCalled();
  });
});

function workspaceState(revision: number, fileCount = 1, totalBytes = 1) {
  return {
    initialized: true,
    revision,
    resetRevision: 1,
    fileCount,
    totalBytes,
    seeding: false,
  };
}

function syncPage(
  fromRevision: number,
  targetRevision: number,
  mode: 'current' | 'snapshot' | 'delta',
  entries: BuilderWorkspaceSyncEntry[],
  state = mode === 'snapshot'
    ? workspaceState(
        targetRevision,
        entries.filter((entry) => entry.kind === 'write').length,
        entries.reduce((total, entry) => total + (entry.kind === 'write' ? entry.size : 0), 0),
      )
    : workspaceState(targetRevision),
) {
  return {
    state,
    fromRevision,
    targetRevision,
    mode,
    entries,
  };
}

function write(path: string, content: string, revision: number): BuilderWorkspaceSyncEntry {
  return {
    kind: 'write',
    path,
    content,
    encoding: 'utf8',
    size: content.length,
    sha256: sha256(content),
    revision,
  };
}

function syncCursor(revision: number, index: number): string {
  return btoa(JSON.stringify({ revision, index }));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
