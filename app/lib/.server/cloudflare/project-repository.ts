import * as isogit from 'isomorphic-git';
import { createFsFromVolume, Volume } from 'memfs';
import diff3Merge from 'diff3';
import { z } from 'zod';
import { abortableSleep } from '~/lib/abortable-sleep';
import { bytesToHex } from '~/lib/hex-digest';
import {
  BUILDER_WORKSPACE_MAX_FILE_BYTES,
  BUILDER_WORKSPACE_MAX_FILES,
  BUILDER_WORKSPACE_MAX_TOTAL_BYTES,
} from '@cloudchef/user-workspace-runtime/protocol';
import {
  concatBytes,
  readRemoteRefs,
  tokenSecret,
  updateRemoteRef,
  ZERO_OID,
  type GitFetch,
  type GitRemote,
} from './repository-wire';
import { zipStream, type ZipEntry } from './zip-archive';

/**
 * A project's code and history, kept in Cloudflare Artifacts in the account the project belongs to
 * (`env.ARTIFACTS`, namespace `cloudchef`). The binding reads (log, trees, blobs) and makes repositories,
 * forks, imports and tokens; everything that writes a commit is done here, since Artifacts has no
 * server-side commit or merge: objects are written with isomorphic-git into an in-memory store (memfs,
 * never the workspace's files, which hold no `.git`) and pushed over git's smart HTTP.
 */

/** The one production branch Artifacts supports. */
export const MAIN_BRANCH = 'main';
const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
const PUSH_TOKEN_TTL_SECONDS = 10 * 60;
/** A person's clone token lasts as long as Artifacts allows, a year, so their clone keeps pulling. */
const CLONE_TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
/** A fork or import is ready within seconds to minutes; it is followed this long. */
const READY_WAIT_MS = 5 * 60_000;
const READY_POLL_MS = 1_000;
/** How far back a merge looks for where a branch left main; past that, the two are unrelated. */
const MERGE_BASE_SEARCH_LIMIT = 1_000;
/** Pushes that met a branch moved by someone else are redone this many times before giving up. */
const MERGE_ATTEMPTS = 3;

export type RepositoryAuthor = { name: string; email: string };

/** A file to commit: its bytes, or a blob the repository already has. Modes are the workspace's. */
export type RepositoryFileInput =
  { path: string; mode: number; bytes: Uint8Array } | { path: string; mode: number; oid: string };

/** A file in a commit's tree. `mode` is git's (`100644`, `100755`, `120000` …), `oid` its blob. */
export type RepositoryTreeFile = { path: string; mode: string; oid: string };

/** A regular file of a commit, read. */
type RepositoryFile = RepositoryTreeFile & { bytes: Uint8Array<ArrayBuffer> };

type RepositoryCommit = {
  hash: string;
  treeHash: string;
  message: string;
  author: RepositoryAuthor;
  /** Unix seconds. */
  committedAt: number;
  parents: string[];
};

type RepositoryReadAccess = { remote: string; tokenId: string; token: string; expiresAt: string };

export class ProjectRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'too_large' | 'unavailable' | 'auth_required',
  ) {
    super(message);
    this.name = 'ProjectRepositoryError';
  }
}

/**
 * A CloudChef app's own repository, named after the chat that made it. A subchat publishes as an app of
 * its own, so it has a repository of its own too.
 */
export function nativeProjectRepo(chatInitialId: string, subchatIndex = 0): string {
  const name = `p-${repoNamePart(chatInitialId)}`;
  return subchatIndex === 0 ? name : `${name}-${subchatIndex}`;
}

/** The repository a project imported from elsewhere (GitHub) is given. */
export function importedProjectRepo(projectId: string): string {
  return `t-${repoNamePart(projectId)}`;
}

function repoNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
}

/** What an ArtifactsError carries across Workers RPC: its `code`, or sometimes only its message. */
const artifactsErrorSchema = z
  .object({ code: z.string().optional(), message: z.string().optional() })
  .nullable()
  .catch(null);
type ArtifactsErrorReport = z.infer<typeof artifactsErrorSchema>;

/** The ArtifactsError code of an error, whether as its `code` or only in its message. */
function artifactsErrorCode(error: ArtifactsErrorReport): string | null {
  if (error?.code) {
    return error.code;
  }
  const message = error?.message ?? '';
  const code =
    /\b(ALREADY_EXISTS|NOT_FOUND|CREATE_IN_PROGRESS|IMPORT_IN_PROGRESS|FORK_IN_PROGRESS|REMOTE_AUTH_REQUIRED|INVALID_URL|UPSTREAM_UNAVAILABLE|MEMORY_LIMIT)\b/.exec(
      message,
    )?.[1];
  // Workers RPC may carry only the message, in words: a missing repository must not read as an outage,
  // or every new chat (which first asks whether its own repository exists) would fail to open.
  return code ?? (/\b(not found|does not exist|no such repo)/i.test(message) ? 'NOT_FOUND' : null);
}

const IN_PROGRESS = new Set(['CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS']);

/** Git's mode for a workspace file: executable or not. */
function gitFileMode(mode: number): string {
  return (mode & 0o111) !== 0 ? '100755' : '100644';
}

/** The workspace's mode for a file git holds. */
export function workspaceFileMode(mode: string): number {
  return mode === '100755' ? 0o755 : 0o644;
}

/** Git's object id for file contents: SHA-1 of `blob <size>\0<bytes>`. */
async function gitBlobOid(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  return bytesToHex(await crypto.subtle.digest('SHA-1', concatBytes([header, bytes])));
}

type Dependencies = {
  /** How git's HTTP requests are sent; the global fetch unless a test gives another. */
  fetch?: GitFetch;
};

type ObjectStore = { fs: isogit.PromiseFsClient; gitdir: string };

export class ProjectRepositories {
  readonly #artifacts: Artifacts;
  readonly #fetch: GitFetch;

  constructor(artifacts: Artifacts | undefined, dependencies: Dependencies = {}) {
    if (!artifacts) {
      // Missing user resources fail closed: there is no other place a project's history may go.
      throw new ProjectRepositoryError('This workspace has no project storage. Open the project again.', 'unavailable');
    }
    this.#artifacts = artifacts;
    this.#fetch = dependencies.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The repository, created (empty, `main`) when there is none yet. */
  async ensureRepo(name: string): Promise<{ remote: string; created: boolean }> {
    const existing = await this.#info(name);
    if (existing) {
      return { remote: existing.remote, created: false };
    }
    try {
      const created = await this.#artifacts.create(name, { setDefaultBranch: MAIN_BRANCH });
      await this.#revokeInitialToken(name, created.token);
      return { remote: created.remote, created: true };
    } catch (error) {
      if (artifactsErrorCode(artifactsErrorSchema.parse(error)) !== 'ALREADY_EXISTS') {
        throw error;
      }
      return { remote: (await this.#waitUntilReady(name)).remote, created: false };
    }
  }

  /** Whether the repository exists (and is ready to read). */
  async exists(name: string): Promise<boolean> {
    return (await this.#info(name)) !== null;
  }

  /** The commit `branch` is at, or null when it (or the repository) doesn't exist yet. */
  async head(repo: string, branch: string = MAIN_BRANCH): Promise<string | null> {
    return (await this.exists(repo)) ? ((await this.resolve(repo, branch))?.hash ?? null) : null;
  }

  /** The commit `ref` (a branch, or a commit id) names, or null when it names none. */
  async resolve(repo: string, ref: string): Promise<RepositoryCommit | null> {
    return this.#withRepo(repo, async (handle) => {
      if (/^[0-9a-f]{40}$/.test(ref)) {
        const commit = await handle.readCommit(ref);
        return commit ? toCommit(commit) : null;
      }
      const [head] = await handle.log({ ref, limit: 1 });
      return head ? toCommit(head) : null;
    });
  }

  /** Commits on `ref`'s first-parent chain, newest first. */
  async log(repo: string, options: { ref?: string; limit: number; offset?: number }): Promise<RepositoryCommit[]> {
    if (!(await this.exists(repo))) {
      return [];
    }
    return this.#withRepo(repo, async (handle) =>
      (await handle.log({ ref: options.ref ?? MAIN_BRANCH, limit: options.limit, offset: options.offset ?? 0 })).map(
        toCommit,
      ),
    );
  }

  /** Every file in `ref`'s tree, with its mode and blob, without reading any blob. */
  async readTreeAt(repo: string, ref: string): Promise<{ commit: RepositoryCommit; files: RepositoryTreeFile[] }> {
    const commit = await this.resolve(repo, ref);
    if (!commit) {
      throw new ProjectRepositoryError(`The repository has no commit ${ref.slice(0, 64)}.`, 'not_found');
    }
    const files = await this.#withRepo(repo, async (handle) => [
      ...(await flattenTree(handle, commit.treeHash)).files.values(),
    ]);
    return { commit, files };
  }

  async readBlob(repo: string, oid: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.#withRepo(repo, async (handle) => {
      const blob = await handle.readBlob(oid);
      if (!blob) {
        throw new ProjectRepositoryError('A file in the repository could not be read.', 'not_found');
      }
      return new Uint8Array(await blob.arrayBuffer());
    });
  }

  /**
   * The files at `ref`, bytes and all, within the workspace's limits: a commit holding more than a
   * workspace may is refused before any blob is read. `keep` leaves out paths the caller never takes
   * (installed and built output).
   */
  async readFilesAt(
    repo: string,
    ref: string,
    keep: (path: string) => boolean = () => true,
  ): Promise<{ commit: RepositoryCommit; files: RepositoryFile[] }> {
    const { commit, files } = await this.streamFilesAt(repo, ref, keep);
    const read: RepositoryFile[] = [];
    for await (const file of files) {
      read.push(file);
    }
    return { commit, files: read };
  }

  /** `readFilesAt`, a file at a time: each blob is read only as the one before it is taken. */
  async streamFilesAt(
    repo: string,
    ref: string,
    keep: (path: string) => boolean = () => true,
  ): Promise<{ commit: RepositoryCommit; count: number; files: AsyncGenerator<RepositoryFile> }> {
    const { commit, files } = await this.readTreeAt(repo, ref);
    const kept = files.filter((file) => keep(file.path) && (file.mode === '100644' || file.mode === '100755'));
    if (kept.length > BUILDER_WORKSPACE_MAX_FILES) {
      throw new ProjectRepositoryError(
        `This commit holds ${kept.length} files, more than a workspace's ${BUILDER_WORKSPACE_MAX_FILES}.`,
        'too_large',
      );
    }
    const readBlob = (oid: string) => this.readBlob(repo, oid);
    async function* read(): AsyncGenerator<RepositoryFile> {
      let total = 0;
      for (const file of kept) {
        const bytes = await readBlob(file.oid);
        total += bytes.length;
        if (bytes.length > BUILDER_WORKSPACE_MAX_FILE_BYTES || total > BUILDER_WORKSPACE_MAX_TOTAL_BYTES) {
          throw new ProjectRepositoryError(
            `This commit is larger than a workspace holds (${BUILDER_WORKSPACE_MAX_FILE_BYTES / 1024 / 1024} MB a ` +
              `file, ${BUILDER_WORKSPACE_MAX_TOTAL_BYTES / 1024 / 1024} MB in all).`,
            'too_large',
          );
        }
        yield { ...file, bytes };
      }
    }
    return { commit, count: kept.length, files: read() };
  }

  /**
   * Commits exactly `files` (the whole tree: a file left out is deleted) to `branch` on top of `parent`
   * (null for a first commit). The branch must still be at `replaces` (by default `parent`; null when it
   * must not exist yet), or nothing is written and `{ conflict }` comes back. A tree equal to the
   * parent's writes nothing and answers with the parent.
   */
  async commitFiles(args: {
    repo: string;
    branch: string;
    parent: string | null;
    replaces?: string | null;
    files: readonly RepositoryFileInput[];
    message: string;
    author: RepositoryAuthor;
  }): Promise<{ commit: string; unchanged?: true } | { conflict: true; head: string | null }> {
    const ref = `refs/heads/${args.branch}`;
    const expected = args.replaces === undefined ? args.parent : args.replaces;
    const remote = await this.#pushRemote(args.repo);
    try {
      const head = (await readRemoteRefs(this.#fetch, remote)).get(ref) ?? null;
      if (head !== expected) {
        return { conflict: true, head };
      }
      const known = args.parent
        ? await this.#withRepo(args.repo, async (handle) => {
            const parent = await handle.readCommit(args.parent!);
            if (!parent) {
              throw new ProjectRepositoryError(
                'The commit this work started from is not in the repository.',
                'not_found',
              );
            }
            return flattenTree(handle, parent.treeHash);
          })
        : null;
      const store = await objectStore();
      const sent: string[] = [];
      const tree = new Map<string, { mode: string; oid: string }>();
      for (const file of args.files) {
        const mode = gitFileMode(file.mode);
        if ('oid' in file) {
          tree.set(file.path, { mode, oid: file.oid });
          continue;
        }
        const oid = await gitBlobOid(file.bytes);
        if (!known?.blobs.has(oid)) {
          await isogit.writeBlob({ ...store, blob: file.bytes });
          sent.push(oid);
        }
        tree.set(file.path, { mode, oid });
      }
      const written = await writeTrees(store, tree, known?.trees ?? new Set());
      if (args.parent && written.root === known?.root && head === args.parent) {
        return { commit: args.parent, unchanged: true };
      }
      const commit = await writeCommit(store, {
        tree: written.root,
        parents: args.parent ? [args.parent] : [],
        message: args.message,
        author: args.author,
      });
      const pack = await packObjects(store, [...sent, ...written.written, commit]);
      const result = await updateRemoteRef(
        this.#fetch,
        remote,
        { ref, oldOid: head ?? ZERO_OID, newOid: commit },
        pack,
      );
      if (!result.ok) {
        const now = (await readRemoteRefs(this.#fetch, remote)).get(ref) ?? null;
        if (now !== head) {
          return { conflict: true, head: now };
        }
        throw new Error(`The repository refused the commit (${result.reason}).`);
      }
      return { commit };
    } finally {
      await this.#revokePushToken(args.repo, remote);
    }
  }

  /**
   * Merges `branch` into main: a fast-forward when main hasn't moved since the branch left it, otherwise a
   * three-way merge (file by file, and line by line within a text file both sides changed). Changes that
   * overlap make `{ conflict: true }`, and main is left as it was.
   */
  async mergeIntoMain(args: {
    repo: string;
    branch: string;
    author: RepositoryAuthor;
    message?: string;
  }): Promise<{ commit: string } | { conflict: true }> {
    const branchRef = `refs/heads/${args.branch}`;
    const remote = await this.#pushRemote(args.repo);
    try {
      for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt += 1) {
        const refs = await readRemoteRefs(this.#fetch, remote);
        const theirs = refs.get(branchRef);
        if (!theirs) {
          throw new ProjectRepositoryError(`The branch ${args.branch} is not in the repository.`, 'not_found');
        }
        const ours = refs.get(MAIN_REF) ?? null;
        if (ours === theirs) {
          return { commit: ours };
        }
        const base = ours ? await this.#withRepo(args.repo, (handle) => mergeBase(handle, ours, theirs)) : null;
        if (ours && base === theirs) {
          // Main already holds everything on the branch.
          return { commit: ours };
        }
        let target: string;
        let pack: Uint8Array;
        const store = await objectStore();
        if (!ours || base === ours) {
          target = theirs;
          pack = await packObjects(store, []);
        } else if (!base) {
          return { conflict: true };
        } else {
          const merged = await this.#withRepo(args.repo, (handle) => mergeTrees(handle, store, base, ours, theirs));
          if (!merged) {
            return { conflict: true };
          }
          target = await writeCommit(store, {
            tree: merged.root,
            parents: [ours, theirs],
            message: args.message ?? `Merge ${args.branch}`,
            author: args.author,
          });
          pack = await packObjects(store, [...merged.written, target]);
        }
        const result = await updateRemoteRef(
          this.#fetch,
          remote,
          { ref: MAIN_REF, oldOid: ours ?? ZERO_OID, newOid: target },
          pack,
        );
        if (result.ok) {
          return { commit: target };
        }
        // Main moved while this merge was written: merge again onto where it is now.
      }
      return { conflict: true };
    } finally {
      await this.#revokePushToken(args.repo, remote);
    }
  }

  /** Points main at `commit`, which the repository already holds (a fork's reset to an older commit). */
  async resetMain(repo: string, commit: string): Promise<void> {
    const remote = await this.#pushRemote(repo);
    try {
      const head = (await readRemoteRefs(this.#fetch, remote)).get(MAIN_REF) ?? null;
      if (head === commit) {
        return;
      }
      const pack = await packObjects(await objectStore(), []);
      const result = await updateRemoteRef(
        this.#fetch,
        remote,
        { ref: MAIN_REF, oldOid: head ?? ZERO_OID, newOid: commit },
        pack,
      );
      if (!result.ok) {
        throw new Error(`The repository refused to move main (${result.reason}).`);
      }
    } finally {
      await this.#revokePushToken(repo, remote);
    }
  }

  /** The commit `ref` names, as a streamed ZIP whose files sit under `folder/`. */
  async archiveZip(
    repo: string,
    ref: string,
    folder: string,
  ): Promise<{ commit: RepositoryCommit; stream: ReadableStream<Uint8Array> }> {
    const { commit, files } = await this.readTreeAt(repo, ref);
    const entries: ZipEntry[] = files
      .filter((file) => file.mode === '100644' || file.mode === '100755')
      .map((file) => ({
        path: `${folder}/${file.path}`,
        mode: workspaceFileMode(file.mode),
        read: () => this.readBlob(repo, file.oid),
      }));
    return { commit, stream: zipStream(entries, new Date(commit.committedAt * 1000)) };
  }

  /** A read-only token for git over HTTPS, good for a year, and the repository's remote. */
  async readAccess(repo: string): Promise<RepositoryReadAccess> {
    return this.#withRepo(repo, async (handle) => {
      const [info, token] = await Promise.all([handle.info(), handle.createToken('read', CLONE_TOKEN_TTL_SECONDS)]);
      return {
        remote: info.remote,
        tokenId: token.id,
        token: tokenSecret(token.plaintext),
        expiresAt: token.expiresAt,
      };
    });
  }

  /** Revokes one of the repository's tokens, by id or plaintext; one already gone, with its repository or not, is done. */
  async revokeToken(repo: string, tokenOrId: string): Promise<void> {
    try {
      await this.#withRepo(repo, (handle) => handle.revokeToken(tokenOrId));
    } catch (error) {
      if (artifactsErrorCode(artifactsErrorSchema.parse(error)) !== 'NOT_FOUND') {
        throw error;
      }
    }
  }

  /** Deletes the repository with its history and tokens; one already gone is done. */
  async deleteRepo(name: string): Promise<void> {
    try {
      await this.#artifacts.delete(name);
    } catch (error) {
      if (artifactsErrorCode(artifactsErrorSchema.parse(error)) !== 'NOT_FOUND') {
        throw error;
      }
    }
  }

  /**
   * A copy of `repo` with its history as `name`, ready to use; with `commit`, main is then moved back to
   * it, so the copy starts there. A copy already made (a retry) is reused.
   */
  async fork(repo: string, name: string, options: { commit?: string } = {}): Promise<void> {
    try {
      const forked = await this.#withRepo(repo, (handle) => handle.fork(name, { defaultBranchOnly: true }));
      await this.#revokeInitialToken(name, forked.token);
    } catch (error) {
      if (artifactsErrorCode(artifactsErrorSchema.parse(error)) !== 'ALREADY_EXISTS') {
        throw error;
      }
    }
    await this.#waitUntilReady(name);
    if (options.commit) {
      await this.resetMain(name, options.commit);
    }
  }

  /**
   * Imports a repository from elsewhere with its history, its `branch` becoming main of `repo`. A public
   * one is fetched by Artifacts itself; one that needs `authorization` (the control plane's short-lived,
   * read-only credential) is cloned here and pushed. An import already made (another member's, or a
   * retry) is reused. Returns main's head.
   */
  async importFromUrl(args: {
    url: string;
    authorization?: string | null;
    branch?: string | null;
    repo: string;
  }): Promise<{ commit: string }> {
    if (!(await this.exists(args.repo))) {
      if (args.authorization) {
        await this.#cloneAndPush({ ...args, authorization: args.authorization });
      } else {
        const source: Parameters<Artifacts['import']>[0]['source'] = { url: args.url };
        if (args.branch) {
          source.branch = args.branch;
        }
        try {
          const imported = await this.#artifacts.import({
            source,
            target: { name: args.repo },
          });
          await this.#revokeInitialToken(args.repo, imported.token);
        } catch (error) {
          const code = artifactsErrorCode(artifactsErrorSchema.parse(error));
          if (code === 'REMOTE_AUTH_REQUIRED') {
            throw new ProjectRepositoryError(
              'That repository is private: connect it through GitHub to import it.',
              'auth_required',
            );
          }
          if (code !== 'ALREADY_EXISTS') {
            throw error;
          }
        }
      }
    }
    await this.#waitUntilReady(args.repo);
    const main = await this.resolve(args.repo, MAIN_BRANCH);
    if (main) {
      return { commit: main.hash };
    }
    // Artifacts imported the source's own branch (`master`, say), which HEAD names, though the repository's
    // info still says `main`: main starts there.
    const head = args.branch
      ? await this.resolve(args.repo, args.branch)
      : await this.#withRepo(args.repo, async (handle) => {
          const [commit] = await handle.log({ limit: 1 });
          return commit ? toCommit(commit) : null;
        });
    if (!head) {
      throw new ProjectRepositoryError('The imported repository has no commits.', 'not_found');
    }
    await this.resetMain(args.repo, head.hash);
    return { commit: head.hash };
  }

  async #cloneAndPush(args: {
    url: string;
    authorization: string;
    branch?: string | null;
    repo: string;
  }): Promise<void> {
    const fs = memoryFs();
    const http = httpClient(this.#fetch);
    const clone: Parameters<typeof isogit.clone>[0] = {
      fs,
      http,
      dir: '/source',
      url: args.url,
      singleBranch: true,
      noCheckout: true,
      noTags: true,
      headers: { authorization: args.authorization },
    };
    if (args.branch) {
      clone.ref = args.branch;
    }
    await isogit.clone(clone);
    const branch = args.branch || (await isogit.currentBranch({ fs, dir: '/source' }));
    if (!branch) {
      throw new ProjectRepositoryError('The repository to import has no branch.', 'not_found');
    }
    const remote = await this.#pushRemote(args.repo);
    try {
      const result = await isogit.push({
        fs,
        http,
        dir: '/source',
        url: remote.url,
        ref: branch,
        remoteRef: MAIN_REF,
        onAuth: () => ({ username: 'x', password: remote.secret }),
      });
      if (!result.ok) {
        throw new Error(`The imported history could not be stored (${result.error ?? 'refused'}).`);
      }
    } finally {
      await this.#revokePushToken(args.repo, remote);
    }
  }

  /** The repository's remote with a write token for one push, which `#revokePushToken` ends once it is done. */
  async #pushRemote(repo: string): Promise<GitRemote & { tokenId: string }> {
    const { remote } = await this.ensureRepo(repo);
    const token = await this.#withRepo(repo, (handle) => handle.createToken('write', PUSH_TOKEN_TTL_SECONDS));
    return { url: remote.replace(/\/$/, ''), secret: tokenSecret(token.plaintext), tokenId: token.id };
  }

  /** Ends the write token Artifacts makes with a new repository, which CloudChef never uses (it lasts a day). */
  async #revokeInitialToken(repo: string, token: string): Promise<void> {
    await this.revokeToken(repo, token).catch(() => undefined);
  }

  /** Ends a push's write token; one left behind still expires within minutes. */
  async #revokePushToken(repo: string, remote: { tokenId: string }): Promise<void> {
    await this.revokeToken(repo, remote.tokenId).catch(() => undefined);
  }

  /** The repository's info, or null when there is none; one still being made is waited for. */
  async #info(name: string): Promise<ArtifactsRepoInfo | null> {
    try {
      return await this.#waitUntilReady(name);
    } catch (error) {
      if (artifactsErrorCode(artifactsErrorSchema.parse(error)) === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async #waitUntilReady(name: string): Promise<ArtifactsRepoInfo> {
    const deadline = Date.now() + READY_WAIT_MS;
    for (;;) {
      try {
        return await this.#withRepo(name, (handle) => handle.info());
      } catch (error) {
        if (!IN_PROGRESS.has(artifactsErrorCode(artifactsErrorSchema.parse(error)) ?? '') || Date.now() > deadline) {
          throw error;
        }
      }
      await abortableSleep(READY_POLL_MS);
    }
  }

  async #withRepo<T>(name: string, operation: (handle: ArtifactsRepo) => Promise<T>): Promise<T> {
    const handle = await this.#artifacts.get(name);
    try {
      return await operation(handle);
    } finally {
      handle[Symbol.dispose]?.();
    }
  }
}

function toCommit(commit: ArtifactsCommitMetadata): RepositoryCommit {
  return {
    hash: commit.hash,
    treeHash: commit.treeHash,
    message: commit.message,
    author: { name: commit.author.name, email: commit.author.email },
    committedAt: commit.committedAt,
    parents: commit.parents,
  };
}

type FlatTree = {
  root: string;
  files: Map<string, RepositoryTreeFile>;
  blobs: Set<string>;
  trees: Set<string>;
};

async function flattenTree(handle: ArtifactsRepo, root: string): Promise<FlatTree> {
  const flat: FlatTree = { root, files: new Map(), blobs: new Set(), trees: new Set([root]) };
  const walk = async (hash: string, prefix: string): Promise<void> => {
    const entries = await handle.readTree(hash);
    if (!entries) {
      throw new ProjectRepositoryError('A folder in the repository could not be read.', 'not_found');
    }
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'tree') {
        flat.trees.add(entry.hash);
        await walk(entry.hash, path);
      } else {
        flat.blobs.add(entry.hash);
        flat.files.set(path, { path, mode: normalizeMode(entry.mode, entry.type), oid: entry.hash });
      }
    }
  };
  await walk(root, '');
  return flat;
}

function normalizeMode(mode: string, type: ArtifactsTreeEntryType): string {
  const padded = mode.padStart(6, '0');
  if (/^(100644|100755|120000|160000)$/.test(padded)) {
    return padded;
  }
  return type === 'exec' ? '100755' : type === 'symlink' ? '120000' : type === 'gitlink' ? '160000' : '100644';
}

/** A file system in memory, for git's objects: nothing of it outlives the operation that made it. */
function memoryFs(): isogit.PromiseFsClient {
  return createFsFromVolume(new Volume());
}

async function objectStore(): Promise<ObjectStore> {
  const store = { fs: memoryFs(), gitdir: '/objects.git' };
  await isogit.init({ ...store, bare: true, defaultBranch: MAIN_BRANCH });
  return store;
}

/** Writes the folders of `files` bottom up; `known` trees the repository already has aren't sent again. */
async function writeTrees(
  store: ObjectStore,
  files: ReadonlyMap<string, { mode: string; oid: string }>,
  known: ReadonlySet<string>,
): Promise<{ root: string; written: string[] }> {
  type Folder = { files: Map<string, { mode: string; oid: string }>; folders: Map<string, Folder> };
  const root: Folder = { files: new Map(), folders: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    const name = parts.pop()!;
    let folder = root;
    for (const part of parts) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { files: new Map(), folders: new Map() };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.files.set(name, file);
  }
  const written: string[] = [];
  const write = async (folder: Folder): Promise<string> => {
    const tree: isogit.TreeEntry[] = [];
    for (const [name, child] of folder.folders) {
      tree.push({ mode: '040000', path: name, oid: await write(child), type: 'tree' });
    }
    for (const [name, file] of folder.files) {
      tree.push({ mode: file.mode, path: name, oid: file.oid, type: file.mode === '160000' ? 'commit' : 'blob' });
    }
    const oid = await isogit.writeTree({ ...store, tree });
    if (!known.has(oid)) {
      written.push(oid);
    }
    return oid;
  };
  return { root: await write(root), written };
}

async function writeCommit(
  store: ObjectStore,
  args: { tree: string; parents: string[]; message: string; author: RepositoryAuthor },
): Promise<string> {
  const person = {
    name: args.author.name,
    email: args.author.email,
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: 0,
  };
  return isogit.writeCommit({
    ...store,
    commit: {
      message: args.message.endsWith('\n') ? args.message : `${args.message}\n`,
      tree: args.tree,
      parent: args.parents,
      author: person,
      committer: person,
    },
  });
}

async function packObjects(store: ObjectStore, oids: string[]): Promise<Uint8Array> {
  const { packfile } = await isogit.packObjects({ ...store, oids: [...new Set(oids)] });
  if (!packfile) {
    throw new Error('The commit could not be packed.');
  }
  return packfile;
}

/**
 * Where `theirs` left `ours`: the first of its ancestors (breadth first) that main holds, looking at main's
 * first-parent chain and every parent of those commits, which is where CloudChef's merges put a branch's
 * commit and where every workspace's base commit is. Null when none is within reach.
 */
async function mergeBase(handle: ArtifactsRepo, ours: string, theirs: string): Promise<string | null> {
  const main = new Set<string>();
  for (const commit of await handle.log({ ref: ours, limit: MERGE_BASE_SEARCH_LIMIT })) {
    main.add(commit.hash);
    for (const parent of commit.parents) {
      main.add(parent);
    }
  }
  const queue = [theirs];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < MERGE_BASE_SEARCH_LIMIT) {
    const hash = queue.shift()!;
    if (main.has(hash)) {
      return hash;
    }
    if (seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    const commit = await handle.readCommit(hash);
    queue.push(...(commit?.parents ?? []));
  }
  return null;
}

/** The three-way merge of two commits' trees, or null when their changes overlap. */
async function mergeTrees(
  handle: ArtifactsRepo,
  store: ObjectStore,
  base: string,
  ours: string,
  theirs: string,
): Promise<{ root: string; written: string[] } | null> {
  const [baseCommit, oursCommit, theirsCommit] = await Promise.all(
    [base, ours, theirs].map(async (hash) => {
      const commit = await handle.readCommit(hash);
      if (!commit) {
        throw new ProjectRepositoryError('A commit in the merge could not be read.', 'not_found');
      }
      return commit;
    }),
  );
  const [baseTree, oursTree, theirsTree] = await Promise.all(
    [baseCommit!, oursCommit!, theirsCommit!].map((commit) => flattenTree(handle, commit.treeHash)),
  );
  const merged = new Map<string, { mode: string; oid: string }>();
  const written: string[] = [];
  const paths = new Set([...baseTree!.files.keys(), ...oursTree!.files.keys(), ...theirsTree!.files.keys()]);
  const same = (a?: RepositoryTreeFile, b?: RepositoryTreeFile) => a?.oid === b?.oid && a?.mode === b?.mode;
  for (const path of paths) {
    const o = baseTree!.files.get(path);
    const a = oursTree!.files.get(path);
    const b = theirsTree!.files.get(path);
    // Both sides agree, or only one changed it (a deletion included): that side's version stands.
    const pick = same(a, b) ? a : same(o, a) ? b : same(o, b) ? a : null;
    if (pick !== null) {
      if (pick) {
        merged.set(path, pick);
      }
      continue;
    }
    if (!o || !a || !b || a.mode !== b.mode) {
      return null;
    }
    const text = await mergeText(handle, o.oid, a.oid, b.oid);
    if (text === null) {
      return null;
    }
    const oid = await isogit.writeBlob({ ...store, blob: text });
    written.push(oid);
    merged.set(path, { mode: a.mode, oid });
  }
  const trees = await writeTrees(store, merged, new Set([...oursTree!.trees, ...theirsTree!.trees]));
  return { root: trees.root, written: [...written, ...trees.written] };
}

const LINES = /^.*(\r?\n|$)/gm;

/** A text file both sides changed, merged line by line; null when it isn't text or the changes overlap. */
async function mergeText(
  handle: ArtifactsRepo,
  base: string,
  ours: string,
  theirs: string,
): Promise<Uint8Array | null> {
  const texts: string[] = [];
  for (const oid of [ours, base, theirs]) {
    const blob = await handle.readBlob(oid);
    if (!blob) {
      return null;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.includes(0)) {
      return null;
    }
    try {
      texts.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      return null;
    }
  }
  const [a, o, b] = texts.map((text) => text.match(LINES) ?? []);
  let merged = '';
  for (const block of diff3Merge(a!, o!, b!)) {
    if ('conflict' in block) {
      return null;
    }
    merged += block.ok.join('');
  }
  return new TextEncoder().encode(merged);
}

/** isomorphic-git's HTTP client over `fetch`: each request's body sent whole, the answer streamed back. */
function httpClient(fetchGit: GitFetch): isogit.HttpClient {
  return {
    async request({ url, method = 'GET', headers = {}, body }) {
      const chunks: Uint8Array[] = [];
      if (body) {
        for await (const chunk of body) {
          chunks.push(chunk);
        }
      }
      const init: RequestInit = { method, headers };
      if (chunks.length) {
        init.body = concatBytes(chunks);
      }
      const response = await fetchGit(url, init);
      const reader = response.body?.getReader();
      async function* read(): AsyncGenerator<Uint8Array> {
        if (!reader) {
          return;
        }
        for (;;) {
          const next = await reader.read();
          if (next.done) {
            return;
          }
          yield next.value;
        }
      }
      return {
        url: response.url || url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: read(),
      };
    },
  };
}
