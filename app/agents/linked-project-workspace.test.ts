import { describe, expect, it } from 'vitest';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from './builder-workspace-api';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
} from './builder-workspace-types';
import { linkedWorkspaceChanges, seedLinkedWorkspace } from './linked-project-workspace';
import type { LinkedSnapshotLine } from '~/lib/.server/cloudflare/linked-project-client';
import { sha256Hex } from '~/lib/hex-digest';

const COMMIT = 'a'.repeat(40);
const state: BuilderWorkspaceState = {
  initialized: true,
  revision: 2,
  resetRevision: 0,
  fileCount: 0,
  totalBytes: 0,
  seeding: false,
};

/** A workspace that records what it was seeded with. */
function seedingWorkspace(begin: 'started' | 'initialized' = 'started') {
  const appended: BuilderWorkspaceFileInput[][] = [];
  const committed: { fileCount: number; totalBytes: number }[] = [];
  const linked: BuilderWorkspaceLinkedProject[] = [];
  const aborted: string[] = [];
  const workspace: Pick<
    BuilderWorkspaceApi,
    'beginSeed' | 'appendSeed' | 'commitSeed' | 'abortSeed' | 'setLinkedProject' | 'linkedProject'
  > = {
    beginSeed: async (seedId) =>
      begin === 'initialized' ? { status: 'initialized', state } : { status: 'started', seedId, state },
    appendSeed: async (_seedId, entries) => {
      appended.push(entries);
      return state;
    },
    commitSeed: async (_seedId, expected) => {
      committed.push(expected);
      return state;
    },
    abortSeed: async (seedId) => {
      aborted.push(seedId);
      return state;
    },
    setLinkedProject: async (value) => {
      linked.push(value);
    },
    linkedProject: async () => linked.at(-1) ?? null,
  };
  return { workspace, appended, committed, linked, aborted };
}

async function* lines(values: LinkedSnapshotLine[]): AsyncGenerator<LinkedSnapshotLine> {
  yield* values;
}

const file = (path: string, content: string): LinkedSnapshotLine => ({
  path,
  contentBase64: btoa(content),
  executable: false,
  blobSha: 'unused',
});

describe('seedLinkedWorkspace', () => {
  it('seeds the repository and records its commit and file hashes', async () => {
    const { workspace, appended, committed, linked } = seedingWorkspace();
    await seedLinkedWorkspace(
      workspace,
      'project-1',
      lines([
        { commit: COMMIT, defaultBranch: 'main', repository: 'ada/site' },
        file('README.md', 'hello'),
        // Build output a repository might commit stays out, as the workspace's own record does.
        file('dist/bundle.js', 'built'),
        file('src/app.ts', 'export {}'),
        { done: true, files: 3 },
      ]),
    );
    expect(appended.flat().map((entry) => entry.path)).toEqual(['/home/project/README.md', '/home/project/src/app.ts']);
    expect(committed).toEqual([{ fileCount: 2, totalBytes: 14 }]);
    expect(linked).toEqual([
      {
        orgProjectId: 'project-1',
        repository: 'ada/site',
        defaultBranch: 'main',
        baseCommit: COMMIT,
        baseManifest: [
          { path: 'README.md', sha256: await sha256Hex('hello'), executable: false },
          { path: 'src/app.ts', sha256: await sha256Hex('export {}'), executable: false },
        ],
      },
    ]);
  });

  it('abandons a download that failed or ended early, so the next open starts over', async () => {
    const failed = seedingWorkspace();
    await expect(
      seedLinkedWorkspace(failed.workspace, 'project-1', lines([{ error: 'This repository is too large.' }])),
    ).rejects.toThrow('too large');
    expect(failed.aborted).toEqual(['linked_project-1']);

    const truncated = seedingWorkspace();
    await expect(
      seedLinkedWorkspace(
        truncated.workspace,
        'project-1',
        lines([{ commit: COMMIT, defaultBranch: 'main', repository: 'ada/site' }, file('a.txt', 'a')]),
      ),
    ).rejects.toThrow('ended early');
    expect(truncated.linked).toEqual([]);
  });

  it('leaves an already seeded workspace alone, and refuses one that lost its link', async () => {
    const seeded = seedingWorkspace('initialized');
    await expect(seedLinkedWorkspace(seeded.workspace, 'project-1', lines([]))).rejects.toThrow('lost track');
    seeded.linked.push({
      orgProjectId: 'project-1',
      repository: 'ada/site',
      defaultBranch: 'main',
      baseCommit: COMMIT,
      baseManifest: [],
    });
    await seedLinkedWorkspace(seeded.workspace, 'project-1', lines([]));
    expect(seeded.appended).toEqual([]);
  });
});

describe('linkedWorkspaceChanges', () => {
  it('sends changed, new and deleted files, and nothing GitHub already has', async () => {
    const contents = new Map([
      ['/home/project/README.md', 'hello'],
      ['/home/project/src/app.ts', 'export const changed = 1;'],
      ['/home/project/src/new.ts', 'new'],
      ['/home/project/node_modules/x/index.js', 'ignored'],
    ]);
    const files: BuilderWorkspaceFileMetadata[] = [];
    for (const [path, content] of contents) {
      files.push({
        path,
        encoding: 'utf8',
        size: content.length,
        mode: path.endsWith('new.ts') ? 0o755 : 0o644,
        sha256: await sha256Hex(content),
        revision: 1,
      });
    }
    const workspace: Pick<BuilderWorkspaceApi, 'refresh' | 'listFiles' | 'readFile'> = {
      refresh: async () => state,
      listFiles: () => files,
      readFile: async (path) => {
        const bytes = new TextEncoder().encode(contents.get(path) ?? '');
        return { path, bytes, encoding: 'utf8', size: bytes.length, mode: 0o644, sha256: '', revision: 1 };
      },
    };
    const { changes, manifest } = await linkedWorkspaceChanges(workspace, {
      orgProjectId: 'project-1',
      repository: 'ada/site',
      defaultBranch: 'main',
      baseCommit: COMMIT,
      baseManifest: [
        { path: 'README.md', sha256: await sha256Hex('hello'), executable: true },
        { path: 'src/app.ts', sha256: await sha256Hex('export {}') },
        { path: 'old.txt', sha256: await sha256Hex('gone') },
      ],
    });
    // GitHub's executable bit carries over, since the workspace keeps no modes of its own.
    expect(manifest.find((file) => file.path === 'README.md')).toMatchObject({ executable: true });
    expect(manifest.map((file) => file.path)).toEqual(['README.md', 'src/app.ts', 'src/new.ts']);
    expect(changes).toEqual([
      { path: 'src/app.ts', contentBase64: btoa('export const changed = 1;'), executable: false },
      { path: 'src/new.ts', contentBase64: btoa('new'), executable: true },
      { path: 'old.txt', contentBase64: null, executable: false },
    ]);
  });
});
