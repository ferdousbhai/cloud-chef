import { describe, expect, it } from 'vitest';
import type { BuilderWorkspaceApi, BuilderWorkspaceFileMetadata } from './builder-workspace-api';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncEntry,
} from '@cloudchef/user-workspace-runtime/protocol';
import {
  linkedCommitTree,
  linkedWorkspaceChanges,
  memberBranch,
  revertChanges,
  seedLinkedWorkspace,
  workspaceCommitFiles,
} from './linked-project-workspace';
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
const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

describe('seedLinkedWorkspace', () => {
  it("seeds main of the project's repository and records its commit and file hashes", async () => {
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
        baseManifest: [
          { path: 'README.md', sha256: await sha256Hex('hello'), executable: false },
          { path: 'src/app.ts', sha256: await sha256Hex('export {}'), executable: false },
        ],
        // Its own branch, and modes the workspace now holds as the repository's.
        branchKey: expect.stringMatching(/^[a-z0-9]{12}$/),
        workspaceModes: true,
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
      baseManifest: [],
    });
    await seedLinkedWorkspace(seeded.workspace, repositories, project);
    expect(seeded.appended).toEqual([]);
  });
});

describe('linkedCommitTree', () => {
  it("is the base commit's tree with the changes applied, naming unchanged files by their blob", async () => {
    const { repositories, commit } = await repository({ 'README.md': 'hello', 'old.txt': 'gone', 'run.sh': '#!' }, [
      'run.sh',
    ]);
    const { files } = await repositories.readTreeAt('t-project-1', commit);
    const tree = linkedCommitTree(files, [
      { path: 'src/new.ts', bytes: new TextEncoder().encode('new'), executable: false },
      { path: 'old.txt', bytes: null, executable: false },
    ]);
    expect(tree.map((file) => [file.path, file.mode, 'oid' in file ? 'kept' : 'sent'])).toEqual([
      ['README.md', 0o644, 'kept'],
      ['run.sh', 0o755, 'kept'],
      ['src/new.ts', 0o644, 'sent'],
    ]);
  });
});

describe('memberBranch', () => {
  it("names the conversation's branch after the member and its key", () => {
    expect(memberBranch('Sara.Ng@example.com', 'User_12345', 'k3y4chat0001')).toBe(
      'cloudchef/sara-ng-user01-k3y4chat0001',
    );
    expect(memberBranch(null, 'abcdef99', undefined)).toBe('cloudchef/member-abcdef');
  });
});

describe('linkedWorkspaceChanges', () => {
  it('sends changed, new and deleted files, and nothing the repository already has', async () => {
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
    // The repository's executable bit carries over, since the workspace keeps no modes of its own.
    expect(manifest.find((file) => file.path === 'README.md')).toMatchObject({ executable: true });
    expect(manifest.map((file) => file.path)).toEqual(['README.md', 'src/app.ts', 'src/new.ts']);
    expect(changes.map((change) => ({ ...change, bytes: text(change.bytes) }))).toEqual([
      { path: 'src/app.ts', bytes: 'export const changed = 1;', executable: false },
      { path: 'src/new.ts', bytes: 'new', executable: true },
      { path: 'old.txt', bytes: null, executable: false },
    ]);
  });

  it("sends a change of executable bit alone, either way, once the workspace holds the repository's modes", async () => {
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
    expect(changes.map((change) => ({ ...change, bytes: text(change.bytes) }))).toEqual([
      { path: 'run.sh', bytes: '#!', executable: false },
      { path: 'tool.sh', bytes: '#?', executable: true },
    ]);
    // A workspace seeded before it kept modes can't tell a removed bit from one it never had.
    const legacy = await linkedWorkspaceChanges(workspace, { ...linked, workspaceModes: undefined });
    expect(legacy.changes.map((change) => ({ ...change, bytes: text(change.bytes) }))).toEqual([
      { path: 'tool.sh', bytes: '#?', executable: true },
    ]);
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
      '.gitignore': 'coverage/\nbuild/\n.env.ignored\n',
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
      'config/.env.test': 'UNCHANGED=1',
      '.env.sample': 'SECRET=',
      '.envrc': 'use flake',
      '.env.ignored': 'SECRET=3',
    });
    const linked: BuilderWorkspaceLinkedProject = {
      orgProjectId: 'project-1',
      repository: 'ada/site',
      defaultBranch: 'main',
      baseCommit: COMMIT,
      baseManifest: [
        { path: '.gitignore', sha256: await sha256Hex('coverage/\nbuild/\n.env.ignored\n') },
        { path: 'src/app.ts', sha256: await sha256Hex('export {}') },
        // Already in the repository: ignored now, but git still tracks it, so its change goes.
        { path: 'build/tracked.js', sha256: await sha256Hex('tracked') },
        // A secret the repository committed stays as it is there, edited or removed.
        { path: 'config/.env.production', sha256: await sha256Hex('PUBLIC_URL=https://example') },
        { path: '.dev.vars.staging', sha256: await sha256Hex('TOKEN=0') },
        { path: 'config/.env.test', sha256: await sha256Hex('UNCHANGED=1') },
        // Files that only begin like a secret are ordinary ones: their edits go.
        { path: '.envrc', sha256: await sha256Hex('use nix') },
      ],
      workspaceModes: true,
    };

    const { changes, manifest, heldBack } = await linkedWorkspaceChanges(workspace, linked);

    expect(changes.map((change) => [change.path, change.bytes === null ? 'delete' : 'write'])).toEqual([
      ['packages/api/.gitignore', 'write'],
      ['src/app.ts', 'write'],
      ['packages/api/src/index.ts', 'write'],
      ['build/tracked.js', 'write'],
      ['.env.example', 'write'],
      ['.env.sample', 'write'],
      ['.envrc', 'write'],
    ]);
    // What was left out that the person may have meant to send: edited, removed, or new and not ignored.
    expect(heldBack).toEqual([
      '.env',
      '.dev.vars',
      'apps/web/.env.local',
      'config/.env.production',
      '.dev.vars.staging',
    ]);
    expect(manifest.map((file) => file.path).sort()).toEqual([
      '.dev.vars.staging',
      '.env.example',
      '.env.sample',
      '.envrc',
      '.gitignore',
      'build/tracked.js',
      'config/.env.production',
      'config/.env.test',
      'packages/api/.gitignore',
      'packages/api/src/index.ts',
      'src/app.ts',
    ]);
    expect(manifest.find((file) => file.path === 'config/.env.production')).toEqual(linked.baseManifest[3]);
  });

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
