import { describe, expect, it } from 'vitest';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';
import { fakeArtifacts } from '~/test/fake-artifacts';

/**
 * A project's repository is written in the Worker (isomorphic-git over an in-memory file system) and pushed
 * over git's HTTP: this runs that in workerd, with nodejs_compat as the runtime is deployed, rather than Node.
 */
describe('project repositories in workerd', () => {
  it('commits, merges and archives', async () => {
    const artifacts = fakeArtifacts();
    const repositories = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
    const author = { name: 'Sara', email: 'sara@example.com' };
    await artifacts.create('t-1');
    const base = await artifacts.commitDirect('t-1', 'main', { 'a.txt': '1\n2\n3\n' });
    await artifacts.commitDirect('t-1', 'main', { 'a.txt': 'one\n2\n3\n' });
    const branch = await repositories.commitFiles({
      repo: 't-1',
      branch: 'cloudchef/sara-1',
      parent: base,
      replaces: null,
      files: [{ path: 'a.txt', mode: 0o644, bytes: new TextEncoder().encode('1\n2\nthree\n') }],
      message: 'Mine',
      author,
    });
    expect('commit' in branch).toBe(true);
    const merged = await repositories.mergeIntoMain({ repo: 't-1', branch: 'cloudchef/sara-1', author });
    expect('commit' in merged).toBe(true);
    expect(await artifacts.filesAt('t-1', 'main')).toEqual({ 'a.txt': 'one\n2\nthree\n' });
    const { stream } = await repositories.archiveZip('t-1', 'main', 'site');
    expect((await new Response(stream).arrayBuffer()).byteLength).toBeGreaterThan(22);
  });

  it('imports a private repository, streaming its history from the source into the push', async () => {
    const artifacts = fakeArtifacts();
    const repositories = new ProjectRepositories(artifacts, { fetch: artifacts.fetch });
    const url = 'https://github.com/acme/private.git';
    await artifacts.addSource(url, { 'a.txt': 'one' }, 'main', { authorization: 'Basic short-lived' });
    const head = await artifacts.commitSource(url, { 'a.txt': 'two', 'b/c.txt': 'three' });
    expect(
      await repositories.importFromUrl({ url, authorization: 'Basic short-lived', branch: 'main', repo: 't-1' }),
    ).toEqual({ commit: head });
    expect(artifacts.streamedPushes).toHaveLength(1);
    expect(await artifacts.filesAt('t-1', 'main')).toEqual({ 'a.txt': 'two', 'b/c.txt': 'three' });
  });
});
