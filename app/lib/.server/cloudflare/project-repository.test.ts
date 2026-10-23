import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fakeArtifacts } from '~/test/fake-artifacts';
import { crc32 } from './zip-archive';
import {
  importedProjectRepo,
  nativeProjectRepo,
  ProjectRepositories,
  ProjectRepositoryError,
  type RepositoryFileInput,
} from './project-repository';

const author = { name: 'Sara', email: 'sara@example.com' };
const text = (path: string, content: string, mode = 0o644): RepositoryFileInput => ({
  path,
  mode,
  bytes: new TextEncoder().encode(content),
});

function setup() {
  const artifacts = fakeArtifacts();
  return { artifacts, repositories: new ProjectRepositories(artifacts, { fetch: artifacts.fetch }) };
}

describe('ProjectRepositories', () => {
  it('names repositories after their chat or project', () => {
    expect(nativeProjectRepo('6f1c2a7e-0000-4000-8000-000000000001')).toBe('p-6f1c2a7e-0000-4000-8000-000000000001');
    expect(importedProjectRepo('a b/c')).toBe('t-a-b-c');
  });

  it('fails closed without the binding', () => {
    expect(() => new ProjectRepositories(undefined)).toThrow(ProjectRepositoryError);
  });

  it('commits the whole tree, so a file left out is deleted', async () => {
    const { artifacts, repositories } = setup();
    const first = await repositories.commitFiles({
      repo: 'p-1',
      branch: 'main',
      parent: null,
      files: [text('index.html', '<h1>Hi</h1>'), text('src/app.ts', 'export {}'), text('run.sh', 'echo', 0o755)],
      message: 'First\n\nCloudChef-Revision: abc',
      author,
    });
    expect('commit' in first).toBe(true);
    const firstCommit = 'commit' in first ? first.commit : '';
    expect(await artifacts.head('p-1')).toBe(firstCommit);

    const second = await repositories.commitFiles({
      repo: 'p-1',
      branch: 'main',
      parent: firstCommit,
      files: [text('index.html', '<h1>Hello</h1>'), text('run.sh', 'echo', 0o755)],
      message: 'Second',
      author,
    });
    const secondCommit = 'commit' in second ? second.commit : '';
    expect(await artifacts.filesAt('p-1', secondCommit)).toEqual({ 'index.html': '<h1>Hello</h1>', 'run.sh': 'echo' });

    const { files } = await repositories.readFilesAt('p-1', 'main');
    expect(files.map((file) => [file.path, file.mode])).toEqual([
      ['index.html', '100644'],
      ['run.sh', '100755'],
    ]);
    const history = await repositories.log('p-1', { limit: 10 });
    expect(history.map((commit) => commit.message)).toEqual(['Second', 'First\n\nCloudChef-Revision: abc']);
    expect(history[0]?.author).toEqual(author);
    expect(history[0]?.parents).toEqual([firstCommit]);
  });

  it('writes nothing for a tree its parent already has', async () => {
    const { artifacts, repositories } = setup();
    const first = await repositories.commitFiles({
      repo: 'p-1',
      branch: 'main',
      parent: null,
      files: [text('a.txt', 'a')],
      message: 'First',
      author,
    });
    const commit = 'commit' in first ? first.commit : '';
    const again = await repositories.commitFiles({
      repo: 'p-1',
      branch: 'main',
      parent: commit,
      files: [text('a.txt', 'a')],
      message: 'Same',
      author,
    });
    expect(again).toEqual({ commit, unchanged: true });
    expect(artifacts.pushes).toHaveLength(1);
  });

  it('refuses a commit whose branch moved since its parent', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-1');
    const base = await artifacts.commitDirect('p-1', 'main', { 'a.txt': 'a' });
    const moved = await artifacts.commitDirect('p-1', 'main', { 'a.txt': 'b' });
    const result = await repositories.commitFiles({
      repo: 'p-1',
      branch: 'main',
      parent: base,
      files: [text('a.txt', 'c')],
      message: 'Late',
      author,
    });
    expect(result).toEqual({ conflict: true, head: moved });
    expect(await artifacts.head('p-1')).toBe(moved);
  });

  it('replaces a branch on top of its base when told what it held', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('t-1');
    const base = await artifacts.commitDirect('t-1', 'main', { 'a.txt': 'a' });
    const first = await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-1',
      parent: base,
      replaces: null,
      files: [text('a.txt', 'one')],
      message: 'One',
      author,
    });
    const firstCommit = 'commit' in first ? first.commit : '';
    const second = await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-1',
      parent: base,
      replaces: firstCommit,
      files: [text('a.txt', 'two')],
      message: 'Two',
      author,
    });
    const secondCommit = 'commit' in second ? second.commit : '';
    expect((await repositories.resolve('t-1', secondCommit))?.parents).toEqual([base]);
    expect(await artifacts.head('t-1', 'cloudchef/sara-1')).toBe(secondCommit);
  });

  it('fast-forwards main when it has not moved', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('t-1');
    const base = await artifacts.commitDirect('t-1', 'main', { 'a.txt': 'a' });
    const branch = await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-1',
      parent: base,
      replaces: null,
      files: [text('a.txt', 'b')],
      message: 'Change',
      author,
    });
    const commit = 'commit' in branch ? branch.commit : '';
    expect(await repositories.mergeIntoMain({ repo: 't-1', branch: 'cloudchef/sara-1', author })).toEqual({ commit });
    expect(await artifacts.head('t-1')).toBe(commit);
  });

  it('merges changes to different lines and files, and refuses overlapping ones', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('t-1');
    const base = await artifacts.commitDirect('t-1', 'main', { 'a.txt': '1\n2\n3\n4\n5\n', 'b.txt': 'b' });
    await artifacts.commitDirect('t-1', 'main', { 'a.txt': 'one\n2\n3\n4\n5\n', 'b.txt': 'b', 'c.txt': 'c' });
    await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-1',
      parent: base,
      replaces: null,
      files: [text('a.txt', '1\n2\n3\n4\nfive\n')],
      message: 'Mine',
      author,
    });
    const merged = await repositories.mergeIntoMain({ repo: 't-1', branch: 'cloudchef/sara-1', author });
    expect('commit' in merged).toBe(true);
    expect(await artifacts.filesAt('t-1', 'main')).toEqual({ 'a.txt': 'one\n2\n3\n4\nfive\n', 'c.txt': 'c' });
    const mergeCommit = await repositories.resolve('t-1', 'main');
    expect(mergeCommit?.parents).toHaveLength(2);

    await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-2',
      parent: base,
      replaces: null,
      files: [text('a.txt', 'uno\n2\n3\n4\n5\n'), text('b.txt', 'b')],
      message: 'Overlapping',
      author,
    });
    const head = await artifacts.head('t-1');
    expect(await repositories.mergeIntoMain({ repo: 't-1', branch: 'cloudchef/sara-2', author })).toEqual({
      conflict: true,
    });
    expect(await artifacts.head('t-1')).toBe(head);
  });

  it('merges a branch again from its last merged commit, not from where it first left main', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('t-1');
    const base = await artifacts.commitDirect('t-1', 'main', { 'a.txt': '1\n2\n3\n' });
    await artifacts.commitDirect('t-1', 'main', { 'a.txt': '1\n2\n3\n', 'b.txt': 'b' });
    const first = await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-1',
      parent: base,
      replaces: null,
      files: [text('a.txt', '1\n2\nthree\n')],
      message: 'First',
      author,
    });
    const firstCommit = 'commit' in first ? first.commit : '';
    expect('commit' in (await repositories.mergeIntoMain({ repo: 't-1', branch: 'cloudchef/sara-1', author }))).toBe(
      true,
    );
    const merged = await artifacts.filesAt('t-1', 'main');
    await artifacts.commitDirect('t-1', 'main', { ...merged, 'c.txt': 'c' });
    // The workspace's base is now its merged commit, and the branch is replaced on top of it.
    await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-1',
      parent: firstCommit,
      replaces: firstCommit,
      files: [text('a.txt', '1\n2\nTHREE\n')],
      message: 'Second',
      author,
    });
    expect('commit' in (await repositories.mergeIntoMain({ repo: 't-1', branch: 'cloudchef/sara-1', author }))).toBe(
      true,
    );
    expect(await artifacts.filesAt('t-1', 'main')).toEqual({ 'a.txt': '1\n2\nTHREE\n', 'b.txt': 'b', 'c.txt': 'c' });
  });

  it('forks with history, starting the copy at an older commit', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-1');
    const older = await artifacts.commitDirect('p-1', 'main', { 'a.txt': 'old' });
    await artifacts.commitDirect('p-1', 'main', { 'a.txt': 'new' });
    artifacts.setPending(1);
    await repositories.fork('p-1', 'p-2', { commit: older });
    expect(await artifacts.head('p-2')).toBe(older);
    expect(await artifacts.filesAt('p-2', 'main')).toEqual({ 'a.txt': 'old' });
    expect(await artifacts.filesAt('p-1', 'main')).toEqual({ 'a.txt': 'new' });
  });

  it('imports a public repository, its own branch becoming main', async () => {
    const { artifacts, repositories } = setup();
    const head = await artifacts.addSource('https://github.com/acme/site.git', { 'index.html': 'hi' }, 'master');
    expect(
      await repositories.importFromUrl({ url: 'https://github.com/acme/site.git', branch: 'master', repo: 't-9' }),
    ).toEqual({ commit: head });
    expect(await artifacts.head('t-9')).toBe(head);
    // Imported already (another member's import): reused.
    expect(
      await repositories.importFromUrl({ url: 'https://github.com/acme/site.git', branch: 'master', repo: 't-9' }),
    ).toEqual({ commit: head });
  });

  it('revokes the write token Artifacts makes with a new or forked repository', async () => {
    const { artifacts, repositories } = setup();
    await repositories.ensureRepo('p-1');
    await repositories.fork('p-1', 'p-2');
    expect(artifacts.revoked).toHaveLength(2);
  });

  it('revokes the write token of each push once it is done', async () => {
    const { artifacts, repositories } = setup();
    await repositories.commitFiles({
      repo: 'p-1',
      branch: 'main',
      parent: null,
      files: [{ path: 'a.txt', mode: 0o644, bytes: new TextEncoder().encode('a') }],
      message: 'First',
      author: { name: 'Sara', email: 'sara@example.com' },
    });
    const writes = artifacts.tokens.filter((token) => token.scope === 'write').map((token) => token.id);
    expect(writes).toHaveLength(1);
    // After the new repository's own token.
    expect(artifacts.revoked.slice(1)).toEqual(writes);
  });

  it('hands out a read token without its expiry suffix', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-1');
    const access = await repositories.readAccess('p-1');
    expect(access).toEqual({
      remote: 'https://artifacts.test/git/cloudchef/p-1.git',
      tokenId: 'token',
      token: 'art_v2_x_0123456789abcdef',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('streams a commit as a ZIP archive', async () => {
    const { repositories } = setup();
    await repositories.commitFiles({
      repo: 'p-1',
      branch: 'main',
      parent: null,
      files: [text('index.html', '<h1>Hi</h1>'), text('bin/run.sh', 'echo hi', 0o755)],
      message: 'First',
      author,
    });
    const { stream } = await repositories.archiveZip('p-1', 'main', 'site-abc1234');
    const zip = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(readZip(zip)).toEqual({
      'site-abc1234/bin/run.sh': { content: 'echo hi', mode: 0o755 },
      'site-abc1234/index.html': { content: '<h1>Hi</h1>', mode: 0o644 },
    });
  });
});

/** The entries of a ZIP archive, read from its central directory. */
function readZip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: Record<string, { content: string; mode: number }> = {};
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const mode = view.getUint32(at + 38, true) >>> 16;
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    const localNameLength = view.getUint16(local + 26, true);
    const data = zip.subarray(local + 30 + localNameLength, local + 30 + localNameLength + compressedSize);
    const content = new Uint8Array(inflateRawSync(data));
    expect(crc32(content)).toBe(crc);
    entries[name] = { content: new TextDecoder().decode(content), mode: mode & 0o777 };
    at += 46 + nameLength;
  }
  return entries;
}
