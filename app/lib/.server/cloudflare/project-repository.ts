import { GITHUB_ACCESS_FIX } from '~/lib/github-return-messages';
import * as isogit from 'isomorphic-git';
import { createFsFromVolume, Volume } from 'memfs';
import { z } from 'zod';
import { abortableSleep } from '~/lib/abortable-sleep';
import { bytesToHex } from '~/lib/hex-digest';
import {
  BUILDER_WORKSPACE_MAX_FILE_BYTES,
  BUILDER_WORKSPACE_MAX_FILES,
  BUILDER_WORKSPACE_MAX_TOTAL_BYTES,
} from '@cloudchef/user-workspace-runtime/protocol';
import { fetchSourcePack, GitSourceError, readSourceBranch, type GitSource } from './repository-source';
import {
  concatBytes,
  readRemoteAdvertisement,
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
 * forks and tokens; everything that writes a commit is done here, since Artifacts has no server-side
 * commit or merge: objects are written with isomorphic-git into an in-memory store (memfs, never the
 * workspace's files, which hold no `.git`) and pushed over git's smart HTTP. An import is a push too: the
 * source's pack, streamed through from it (`repository-source.ts`).
 */

/** The one production branch Artifacts supports. */
export const MAIN_BRANCH = 'main';
const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
const PUSH_TOKEN_TTL_SECONDS = 10 * 60;
/** An import's push is one request, as long as the whole history takes to copy; its token lasts as long. */
const IMPORT_TIMEOUT_MS = 30 * 60_000;
const IMPORT_TOKEN_TTL_SECONDS = 35 * 60;
/** The most history an import copies: what a repository in Artifacts may hold. */
const IMPORT_MAX_PACK_BYTES = 1024 * 1024 * 1024;
/** A new repository or fork is ready within seconds to minutes; it is followed this long. */
const READY_WAIT_MS = 5 * 60_000;
const READY_POLL_MS = 1_000;
/** Commit times drift between machines: an ancestor's history is walked this far before it, in seconds. */
const DAY_SECONDS = 24 * 60 * 60;

export type RepositoryAuthor = { name: string; email: string };

/** A file to commit: its bytes, or a blob the repository already has. Modes are the workspace's. */
export type RepositoryFileInput =
  { path: string; mode: number; bytes: Uint8Array } | { path: string; mode: number; oid: string };

/** A file in a commit's tree. `mode` is git's (`100644`, `100755`, `120000` …), `oid` its blob. */
type RepositoryTreeFile = { path: string; mode: string; oid: string };

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
    /** `refused`: trying again won't change the answer; `unavailable`: it may. */
    readonly code: 'not_found' | 'too_large' | 'unavailable' | 'auth_required' | 'refused',
  ) {
    super(message);
    this.name = 'ProjectRepositoryError';
  }
}

/*
 * Repository names: `p-<chat id>` for a project started in a chat, `t-<project id>` for one made from outside
 * (imported from GitHub, or uploaded as a ZIP). The letters are historical and mean nothing now: a team project
 * approved from a draft keeps its `p-` repository, and a person's own imports get `t-`. They stay because a
 * repository can't be renamed in place, and live sites build from these names. Never read what a project is
 * from its prefix; the control plane's row says that.
 */

/** A CloudChef app's own repository, named after the chat that made it, whose conversations all work on it. */
export function nativeProjectRepo(chatInitialId: string): string {
  return `p-${repoNamePart(chatInitialId)}`;
}

/** The repository a project made from outside (a GitHub import, or a ZIP upload) is given. */
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
  const code = /\b(ALREADY_EXISTS|NOT_FOUND|CREATE_IN_PROGRESS|FORK_IN_PROGRESS)\b/.exec(message)?.[1];
  // Workers RPC may carry only the message, in words: a missing repository must not read as an outage,
  // or every new chat (which first asks whether its own repository exists) would fail to open.
  return code ?? (/\b(not found|does not exist|no such repo)/i.test(message) ? 'NOT_FOUND' : null);
}

const IN_PROGRESS = new Set(['CREATE_IN_PROGRESS', 'FORK_IN_PROGRESS']);

/** Git's mode for a workspace file: executable or not. */
function gitFileMode(mode: number): string {
  // A symbolic link or submodule a commit carries over from its parent's tree keeps its kind.
  const kind = mode & 0o170000;
  if (kind === 0o120000) {
    return '120000';
  }
  if (kind === 0o160000) {
    return '160000';
  }
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

/**
 * Whether a commit's tree holds exactly these files, with the same contents and executable bits. Only its
 * regular files count: a workspace holds no symbolic links or submodules, so those are left as they are.
 */
export async function filesMatchTree(
  files: readonly RepositoryFileInput[],
  tree: readonly RepositoryTreeFile[],
): Promise<boolean> {
  const regular = new Map(
    tree.filter((file) => file.mode === '100644' || file.mode === '100755').map((file) => [file.path, file]),
  );
  if (regular.size !== files.length) {
    return false;
  }
  for (const file of files) {
    const committed = regular.get(file.path);
    const oid = 'oid' in file ? file.oid : await gitBlobOid(file.bytes);
    if (!committed || committed.oid !== oid || (committed.mode === '100755') !== ((file.mode & 0o111) !== 0)) {
      return false;
    }
  }
  return true;
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

  /**
   * Whether `ancestor` is `commit` or in its history (every parent, not only the first), reading at most
   * `limit` commits; null when the walk stops there. Commits made over a day before `ancestor` aren't walked
   * past, so a history that doesn't hold it ends soon.
   */
  async isAncestor(repo: string, ancestor: string, commit: string, limit = 5_000): Promise<boolean | null> {
    return this.#withRepo(repo, async (handle) => {
      const oldest = await handle.readCommit(ancestor);
      if (!oldest) {
        return false;
      }
      const seen = new Set<string>();
      const queue = [commit];
      for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        if (next === ancestor) {
          return true;
        }
        if (seen.has(next)) {
          continue;
        }
        seen.add(next);
        if (seen.size > limit) {
          return null;
        }
        const read = await handle.readCommit(next);
        if (read && read.committedAt >= oldest.committedAt - DAY_SECONDS) {
          queue.push(...read.parents);
        }
      }
      return false;
    });
  }

  /**
   * The local secret files (`.env`, `.dev.vars` and their variants, not `.env.example` and the like) `commit` adds
   * or changes compared with `base`: what the workspace's own commit hook refuses, for a push from anywhere.
   */
  async secretFilesChanged(repo: string, base: string, commit: string): Promise<string[]> {
    const [before, after] = await Promise.all([this.readTreeAt(repo, base), this.readTreeAt(repo, commit)]);
    const earlier = new Map(before.files.map((file) => [file.path, file.oid]));
    return after.files
      .filter((file) => isSecretFilePath(file.path) && earlier.get(file.path) !== file.oid)
      .map((file) => file.path);
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

  /** The repository's refs by full name (`refs/heads/main`), as git reads them. */
  async refs(repo: string): Promise<Map<string, string>> {
    const remote = await this.#pushRemote(repo);
    try {
      return await readRemoteRefs(this.#fetch, remote);
    } finally {
      await this.#revokePushToken(repo, remote);
    }
  }

  /**
   * Points main at `to`, which the repository already holds, only from `from`: if main moved since `from` was read,
   * the repository refuses it, and why is answered (null when main moved). `to` need not add to main's history.
   */
  async replaceMain(repo: string, update: { from: string; to: string }): Promise<string | null> {
    const remote = await this.#pushRemote(repo);
    try {
      const pack = await packObjects(await objectStore(), []);
      const result = await updateRemoteRef(
        this.#fetch,
        remote,
        { ref: MAIN_REF, oldOid: update.from, newOid: update.to },
        pack,
      );
      return result.ok ? null : result.reason;
    } finally {
      await this.#revokePushToken(repo, remote);
    }
  }

  /** Deletes every ref under `prefix/` (a deleted workspace's saved branches); a repository already gone has none. */
  async deleteRefs(repo: string, prefix: string): Promise<void> {
    if (!(await this.exists(repo))) {
      return;
    }
    const remote = await this.#pushRemote(repo);
    try {
      for (const [ref, oid] of await readRemoteRefs(this.#fetch, remote)) {
        if (!ref.startsWith(`${prefix}/`)) {
          continue;
        }
        // Only deletes: git sends no pack with them.
        const result = await updateRemoteRef(
          this.#fetch,
          remote,
          { ref, oldOid: oid, newOid: ZERO_OID },
          new Uint8Array(),
        );
        if (!result.ok) {
          throw new Error(`The repository refused to delete ${ref} (${result.reason}).`);
        }
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

  /**
   * A read-only token for git over HTTPS, and the repository's remote: for another repository to import this one's
   * history, so it lasts as long as one import may take, and whoever asked revokes it once the import is done. It
   * reads every ref (Artifacts scopes a token to a repository, not to refs); an import fetches one branch.
   */
  async readAccess(repo: string): Promise<RepositoryReadAccess> {
    return this.#withRepo(repo, async (handle) => {
      const [info, token] = await Promise.all([handle.info(), handle.createToken('read', IMPORT_TOKEN_TTL_SECONDS)]);
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
   * Imports a repository from elsewhere with its branch's whole history, that branch becoming main of
   * `repo`: the source's pack is streamed from it into the repository's push as it arrives (see
   * `repository-source.ts`), so no size of repository is held in memory. `authorization` is the control
   * plane's short-lived, read-only credential for a private one, sent only as a header. The repository
   * checks the pack whole before main exists, so an import cut off partway leaves it empty, and an empty
   * one is imported again. An import already made (another member's, or a retry) is reused. Returns main's
   * head.
   */
  async importFromUrl(args: {
    url: string;
    authorization?: string | null;
    branch: string;
    repo: string;
  }): Promise<{ commit: string }> {
    if (!(await this.#holdsHistory(args.repo))) {
      try {
        await this.#copyHistory({ ...args, authorization: args.authorization ?? null });
      } catch (error) {
        throw error instanceof GitSourceError ? importError(error, Boolean(args.authorization)) : error;
      }
    }
    const main = await this.resolve(args.repo, MAIN_BRANCH);
    if (!main) {
      throw new ProjectRepositoryError('The imported repository has no commits.', 'not_found');
    }
    return { commit: main.hash };
  }

  /** Streams the source branch's history into `repo` as main, which must not be there yet. */
  async #copyHistory(args: { url: string; authorization: string | null; branch: string; repo: string }): Promise<void> {
    const source: GitSource = { url: args.url, authorization: args.authorization };
    const head = await readSourceBranch(this.#fetch, source, args.branch);
    const remote = await this.#pushRemote(args.repo, IMPORT_TOKEN_TTL_SECONDS);
    try {
      const { refs, capabilities } = await readRemoteAdvertisement(this.#fetch, remote);
      const pack = await fetchSourcePack(this.#fetch, source, head, {
        ofsDelta: capabilities.has('ofs-delta'),
        maxBytes: IMPORT_MAX_PACK_BYTES,
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      let result: Awaited<ReturnType<typeof updateRemoteRef>>;
      try {
        result = await updateRemoteRef(
          this.#fetch,
          remote,
          { ref: MAIN_REF, oldOid: refs.get(MAIN_REF) ?? ZERO_OID, newOid: head },
          pack.stream,
          { timeoutMs: IMPORT_TIMEOUT_MS },
        );
      } catch (error) {
        // The push broke because the source did: its reason is the one to give.
        throw pack.failure() ?? error;
      }
      const failure = pack.failure();
      if (failure) {
        throw failure;
      }
      // Another member's import of the same project that got there first is as good as this one.
      if (!result.ok && !(await this.#holdsHistory(args.repo))) {
        // Git's own reason is for the logs; the person gets words.
        console.warn({ event: 'project_import_refused', reason: result.reason.slice(0, 200) });
        // Only a server error may pass on its own; any other refusal comes back the same, so it isn't retried.
        const passing = /^HTTP 5\d\d\b/.test(result.reason);
        throw new ProjectRepositoryError(
          passing
            ? "Cloudflare did not accept the copied history just now, so the code wasn't copied. Try again."
            : "Cloudflare did not accept the copied history, so the code wasn't copied.",
          passing ? 'unavailable' : 'refused',
        );
      }
    } finally {
      await this.#revokePushToken(args.repo, remote);
    }
  }

  /**
   * The repository's remote with a token for one git request from the workspace's git proxy: `write` for a
   * push, `read` otherwise. The repository is made (empty, `main`) when there is none yet; the caller revokes
   * the token once the request is done.
   */
  async gitAccess(repo: string, scope: 'read' | 'write'): Promise<GitRemote & { tokenId: string }> {
    return this.#pushRemote(repo, PUSH_TOKEN_TTL_SECONDS, scope);
  }

  /** The repository's remote with a write token for one push, which `#revokePushToken` ends once it is done. */
  async #pushRemote(
    repo: string,
    ttlSeconds = PUSH_TOKEN_TTL_SECONDS,
    scope: 'read' | 'write' = 'write',
  ): Promise<GitRemote & { tokenId: string }> {
    const { remote } = await this.ensureRepo(repo);
    const token = await this.#withRepo(repo, (handle) => handle.createToken(scope, ttlSeconds));
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

  /** Whether the repository exists and has at least one commit. */
  async #holdsHistory(name: string): Promise<boolean> {
    if (!(await this.exists(name))) {
      return false;
    }
    return this.#withRepo(name, async (handle) => (await handle.log({ limit: 1 })).length > 0);
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

/** Why an import could not read its source, in words for the person importing. */
function importError(error: GitSourceError, authorized: boolean): ProjectRepositoryError {
  switch (error.reason) {
    case 'auth_required':
      return new ProjectRepositoryError(
        authorized
          ? `GitHub refused CloudChef access to that repository. To fix it, ${GITHUB_ACCESS_FIX}, then try again.`
          : // Imported as a public repository the App doesn't reach: GitHub says the same for one removed since.
            "That repository wasn't found: it was removed, or it isn't public any more. If it's private now, " +
              `${GITHUB_ACCESS_FIX}, then open the project again.`,
        'auth_required',
      );
    case 'no_repository':
      // GitHub answers a private repository it isn't shown as not found.
      return new ProjectRepositoryError(
        authorized
          ? `The repository could not be imported: ${error.message}.`
          : "That repository wasn't found: it was removed, or it isn't public any more. If it's private now, " +
              `${GITHUB_ACCESS_FIX}, then open the project again.`,
        'not_found',
      );
    case 'not_found':
      return new ProjectRepositoryError(`The repository could not be imported: ${error.message}.`, 'not_found');
    case 'refused':
      return new ProjectRepositoryError(`The repository could not be imported: ${error.message}.`, 'refused');
    case 'too_large':
      return new ProjectRepositoryError(
        `That repository's history is larger than a project may hold (${IMPORT_MAX_PACK_BYTES / 1024 / 1024 / 1024} GB).`,
        'too_large',
      );
    default:
      return new ProjectRepositoryError(
        `The repository could not be imported: ${error.message}. Try again.`,
        'unavailable',
      );
  }
}

/** `.env`, `.env.*`, `.dev.vars` and `.dev.vars.*` at any depth, except the example files projects keep. */
function isSecretFilePath(path: string): boolean {
  return /(^|\/)(\.env|\.dev\.vars)(\.[^/]*)?$/.test(path) && !/(^|\/)\.env\.(example|sample|template)$/.test(path);
}
