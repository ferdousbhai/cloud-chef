import { describe, expect, it } from 'vitest';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from './builder-workspace-api';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncEntry,
} from '@cloudchef/user-workspace-runtime/protocol';
import { revertChanges, seedLinkedWorkspace, workspaceCommitFiles } from './linked-project-workspace';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { fakeArtifacts } from '~/test/fake-artifacts';
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

/** A project repository holding `files` on main, written as another member's push would. */
async function repository(files: Record<string, string>, executable: string[] = []) {
  const artifacts = fakeArtifacts();
  const repositories = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
  const result = await repositories.commitFiles({
    repo: 't-project-1',
    branch: 'main',
    parent: null,
    files: Object.entries(files).map(([path, content]) => ({
      path,
      mode: executable.includes(path) ? 0o755 : 0o644,
      bytes: new TextEncoder().encode(content),
    })),
    message: 'Initial commit',
    author: { name: 'Ada', email: 'ada@example.com' },
  });
  return { artifacts, repositories, commit: 'commit' in result ? result.commit : '' };
}

const project = { orgProjectId: 'project-1', name: 'Ada site', repo: 't-project-1' };

describe('seedLinkedWorkspace', () => {
  it("seeds main of the project's repository and records its commit", async () => {
    const { repositories, commit } = await repository({
      'README.md': 'hello',
      // Build output a repository might commit stays out, as the workspace's own record does.
      'dist/bundle.js': 'built',
      'src/app.ts': 'export {}',
    });
    const { workspace, appended, committed, linked } = seedingWorkspace();
    await seedLinkedWorkspace(workspace, repositories, project);
    expect(appended.flat().map((entry) => entry.path)).toEqual(['/home/project/README.md', '/home/project/src/app.ts']);
    expect(committed).toEqual([{ fileCount: 2, totalBytes: 14 }]);
    expect(linked).toEqual([
      {
        orgProjectId: 'project-1',
        repository: 't-project-1',
        name: 'Ada site',
        defaultBranch: 'main',
        baseCommit: commit,
      },
    ]);
    expect(appended.flat().map((entry) => entry.mode)).toEqual([0o644, 0o644]);
  });

  it("writes each file with the repository's mode, so an executable stays one in the workspace", async () => {
    const { repositories } = await repository({ 'scripts/build.sh': '#!/bin/sh' }, ['scripts/build.sh']);
    const { workspace, appended } = seedingWorkspace();
    await seedLinkedWorkspace(workspace, repositories, project);
    expect(appended.flat()).toEqual([expect.objectContaining({ path: '/home/project/scripts/build.sh', mode: 0o755 })]);
  });

  it('abandons a seed whose repository could not be read, so the next open starts over', async () => {
    const { repositories } = await repository({ 'a.txt': 'a' });
    const failed = seedingWorkspace();
    await expect(
      seedLinkedWorkspace(failed.workspace, repositories, { ...project, repo: 't-missing' }),
    ).rejects.toThrow();
    expect(failed.aborted).toEqual(['linked_project-1']);
    expect(failed.linked).toEqual([]);
  });

  it('leaves an already seeded workspace alone, and refuses one that lost its link', async () => {
    const { repositories } = await repository({ 'a.txt': 'a' });
    const seeded = seedingWorkspace('initialized');
    await expect(seedLinkedWorkspace(seeded.workspace, repositories, project)).rejects.toThrow('lost track');
    seeded.linked.push({
      orgProjectId: 'project-1',
      repository: 't-project-1',
      defaultBranch: 'main',
      baseCommit: COMMIT,
    });
    await seedLinkedWorkspace(seeded.workspace, repositories, project);
    expect(seeded.appended).toEqual([]);
  });
});

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

describe('workspaceCommitFiles', () => {
  it("leaves what a CloudChef app's .gitignore ignores, and local secrets, out of its commits", async () => {
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

    const read = await workspaceCommitFiles(workspace);

    expect(read?.files.map((file) => file.path)).toEqual(['.gitignore', 'src/app.ts']);
    expect(read?.targetRevision).toBe(6);
  });
});

describe('revertChanges', () => {
  it('writes what differs, deletes what the commit lacks, and keeps what no commit holds', async () => {
    const workspace = await publishingWorkspace({
      '.gitignore': 'notes.local\n',
      'README.md': 'hello',
      'src/app.ts': 'export const changed = 1;',
      'src/added.ts': 'added since',
      'notes.local': 'mine',
      '.dev.vars': 'TOKEN=1',
      'node_modules/x/index.js': 'installed',
    });
    const commitFiles = [
      { path: '.gitignore', mode: '100644', bytes: new TextEncoder().encode('notes.local\n') },
      { path: 'README.md', mode: '100644', bytes: new TextEncoder().encode('hello') },
      { path: 'src/app.ts', mode: '100644', bytes: new TextEncoder().encode('export {}') },
      { path: 'run.sh', mode: '100755', bytes: new TextEncoder().encode('#!') },
    ];
    const { baseRevision, changes } = await revertChanges(workspace, commitFiles);
    expect(baseRevision).toBe(2);
    expect(changes).toEqual([
      { kind: 'write', path: '/home/project/src/app.ts', content: btoa('export {}'), encoding: 'base64', mode: 0o644 },
      { kind: 'write', path: '/home/project/run.sh', content: btoa('#!'), encoding: 'base64', mode: 0o755 },
      { kind: 'delete', path: '/home/project/src/added.ts' },
    ]);
  });
});
