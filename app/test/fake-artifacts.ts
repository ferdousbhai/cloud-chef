/**
 * Cloudflare Artifacts in a test: the binding's namespace (repositories, their reads, tokens, forks and
 * imports), and the git smart-HTTP push the repositories' remotes accept, each repository a bare repository
 * in memory. Pushes go through `fetch`, which the code under test is given in place of the global one.
 */
import * as isogit from 'isomorphic-git';
import { createFsFromVolume, Volume } from 'memfs';
import { dirname } from 'node:path';

const HOST = 'https://artifacts.test';
const SECRET = 'art_v2_x_0123456789abcdef';
const ZERO = '0'.repeat(40);

type FakeRepo = {
  volume: InstanceType<typeof Volume>;
  fs: isogit.PromiseFsClient;
  gitdir: string;
  createdAt: string;
  /** A fork or an import becomes readable this many `get`s later. */
  pendingGets: number;
  pendingCode: string;
};

class FakeArtifactsError extends Error {
  constructor(readonly code: string) {
    super(`${code}: fake Artifacts`);
    this.name = 'ArtifactsError';
  }
}

export type FakeArtifacts = Artifacts & {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * A repository elsewhere (GitHub) an import copies from, by URL, which `fetch` serves as git's upload-pack
   * (protocol version 2); a private one answers only requests sent with its `authorization` header.
   */
  addSource(
    url: string,
    files: Record<string, string>,
    branch?: string,
    options?: { authorization?: string },
  ): Promise<string>;
  /** Commits `files` (the whole tree) on top of the source's branch, so it has history. */
  commitSource(url: string, files: Record<string, string>, message?: string): Promise<string>;
  /** The source's connection drops after sending this many bytes of its pack. */
  cutSource(url: string, afterBytes: number): void;
  /** Pushes whose pack came as a stream rather than whole, and the bytes of pack each sent. */
  streamedPushes: { repo: string; packBytes: number }[];
  /** Commits `files` (the whole tree) on top of `branch` directly, as another member's push would. */
  commitDirect(name: string, branch: string, files: Record<string, string>, message?: string): Promise<string>;
  head(name: string, branch?: string): Promise<string | null>;
  filesAt(name: string, ref: string): Promise<Record<string, string>>;
  repos: Map<string, FakeRepo>;
  /** Pushes received, by repository: each the ref, its old and new value. */
  pushes: { repo: string; ref: string; oldOid: string; newOid: string }[];
  /** Forks and imports stay in progress for this many reads. */
  setPending(count: number): void;
  /** Tokens made, by scope, id and lifetime in seconds, and the ids revoked since. */
  tokens: { repo: string; id: string; scope: 'read' | 'write'; ttl: number | undefined }[];
  revoked: string[];
};

export function fakeArtifacts(): FakeArtifacts {
  const repos = new Map<string, FakeRepo>();
  const sources = new Map<
    string,
    { repo: FakeRepo; branch: string; authorization: string | null; cutAfter: number | null }
  >();
  const pushes: FakeArtifacts['pushes'] = [];
  const streamedPushes: FakeArtifacts['streamedPushes'] = [];
  const tokens: FakeArtifacts['tokens'] = [];
  const revoked: string[] = [];
  let pending = 0;

  async function newRepo(): Promise<FakeRepo> {
    const volume = new Volume();
    const fs: isogit.PromiseFsClient = createFsFromVolume(volume);
    const repo = {
      volume,
      fs,
      gitdir: '/repo.git',
      createdAt: new Date().toISOString(),
      pendingGets: 0,
      pendingCode: '',
    };
    await isogit.init({ fs, gitdir: repo.gitdir, bare: true, defaultBranch: 'main' });
    return repo;
  }

  function copyRepo(source: FakeRepo): FakeRepo {
    const volume = new Volume();
    for (const [path, content] of Object.entries(source.volume.toJSON())) {
      volume.mkdirSync(content === null ? path : dirname(path), { recursive: true });
      if (content !== null) {
        // Byte for byte: git's objects are deflated, which toJSON's strings would not survive.
        volume.writeFileSync(path, source.volume.readFileSync(path));
      }
    }
    return {
      volume,
      fs: createFsFromVolume(volume),
      gitdir: source.gitdir,
      createdAt: new Date().toISOString(),
      pendingGets: pending,
      pendingCode: '',
    };
  }

  const remote = (name: string) => `${HOST}/git/cloudchef/${name}.git`;

  async function resolve(repo: FakeRepo, ref: string): Promise<string | null> {
    try {
      return await isogit.resolveRef({ fs: repo.fs, gitdir: repo.gitdir, ref });
    } catch {
      return /^[0-9a-f]{40}$/.test(ref) ? ref : null;
    }
  }

  async function readCommit(repo: FakeRepo, oid: string): Promise<ArtifactsCommitMetadata | null> {
    try {
      const { commit } = await isogit.readCommit({ fs: repo.fs, gitdir: repo.gitdir, oid });
      return {
        hash: oid,
        treeHash: commit.tree,
        message: commit.message.replace(/\n$/, ''),
        author: { name: commit.author.name, email: commit.author.email },
        committer: { name: commit.committer.name, email: commit.committer.email },
        parents: commit.parent,
        authoredAt: commit.author.timestamp,
        committedAt: commit.committer.timestamp,
      };
    } catch {
      return null;
    }
  }

  function handle(name: string, repo: FakeRepo): ArtifactsRepo {
    return {
      async info() {
        return {
          id: name,
          name,
          description: null,
          defaultBranch: 'main',
          createdAt: repo.createdAt,
          updatedAt: repo.createdAt,
          lastPushAt: null,
          source: null,
          readOnly: false,
          remote: remote(name),
        };
      },
      async log(options = {}) {
        let oid = await resolve(repo, options.ref ?? 'main');
        const commits: ArtifactsCommitMetadata[] = [];
        while (oid) {
          const commit = await readCommit(repo, oid);
          if (!commit) {
            break;
          }
          commits.push(commit);
          oid = commit.parents[0] ?? null;
        }
        const offset = options.offset ?? 0;
        return commits.slice(offset, offset + (options.limit ?? 50));
      },
      readCommit: (oid) => readCommit(repo, oid),
      async readTree(oid) {
        try {
          const { tree } = await isogit.readTree({ fs: repo.fs, gitdir: repo.gitdir, oid });
          return tree.map((entry) => ({
            name: entry.path,
            mode: entry.mode === '040000' ? '40000' : entry.mode,
            hash: entry.oid,
            type: entry.type === 'tree' ? 'tree' : entry.mode === '100755' ? 'exec' : 'blob',
          }));
        } catch {
          return null;
        }
      },
      async readBlob(oid) {
        try {
          const { blob } = await isogit.readBlob({ fs: repo.fs, gitdir: repo.gitdir, oid });
          return new Blob([new Uint8Array(blob)]);
        } catch {
          return null;
        }
      },
      async readFile() {
        return null;
      },
      async createToken(scope = 'write', ttl) {
        // The first token is `token`, as a test that takes one reads it.
        const id = tokens.length === 0 ? 'token' : `token-${tokens.length + 1}`;
        tokens.push({ repo: name, id, scope, ttl });
        return { id, plaintext: `${SECRET}?expires=1893456000`, scope, expiresAt: '2030-01-01T00:00:00.000Z' };
      },
      async listTokens() {
        return { tokens: [], total: 0 };
      },
      async revokeToken(id) {
        revoked.push(id);
        return true;
      },
      async fork(target) {
        if (repos.has(target)) {
          throw new FakeArtifactsError('ALREADY_EXISTS');
        }
        const copy = copyRepo(repo);
        copy.pendingCode = 'FORK_IN_PROGRESS';
        repos.set(target, copy);
        return {
          id: target,
          name: target,
          description: null,
          defaultBranch: 'main',
          remote: remote(target),
          token: SECRET,
        };
      },
      [Symbol.dispose]: () => undefined,
    };
  }

  async function writeFiles(repo: FakeRepo, files: Record<string, string>, parents: string[], message: string) {
    const entries: isogit.TreeEntry[] = [];
    const folders = new Map<string, Record<string, string>>();
    for (const [path, content] of Object.entries(files)) {
      const [first, ...rest] = path.split('/');
      if (rest.length) {
        folders.set(first!, { ...folders.get(first!), [rest.join('/')]: content });
      } else {
        const oid = await isogit.writeBlob({
          fs: repo.fs,
          gitdir: repo.gitdir,
          blob: new TextEncoder().encode(content),
        });
        entries.push({ mode: '100644', path, oid, type: 'blob' });
      }
    }
    for (const [folder, nested] of folders) {
      entries.push({ mode: '040000', path: folder, oid: await writeTreeOf(repo, nested), type: 'tree' });
    }
    const tree = await isogit.writeTree({ fs: repo.fs, gitdir: repo.gitdir, tree: entries });
    const person = { name: 'Other', email: 'other@example.com', timestamp: 1_800_000_000, timezoneOffset: 0 };
    return isogit.writeCommit({
      fs: repo.fs,
      gitdir: repo.gitdir,
      commit: { message: `${message}\n`, tree, parent: parents, author: person, committer: person },
    });
  }

  async function writeTreeOf(repo: FakeRepo, files: Record<string, string>): Promise<string> {
    const commit = await writeFiles(repo, files, [], 'tree');
    return (await isogit.readCommit({ fs: repo.fs, gitdir: repo.gitdir, oid: commit })).commit.tree;
  }

  function lookup(name: string): FakeRepo {
    const repo = repos.get(name);
    if (!repo) {
      throw new FakeArtifactsError('NOT_FOUND');
    }
    if (repo.pendingGets > 0 && repo.pendingCode) {
      repo.pendingGets -= 1;
      throw new FakeArtifactsError(repo.pendingCode);
    }
    return repo;
  }

  async function receivePack(name: string, request: Request, streamed: boolean): Promise<Response> {
    const repo = lookup(name);
    // A pack sent as a stream that breaks fails the request, as it does over the network.
    const body = new Uint8Array(await request.arrayBuffer());
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16);
    const command = new TextDecoder().decode(body.subarray(4, length)).split('\0')[0]!.trim();
    const [oldOid = '', newOid = '', ref = ''] = command.split(' ');
    let offset = length;
    while (new TextDecoder().decode(body.subarray(offset, offset + 4)) !== '0000') {
      offset += Number.parseInt(new TextDecoder().decode(body.subarray(offset, offset + 4)), 16);
    }
    const pack = body.subarray(offset + 4);
    if (streamed) {
      streamedPushes.push({ repo: name, packBytes: pack.length });
    }
    if (pack.length > 32) {
      const file = `objects/pack/pack-${crypto.randomUUID()}.pack`;
      await repo.fs.promises.mkdir(`${repo.gitdir}/objects/pack`, { recursive: true }).catch(() => undefined);
      await repo.fs.promises.writeFile(`${repo.gitdir}/${file}`, pack);
      try {
        await isogit.indexPack({ fs: repo.fs, dir: repo.gitdir, gitdir: repo.gitdir, filepath: file });
      } catch {
        // A pack cut short is refused whole: no object of it is kept, and no ref moves.
        await repo.fs.promises.unlink(`${repo.gitdir}/${file}`).catch(() => undefined);
        await repo.fs.promises.unlink(`${repo.gitdir}/${file.replace(/\.pack$/, '.idx')}`).catch(() => undefined);
        return new Response(`${pkt('unpack index-pack failed\n')}${pkt(`ng ${ref} unpacker error\n`)}0000`);
      }
    }
    const current = (await resolve(repo, ref)) ?? ZERO;
    const lines: string[] = ['unpack ok\n'];
    if (current !== oldOid) {
      lines.push(`ng ${ref} stale info\n`);
    } else if (!(await readCommit(repo, newOid))) {
      lines.push(`ng ${ref} missing necessary objects\n`);
    } else {
      await isogit.writeRef({ fs: repo.fs, gitdir: repo.gitdir, ref, value: newOid, force: true });
      pushes.push({ repo: name, ref, oldOid, newOid });
      lines.push(`ok ${ref}\n`);
    }
    return new Response(`${lines.map(pkt).join('')}0000`);
  }

  async function advertise(name: string): Promise<Response> {
    const repo = lookup(name);
    const branches = await isogit.listBranches({ fs: repo.fs, gitdir: repo.gitdir });
    const refs: string[] = [];
    for (const branch of branches) {
      refs.push(`${await isogit.resolveRef({ fs: repo.fs, gitdir: repo.gitdir, ref: branch })} refs/heads/${branch}`);
    }
    const capabilities = 'report-status delete-refs ofs-delta';
    const lines = refs.length
      ? refs.map((line, index) => (index === 0 ? `${line}\0${capabilities}\n` : `${line}\n`))
      : [`${ZERO} capabilities^{}\0${capabilities}\n`];
    return new Response(`${pkt('# service=git-receive-pack\n')}0000${lines.map(pkt).join('')}0000`);
  }

  const artifacts: FakeArtifacts = {
    repos,
    pushes,
    tokens,
    revoked,
    setPending(count) {
      pending = count;
    },
    async create(name) {
      if (repos.has(name)) {
        throw new FakeArtifactsError('ALREADY_EXISTS');
      }
      repos.set(name, await newRepo());
      return { id: name, name, description: null, defaultBranch: 'main', remote: remote(name), token: SECRET };
    },
    async get(name) {
      return handle(name, lookup(name));
    },
    // Artifacts' type requires it; CloudChef imports by streaming a push instead.
    async import() {
      throw new Error('CloudChef does not use Artifacts import.');
    },
    async list() {
      return { repos: [], total: repos.size };
    },
    async delete(name) {
      return repos.delete(name);
    },
    async addSource(url, files, branch = 'main', options = {}) {
      const repo = await newRepo();
      const commit = await writeFiles(repo, files, [], 'Initial commit');
      await isogit.writeRef({
        fs: repo.fs,
        gitdir: repo.gitdir,
        ref: `refs/heads/${branch}`,
        value: commit,
        force: true,
      });
      if (branch !== 'main') {
        await isogit.writeRef({
          fs: repo.fs,
          gitdir: repo.gitdir,
          ref: 'HEAD',
          value: `refs/heads/${branch}`,
          symbolic: true,
          force: true,
        });
      }
      sources.set(sourceKey(url), { repo, branch, authorization: options.authorization ?? null, cutAfter: null });
      return commit;
    },
    async commitSource(url, files, message = 'More') {
      const source = sources.get(sourceKey(url))!;
      const ref = `refs/heads/${source.branch}`;
      const head = await resolve(source.repo, ref);
      const commit = await writeFiles(source.repo, files, head ? [head] : [], message);
      await isogit.writeRef({ fs: source.repo.fs, gitdir: source.repo.gitdir, ref, value: commit, force: true });
      return commit;
    },
    cutSource(url, afterBytes) {
      sources.get(sourceKey(url))!.cutAfter = afterBytes;
    },
    async commitDirect(name, branch, files, message = 'Elsewhere') {
      const repo = lookup(name);
      const head = await resolve(repo, `refs/heads/${branch}`);
      const commit = await writeFiles(repo, files, head ? [head] : [], message);
      await isogit.writeRef({
        fs: repo.fs,
        gitdir: repo.gitdir,
        ref: `refs/heads/${branch}`,
        value: commit,
        force: true,
      });
      return commit;
    },
    async head(name, branch = 'main') {
      return resolve(lookup(name), `refs/heads/${branch}`);
    },
    async filesAt(name, ref) {
      const repo = lookup(name);
      const oid = await resolve(repo, ref);
      const files: Record<string, string> = {};
      const walk = async (tree: string, prefix: string) => {
        for (const entry of (await isogit.readTree({ fs: repo.fs, gitdir: repo.gitdir, oid: tree })).tree) {
          const path = prefix ? `${prefix}/${entry.path}` : entry.path;
          if (entry.type === 'tree') {
            await walk(entry.oid, path);
          } else {
            const { blob } = await isogit.readBlob({ fs: repo.fs, gitdir: repo.gitdir, oid: entry.oid });
            files[path] = new TextDecoder().decode(blob);
          }
        }
      };
      const { commit } = await isogit.readCommit({ fs: repo.fs, gitdir: repo.gitdir, oid: oid! });
      await walk(commit.tree, '');
      return files;
    },
    async fetch(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const service = /^(.*)\/(info\/refs|git-upload-pack)$/.exec(`${url.origin}${url.pathname}`);
      const source = service ? sources.get(sourceKey(service[1]!)) : undefined;
      if (service && source) {
        if (source.authorization && request.headers.get('authorization') !== source.authorization) {
          return new Response('Unauthorized', { status: 401 });
        }
        if (request.headers.get('git-protocol') !== 'version=2') {
          return new Response('Only protocol version 2 here', { status: 400 });
        }
        return service[2] === 'info/refs' ? uploadPackAdvertisement() : uploadPack(source, request);
      }
      const match = /^\/git\/cloudchef\/([^/]+)\.git\/(info\/refs|git-receive-pack)$/.exec(url.pathname);
      if (url.origin !== HOST || !match) {
        return new Response('Not found', { status: 404 });
      }
      if (request.headers.get('authorization') !== `Basic ${btoa(`x:${SECRET}`)}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      return match[2] === 'info/refs'
        ? advertise(match[1]!)
        : receivePack(match[1]!, request, init?.body instanceof ReadableStream);
    },
    streamedPushes,
  };

  /** Every object `oid` (a commit) reaches: its history, their trees and blobs. */
  async function reachable(repo: FakeRepo, oid: string): Promise<string[]> {
    const seen = new Set<string>();
    const walkTree = async (tree: string) => {
      if (seen.has(tree)) {
        return;
      }
      seen.add(tree);
      for (const entry of (await isogit.readTree({ fs: repo.fs, gitdir: repo.gitdir, oid: tree })).tree) {
        if (entry.type === 'tree') {
          await walkTree(entry.oid);
        } else {
          seen.add(entry.oid);
        }
      }
    };
    const commits = [oid];
    while (commits.length) {
      const next = commits.pop()!;
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      const { commit } = await isogit.readCommit({ fs: repo.fs, gitdir: repo.gitdir, oid: next });
      await walkTree(commit.tree);
      commits.push(...commit.parent);
    }
    return [...seen];
  }

  /** Git's upload-pack, protocol version 2: `ls-refs`, and `fetch` answered with the whole history. */
  async function uploadPack(
    source: { repo: FakeRepo; branch: string; cutAfter: number | null },
    request: Request,
  ): Promise<Response> {
    const lines = readPkts(new Uint8Array(await request.arrayBuffer()));
    const { repo } = source;
    if (lines[0] === 'command=ls-refs') {
      const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
      const head = await resolve(repo, `refs/heads/${source.branch}`);
      const refs = [`${head} HEAD symref-target:refs/heads/${source.branch}`, `${head} refs/heads/${source.branch}`];
      const listed = refs.filter((line) => prefixes.some((prefix) => line.split(' ')[1]!.startsWith(prefix)));
      return new Response(`${listed.map((line) => pkt(`${line}\n`)).join('')}0000`);
    }
    const want = lines.find((line) => line.startsWith('want '))?.slice(5);
    if (lines[0] !== 'command=fetch' || !want || !lines.includes('done')) {
      return new Response(`${pkt('ERR unexpected request\n')}0000`);
    }
    const { packfile } = await isogit.packObjects({
      fs: repo.fs,
      gitdir: repo.gitdir,
      oids: await reachable(repo, want),
    });
    const pack = packfile!;
    const cut = source.cutAfter;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(pkt('packfile\n')));
          controller.enqueue(encoder.encode(pkt('\u0002Counting objects\n')));
          // Small bands, so a pkt-line is split across reads as the network splits it.
          for (let offset = 0; offset < pack.length; offset += 1000) {
            const end = Math.min(pack.length, offset + 1000, cut ?? Infinity);
            if (end <= offset) {
              controller.close();
              return;
            }
            const band = new Uint8Array(end - offset + 5);
            band.set(encoder.encode(band.length.toString(16).padStart(4, '0')));
            band[4] = 1;
            band.set(pack.subarray(offset, end), 5);
            controller.enqueue(band.subarray(0, 7));
            controller.enqueue(band.subarray(7));
          }
          controller.enqueue(encoder.encode('0000'));
          controller.close();
        },
      }),
    );
  }

  return artifacts;
}

function uploadPackAdvertisement(): Response {
  return new Response(
    `${pkt('# service=git-upload-pack\n')}0000${pkt('version 2\n')}${pkt('ls-refs\n')}${pkt('fetch\n')}0000`,
  );
}

/** A source's address however it is written: with or without `.git` and a trailing slash. */
function sourceKey(url: string): string {
  return url.replace(/\/+$/, '').replace(/\.git$/, '');
}

/** The text of each pkt-line; flush and delimiter lines are skipped. */
function readPkts(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(new TextDecoder().decode(bytes.subarray(offset, offset + 4)), 16);
    if (length < 4) {
      offset += 4;
      continue;
    }
    lines.push(new TextDecoder().decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, ''));
    offset += length;
  }
  return lines;
}

function pkt(line: string): string {
  return `${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, '0')}${line}`;
}
