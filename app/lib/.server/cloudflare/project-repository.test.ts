import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fakeArtifacts } from '~/test/fake-artifacts';
import { crc32 } from './zip-archive';
import { updateRemoteRef, ZERO_OID } from './repository-wire';
import {
  filesMatchTree,
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
  it("tells whether a commit is in another's history, through any parent", async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-history');
    const first = await artifacts.commitDirect('p-history', 'main', { 'a.txt': '1' });
    const second = await artifacts.commitDirect('p-history', 'main', { 'a.txt': '2' });
    const unrelated = await artifacts.commitDirect('p-history', 'other', { 'b.txt': '1' });

    expect(await repositories.isAncestor('p-history', first, second)).toBe(true);
    expect(await repositories.isAncestor('p-history', second, second)).toBe(true);
    expect(await repositories.isAncestor('p-history', second, first)).toBe(false);
    expect(await repositories.isAncestor('p-history', first, unrelated)).toBe(false);
    // A walk cut short says it couldn't tell.
    expect(await repositories.isAncestor('p-history', unrelated, second, 1)).toBeNull();
  });

  it('finds the secret files any commit a push brings holds that its base does not', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-secrets');
    const held = await artifacts.commitDirect('p-secrets', 'main', { 'a.txt': '1', '.env': 'KEY=1' });
    // Only on main's history, before the push's base: not the push's.
    const unchanged = await artifacts.commitDirect('p-secrets', 'main', { 'a.txt': '2', '.env': 'KEY=1' });
    const example = await artifacts.commitDirect('p-secrets', 'main', { 'a.txt': '3', '.env.example': 'KEY=' });
    await artifacts.commitDirect('p-secrets', 'main', { 'a.txt': '4', 'api/.dev.vars.local': 'KEY=1' });
    const removed = await artifacts.commitDirect('p-secrets', 'main', { 'a.txt': '5' });
    const changed = await artifacts.commitDirect('p-secrets', 'main', { 'a.txt': '6', '.env': 'KEY=2' });

    expect(await repositories.secretFilesPushed('p-secrets', held, unchanged)).toEqual([]);
    // Deleted again by the last commit, yet in a commit the push brings.
    expect(await repositories.secretFilesPushed('p-secrets', unchanged, removed)).toEqual(['api/.dev.vars.local']);
    expect(await repositories.secretFilesPushed('p-secrets', removed, changed)).toEqual(['.env']);
    expect(await repositories.secretFilesPushed('p-secrets', null, held)).toEqual(['.env']);
    expect(await repositories.secretFilesPushed('p-secrets', unchanged, example)).toEqual([]);
    // Nothing new: the commit itself is still read, against the base.
    expect(await repositories.secretFilesPushed('p-secrets', changed, held)).toEqual(['.env']);
    // A walk cut short says it couldn't tell.
    expect(await repositories.secretFilesPushed('p-secrets', null, changed, 2)).toBeNull();
  });

  it('replaces main with a history of its own only from the commit it was read at', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-rewrite');
    const first = await artifacts.commitDirect('p-rewrite', 'main', { 'a.txt': '1', 'song.mp3': 'big' });
    const second = await artifacts.commitDirect('p-rewrite', 'main', { 'a.txt': '2', 'song.mp3': 'big' });
    const slim = await artifacts.commitDirect('p-rewrite', 'slim', { 'a.txt': '2' });

    // main moved past `first` since it was read: left as it is.
    expect(await repositories.replaceMain('p-rewrite', { from: first, to: slim })).toBeTruthy();
    expect(await artifacts.head('p-rewrite')).toBe(second);

    expect(await repositories.replaceMain('p-rewrite', { from: second, to: slim })).toBeNull();
    expect(await artifacts.head('p-rewrite')).toBe(slim);
  });

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

  it('imports again into a repository an earlier import left empty', async () => {
    const { artifacts, repositories } = setup();
    const head = await artifacts.addSource('https://github.com/acme/site.git', { 'index.html': 'hi' }, 'master');
    await artifacts.create('t-9');
    expect(
      await repositories.importFromUrl({ url: 'https://github.com/acme/site.git', branch: 'master', repo: 't-9' }),
    ).toEqual({ commit: head });
    expect(await artifacts.filesAt('t-9', 'main')).toEqual({ 'index.html': 'hi' });
  });

  it('imports a private repository with its whole history, streaming it through and its credential as a header', async () => {
    const { artifacts, repositories } = setup();
    const url = 'https://github.com/acme/private.git';
    const authorization = `Basic ${btoa('x-access-token:ghs_short_lived')}`;
    const first = await artifacts.addSource(url, { 'a.txt': 'one' }, 'trunk', { authorization });
    // Big enough that its pack goes over in many pieces: random text, which compresses only so far.
    const big = () => Array.from({ length: 16_384 }, () => crypto.randomUUID()).join('');
    await artifacts.commitSource(url, { 'a.txt': 'two', 'big.txt': big() });
    const head = await artifacts.commitSource(url, { 'a.txt': 'three', 'big.txt': big(), 'more/big.txt': big() });
    const sent: string[] = [];
    const watched = new ProjectRepositories(artifacts, {
      fetch: (input, init) => {
        sent.push(input);
        return artifacts.fetch(input, init);
      },
    });
    expect(await watched.importFromUrl({ url, authorization, branch: 'trunk', repo: 't-9' })).toEqual({ commit: head });
    expect((await repositories.log('t-9', { limit: 10 })).map((commit) => commit.hash).at(-1)).toBe(first);
    expect(await repositories.log('t-9', { limit: 10 })).toHaveLength(3);
    expect((await artifacts.filesAt('t-9', 'main'))['a.txt']).toBe('three');
    expect(artifacts.streamedPushes).toEqual([{ repo: 't-9', packBytes: expect.any(Number) }]);
    expect(artifacts.streamedPushes[0]!.packBytes).toBeGreaterThan(512 * 1024);
    expect(sent.every((address) => !address.includes('ghs_') && !address.includes('art_v2'))).toBe(true);
    // The push's write token is ended once the import is done.
    const writes = artifacts.tokens.filter((token) => token.scope === 'write').map((token) => token.id);
    expect(artifacts.revoked).toEqual(expect.arrayContaining(writes));
  });

  it('says a private repository needs GitHub, or that GitHub refused, without the credential to read it', async () => {
    const { artifacts, repositories } = setup();
    const url = 'https://github.com/acme/private.git';
    await artifacts.addSource(url, { 'a.txt': 'one' }, 'main', { authorization: 'Basic right' });
    await expect(repositories.importFromUrl({ url, branch: 'main', repo: 't-9' })).rejects.toMatchObject({
      code: 'auth_required',
      message: expect.stringContaining("That repository wasn't found: it was removed, or it isn't public any more."),
    });
    await expect(
      repositories.importFromUrl({ url, authorization: 'Basic wrong', branch: 'main', repo: 't-9' }),
    ).rejects.toMatchObject({
      code: 'auth_required',
      message: expect.stringContaining('GitHub refused CloudChef access to that repository. To fix it,'),
    });
  });

  it('says so when the source has no such branch', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.addSource('https://github.com/acme/site.git', { 'a.txt': 'one' });
    await expect(
      repositories.importFromUrl({ url: 'https://github.com/acme/site.git', branch: 'gone', repo: 't-9' }),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('the branch GitHub showed as its default (gone) is empty or was removed'),
    });
  });

  it('leaves the repository empty when the copy is cut off partway, and the next import completes it', async () => {
    const { artifacts, repositories } = setup();
    const url = 'https://github.com/acme/site.git';
    await artifacts.addSource(url, { 'a.txt': 'one' });
    const head = await artifacts.commitSource(url, {
      'a.txt': 'two',
      'b.txt': Array.from({ length: 4000 }, (_, index) => `line ${index}\n`).join(''),
    });
    artifacts.cutSource(url, 300);
    await expect(repositories.importFromUrl({ url, branch: 'main', repo: 't-9' })).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('stopped before the whole history arrived'),
    });
    expect(await repositories.head('t-9')).toBeNull();
    artifacts.cutSource(url, Number.MAX_SAFE_INTEGER);
    expect(await repositories.importFromUrl({ url, branch: 'main', repo: 't-9' })).toEqual({ commit: head });
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

  it('hands out a read token for one import on a read-only fork of main alone, without its expiry suffix', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-1');
    const main = await artifacts.commitDirect('p-1', 'main', { 'index.html': 'live' });
    // A workspace's saved branch, and another branch: neither is the copy's to read.
    await artifacts.commitDirect('p-1', 'feature', { 'index.html': 'draft' });
    const remote = await repositories.gitAccess('p-1', 'write');
    await updateRemoteRef(
      artifacts.fetch,
      remote,
      { ref: 'refs/cloudchef/workspaces/w1/main', oldOid: ZERO_OID, newOid: main },
      new Uint8Array(),
    );

    const access = await repositories.readAccess('p-1');

    const copy = `c-${access.tokenId}`;
    expect(access).toEqual({
      remote: `https://artifacts.test/git/cloudchef/${copy}.git`,
      tokenId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      token: 'art_v2_x_0123456789abcdef',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(artifacts.forks.at(-1)).toEqual({ from: 'p-1', to: copy, readOnly: true });
    // As long as an import may take, not the year a clone token lasted.
    expect(artifacts.tokens.at(-1)).toMatchObject({ repo: copy, scope: 'read', ttl: 35 * 60 });
    expect([...(await repositories.refs(copy)).keys()].filter((ref) => ref !== 'HEAD')).toEqual(['refs/heads/main']);

    await repositories.endReadAccess(access.tokenId);
    expect(artifacts.repos.has(copy)).toBe(false);
    expect(artifacts.repos.has('p-1')).toBe(true);
    await expect(repositories.endReadAccess('p-1')).rejects.toThrow('not a read token');
  });

  it('deletes import copies no one ended once their token has expired, and nothing else', async () => {
    const { artifacts, repositories } = setup();
    await artifacts.create('p-1');
    await artifacts.commitDirect('p-1', 'main', { 'index.html': 'live' });
    const left = await repositories.readAccess('p-1');
    const fresh = await repositories.readAccess('p-1');
    artifacts.repos.get(`c-${left.tokenId}`)!.createdAt = new Date(Date.now() - 36 * 60_000).toISOString();
    artifacts.repos.get('p-1')!.createdAt = new Date(0).toISOString();

    await repositories.readAccess('p-1');

    expect(artifacts.repos.has(`c-${left.tokenId}`)).toBe(false);
    expect(artifacts.repos.has(`c-${fresh.tokenId}`)).toBe(true);
    expect(artifacts.repos.has('p-1')).toBe(true);
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

describe('filesMatchTree', () => {
  const text = (value: string) => new TextEncoder().encode(value);
  // git hash-object of "hello\n" and "bye\n".
  const HELLO = 'ce013625030ba8dba906f756967f9e9ca394464a';
  const BYE = 'b023018cabc396e7692c70bbf5784a93d3f738ab';

  it('holds when the regular files, their contents and executable bits match, whatever links the tree has', async () => {
    const tree = [
      { path: 'a.txt', mode: '100644', oid: HELLO },
      { path: 'run.sh', mode: '100755', oid: BYE },
      { path: 'CLAUDE.md', mode: '120000', oid: 'd'.repeat(40) },
    ];
    const files = [
      { path: 'a.txt', mode: 0o644, bytes: text('hello\n') },
      { path: 'run.sh', mode: 0o755, bytes: text('bye\n') },
    ];
    expect(await filesMatchTree(files, tree)).toBe(true);
    expect(await filesMatchTree([files[0]!, { ...files[1]!, mode: 0o644 }], tree)).toBe(false);
    expect(await filesMatchTree([files[0]!, { ...files[1]!, bytes: text('changed\n') }], tree)).toBe(false);
    expect(await filesMatchTree([files[0]!], tree)).toBe(false);
    expect(await filesMatchTree([...files, { path: 'new.txt', mode: 0o644, bytes: text('x') }], tree)).toBe(false);
  });
});
