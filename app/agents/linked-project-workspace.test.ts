import { describe, expect, it } from 'vitest';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from './builder-workspace-api';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncEntry,
} from './builder-workspace-types';
import { linkedWorkspaceChanges, packDraftSnapshot, seedLinkedWorkspace } from './linked-project-workspace';
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
        // Its own branch, and modes the workspace now holds as GitHub's.
        branchKey: expect.stringMatching(/^[a-z0-9]{12}$/),
        workspaceModes: true,
      },
    ]);
    expect(appended.flat().map((entry) => entry.mode)).toEqual([0o644, 0o644]);
  });

  it("writes each file with GitHub's mode, so an executable stays one in the workspace", async () => {
    const { workspace, appended } = seedingWorkspace();
    await seedLinkedWorkspace(
      workspace,
      'project-1',
      lines([
        { commit: COMMIT, defaultBranch: 'main', repository: 'ada/site' },
        { ...file('scripts/build.sh', '#!/bin/sh'), executable: true },
        { done: true, files: 1 },
      ]),
    );
    expect(appended.flat()).toEqual([expect.objectContaining({ path: '/home/project/scripts/build.sh', mode: 0o755 })]);
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

  it("sends a change of executable bit alone, either way, once the workspace holds GitHub's modes", async () => {
    const files: BuilderWorkspaceFileMetadata[] = [
      {
        path: '/home/project/run.sh',
        encoding: 'utf8',
        size: 2,
        mode: 0o644,
        sha256: await sha256Hex('#!'),
        revision: 1,
      },
      {
        path: '/home/project/tool.sh',
        encoding: 'utf8',
        size: 2,
        mode: 0o755,
        sha256: await sha256Hex('#?'),
        revision: 1,
      },
      {
        path: '/home/project/same.sh',
        encoding: 'utf8',
        size: 2,
        mode: 0o755,
        sha256: await sha256Hex('ok'),
        revision: 1,
      },
    ];
    const contents = new Map([
      ['/home/project/run.sh', '#!'],
      ['/home/project/tool.sh', '#?'],
      ['/home/project/same.sh', 'ok'],
    ]);
    const workspace: Pick<BuilderWorkspaceApi, 'refresh' | 'listFiles' | 'readFile'> = {
      refresh: async () => state,
      listFiles: () => files,
      readFile: async (path) => {
        const bytes = new TextEncoder().encode(contents.get(path) ?? '');
        return { path, bytes, encoding: 'utf8', size: bytes.length, mode: 0o644, sha256: '', revision: 1 };
      },
    };
    const linked: BuilderWorkspaceLinkedProject = {
      orgProjectId: 'project-1',
      repository: 'ada/site',
      defaultBranch: 'main',
      baseCommit: COMMIT,
      baseManifest: [
        { path: 'run.sh', sha256: await sha256Hex('#!'), executable: true },
        { path: 'tool.sh', sha256: await sha256Hex('#?'), executable: false },
        { path: 'same.sh', sha256: await sha256Hex('ok'), executable: true },
      ],
      workspaceModes: true,
    };
    const { changes } = await linkedWorkspaceChanges(workspace, linked);
    expect(changes).toEqual([
      { path: 'run.sh', contentBase64: btoa('#!'), executable: false },
      { path: 'tool.sh', contentBase64: btoa('#?'), executable: true },
    ]);
    // A workspace seeded before it kept modes can't tell a removed bit from one it never had.
    const legacy = await linkedWorkspaceChanges(workspace, { ...linked, workspaceModes: undefined });
    expect(legacy.changes).toEqual([{ path: 'tool.sh', contentBase64: btoa('#?'), executable: true }]);
  });
});

/** A workspace holding `contents` (project-relative path to text), for publishing. */
async function publishingWorkspace(contents: Record<string, string>) {
  const files: BuilderWorkspaceFileMetadata[] = [];
  for (const [path, content] of Object.entries(contents)) {
    files.push({
      path: `/home/project/${path}`,
      encoding: 'utf8',
      size: content.length,
      mode: 0o644,
      sha256: await sha256Hex(content),
      revision: 1,
    });
  }
  const workspace: Pick<BuilderWorkspaceApi, 'refresh' | 'listFiles' | 'readFile'> = {
    refresh: async () => state,
    listFiles: () => files,
    readFile: async (path) => {
      const bytes = new TextEncoder().encode(contents[path.slice('/home/project/'.length)] ?? '');
      return { path, bytes, encoding: 'utf8', size: bytes.length, mode: 0o644, sha256: '', revision: 1 };
    },
  };
  return workspace;
}

describe('what a publish leaves out', () => {
  it("leaves out new files the project's .gitignore files ignore, and local secrets either way", async () => {
    const workspace = await publishingWorkspace({
      '.gitignore': 'coverage/\nbuild/\n',
      'packages/api/.gitignore': 'generated/\n',
      'src/app.ts': 'export const changed = 1;',
      'coverage/index.html': 'report',
      'build/out.js': 'bundle',
      'packages/api/generated/client.ts': 'generated',
      'packages/api/src/index.ts': 'api',
      'build/tracked.js': 'tracked, changed',
      '.env': 'SECRET=1',
      '.dev.vars': 'TOKEN=1',
      'apps/web/.env.local': 'SECRET=2',
      '.env.example': 'SECRET=',
      'config/.env.production': 'PUBLIC_URL=https://changed.example',
    });
    const linked: BuilderWorkspaceLinkedProject = {
      orgProjectId: 'project-1',
      repository: 'ada/site',
      defaultBranch: 'main',
      baseCommit: COMMIT,
      baseManifest: [
        { path: '.gitignore', sha256: await sha256Hex('coverage/\nbuild/\n') },
        { path: 'src/app.ts', sha256: await sha256Hex('export {}') },
        // Already in the repository: ignored now, but git still tracks it, so its change goes.
        { path: 'build/tracked.js', sha256: await sha256Hex('tracked') },
        // A secret the repository committed stays as it is there, edited or removed.
        { path: 'config/.env.production', sha256: await sha256Hex('PUBLIC_URL=https://example') },
        { path: '.dev.vars.staging', sha256: await sha256Hex('TOKEN=0') },
      ],
      workspaceModes: true,
    };

    const { changes, manifest } = await linkedWorkspaceChanges(workspace, linked);

    expect(changes.map((change) => [change.path, change.contentBase64 === null ? 'delete' : 'write'])).toEqual([
      ['packages/api/.gitignore', 'write'],
      ['src/app.ts', 'write'],
      ['packages/api/src/index.ts', 'write'],
      ['build/tracked.js', 'write'],
      ['.env.example', 'write'],
    ]);
    expect(manifest.map((file) => file.path).sort()).toEqual([
      '.dev.vars.staging',
      '.env.example',
      '.gitignore',
      'build/tracked.js',
      'config/.env.production',
      'packages/api/.gitignore',
      'packages/api/src/index.ts',
      'src/app.ts',
    ]);
    expect(manifest.find((file) => file.path === 'config/.env.production')).toEqual(linked.baseManifest[3]);
  });

  it("leaves what a draft's .gitignore ignores, and local secrets, out of the repository it becomes", async () => {
    const entries: BuilderWorkspaceSyncEntry[] = Object.entries({
      '.gitignore': '*.local\ncoverage\n',
      'src/app.ts': 'export {};',
      'notes.local': 'mine',
      'coverage/index.html': 'report',
      '.dev.vars': 'TOKEN=1',
      '.env': 'SECRET=1',
    }).map(([path, content], index) => ({
      kind: 'write',
      path: `/home/project/${path}`,
      content,
      encoding: 'utf8',
      size: content.length,
      sha256: '',
      revision: index + 1,
    }));
    const workspace: Pick<BuilderWorkspaceApi, 'getSyncPage'> = {
      getSyncPage: async () => ({ state, fromRevision: 0, targetRevision: 6, mode: 'snapshot', entries }),
    };

    const { snapshot, files } = await packDraftSnapshot(workspace);

    const unzipped = new Blob([Uint8Array.from(atob(snapshot), (char) => char.charCodeAt(0))])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const packed: { path: string }[] = JSON.parse(await new Response(unzipped).text());
    expect(packed.map((file) => file.path)).toEqual(['.gitignore', 'src/app.ts']);
    expect(files).toBe(2);
  });
});
