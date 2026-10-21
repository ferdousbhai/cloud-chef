import { z } from 'zod';
import { callGitHub, fetchGitHub, GitHubError } from './github-api';

const refSchema = z.looseObject({ object: z.looseObject({ sha: z.string() }) });
const commitSchema = z.looseObject({ sha: z.string(), tree: z.looseObject({ sha: z.string() }) });
const shaSchema = z.looseObject({ sha: z.string() });
const treeSchema = z.looseObject({ tree: z.array(z.looseObject({ path: z.string() })) });
const repositorySchema = z.looseObject({ homepage: z.string().nullable().optional() });
const checkRunsSchema = z.looseObject({
  check_runs: z.array(
    z.looseObject({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      details_url: z.string().nullable().optional(),
      output: z.looseObject({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() }),
      app: z.looseObject({ slug: z.string().optional() }).nullable().optional(),
    }),
  ),
});

/** One file in a commit: new or changed content, or `null` content to delete it. */
type CommitChange = { path: string; contentBase64: string | null; executable: boolean };

/** One entry of a tree request: a file's text inline, a blob already on GitHub, or `null` to delete it. */
type TreeEntry = { path: string; mode: '100644' | '100755'; type: 'blob' } & (
  { content: string } | { sha: string | null }
);

/**
 * The most GitHub requests one commit makes: a blob for each file that isn't text, its tree requests, the
 * commit, and its ref. A Worker has 1,000 subrequests, and the rest of an approval or publish needs some.
 */
const MAX_COMMIT_REQUESTS = 500;
/** Text up to this size goes in a tree request inline; anything larger is its own blob. */
const MAX_INLINE_FILE_BYTES = 1024 * 1024;
/** The most inline text one tree request carries: a larger commit is built over several, each on the last. */
const MAX_TREE_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * How a commit's changes reach GitHub: text inline in tree requests of at most `MAX_TREE_REQUEST_BYTES`,
 * and each other file (binary, or too large to inline) as a blob of its own, entered in the last tree.
 */
function commitPlan(changes: CommitChange[]) {
  const encoder = new TextEncoder();
  let current: TreeEntry[] = [];
  const trees = [current];
  const blobs: CommitChange[] = [];
  let size = 0;
  for (const change of changes) {
    const mode = change.executable ? '100755' : '100644';
    const text = change.contentBase64 === null ? null : inlineText(change.contentBase64);
    if (change.contentBase64 !== null && text === null) {
      blobs.push(change);
      continue;
    }
    const entry: TreeEntry =
      text === null
        ? { path: change.path, mode, type: 'blob', sha: null }
        : { path: change.path, mode, type: 'blob', content: text };
    const bytes = encoder.encode(JSON.stringify(entry)).length;
    if (current.length > 0 && size + bytes > MAX_TREE_REQUEST_BYTES) {
      current = [];
      trees.push(current);
      size = 0;
    }
    current.push(entry);
    size += bytes;
  }
  return { trees, blobs };
}

/**
 * Why committing `changes` would take more GitHub requests than `MAX_COMMIT_REQUESTS`, or null when it
 * wouldn't. Checked when a commit is asked for, so it is refused before anything is written to GitHub.
 */
export function commitSizeRefusal(changes: CommitChange[]): string | null {
  const { trees, blobs } = commitPlan(changes);
  return blobs.length + trees.length + 2 > MAX_COMMIT_REQUESTS
    ? `This holds ${blobs.length} files that aren't text (images, fonts, archives), are over 1 MB, or are empty, more than ` +
        'CloudChef can commit to GitHub at once. Slim them down and try again.'
    : null;
}

/**
 * A file's content as text for a tree request, or null when it isn't UTF-8 text exactly, is too large,
 * or is empty: GitHub may read blank inline content as missing, so an empty file is a blob of its own.
 */
function inlineText(contentBase64: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
    if (bytes.length === 0 || bytes.length > MAX_INLINE_FILE_BYTES || bytes.includes(0)) {
      return null;
    }
    // A byte-order mark is kept: the text must encode back to exactly these bytes.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    // Not base64 (GitHub refuses its blob), or not UTF-8.
    return null;
  }
}

/** What a repository's pipeline reported for a commit, read from its check runs. */
type BuildStatus = {
  state: 'pending' | 'success' | 'failure' | 'none';
  /** The first workers.dev link a check run reported: Workers Builds' preview, typically. */
  previewUrl: string | null;
  detailsUrl: string | null;
  /** A failed run's conclusion (`failure`, `cancelled`, `timed_out`, `action_required`, …). */
  conclusion: string | null;
  /**
   * Whether the status is Workers Builds' own check runs. Until its check exists, other checks (a CI
   * workflow, a linter app) are all there is, and their finishing says nothing about the deployment.
   */
  workersBuilds: boolean;
};

/** Check run conclusions that let a build stand; any other finished run (cancelled, stale, …) failed it. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Workers Builds reports as the Cloudflare Workers and Pages GitHub App, naming its runs "Workers
 * Builds: …". The app is what says a run is its: any app can name a run that way. GitHub names the app
 * of every check run, so the name is read only for a run it reports none for.
 */
function isWorkersBuildsRun(run: { name: string; app?: { slug?: string } | null }): boolean {
  const slug = run.app?.slug;
  return slug ? slug === 'cloudflare-workers-and-pages' : run.name.startsWith('Workers Builds');
}

/** The outcome of merging a branch into another. */
type MergeOutcome = { status: 'merged'; sha: string } | { status: 'up_to_date' } | { status: 'conflict' };

/**
 * One repository, through a token limited to it. GitHub stays the source of truth: CloudChef reads a
 * commit's files and writes commits with the Git Data API, never through a clone.
 */
export class RepositoryClient {
  constructor(
    private readonly token: string,
    readonly fullName: string,
    private readonly request: typeof fetch,
  ) {}

  /** The commit a branch points at, or null when the branch doesn't exist. */
  async branchHead(branch: string): Promise<string | null> {
    const response = await fetchGitHub(this.request, `${this.path}/git/ref/heads/${encodeRef(branch)}`, this.token);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new GitHubError(`GitHub refused the request (${response.status}).`, response.status);
    }
    return refSchema.parse(await response.json()).object.sha;
  }

  /** The tree a commit points at. */
  async commitTree(sha: string): Promise<string> {
    return (await this.call(`/git/commits/${sha}`, commitSchema)).tree.sha;
  }

  /** The paths at the top of a branch's tree. */
  async topLevelPaths(branch: string): Promise<string[]> {
    return (await this.call(`/git/trees/${encodeRef(branch)}`, treeSchema)).tree.map((entry) => entry.path);
  }

  /** The gzipped tarball of a commit's files, as a stream. */
  async tarball(sha: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const response = await fetchGitHub(this.request, `${this.path}/tarball/${sha}`, this.token);
    if (!response.ok || !response.body) {
      throw new GitHubError(`GitHub refused the download (${response.status}).`, response.status);
    }
    return response.body;
  }

  /**
   * Commits `changes` on top of `baseTree` as a child of `parent`, and points `branch` at it (creating
   * the branch when it doesn't exist). Returns the new commit. Text goes inline in the tree requests, so
   * only other files take a request each (see `commitPlan`).
   */
  async commit(args: {
    branch: string;
    parent: string;
    baseTree: string;
    message: string;
    changes: CommitChange[];
    branchExists: boolean;
  }): Promise<string> {
    const { trees, blobs } = commitPlan(args.changes);
    const blobEntries: TreeEntry[] = [];
    for (const change of blobs) {
      const blob = await this.call('/git/blobs', shaSchema, {
        method: 'POST',
        body: JSON.stringify({ content: change.contentBase64, encoding: 'base64' }),
      });
      blobEntries.push({
        path: change.path,
        mode: change.executable ? '100755' : '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }
    // Each tree is made on the one before, so the last holds every change.
    let tree = args.baseTree;
    for (const [index, inline] of trees.entries()) {
      const entries = index === trees.length - 1 ? [...inline, ...blobEntries] : inline;
      tree = (
        await this.call('/git/trees', shaSchema, {
          method: 'POST',
          body: JSON.stringify({ base_tree: tree, tree: entries }),
        })
      ).sha;
    }
    const commit = await this.call('/git/commits', shaSchema, {
      method: 'POST',
      body: JSON.stringify({ message: args.message, tree, parents: [args.parent] }),
    });
    await (args.branchExists
      ? this.call(`/git/refs/heads/${encodeRef(args.branch)}`, shaSchema.or(refSchema), {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit.sha, force: true }),
        })
      : this.call('/git/refs', refSchema, {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: commit.sha }),
        }));
    return commit.sha;
  }

  /** How many commits a branch has, counting up to `limit`. */
  async commitCount(branch: string, limit = 2): Promise<number> {
    const commits = await this.call(
      `/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`,
      z.array(z.looseObject({ sha: z.string() })),
    );
    return commits.length;
  }

  /** Merges `head` into `base` on GitHub. */
  async merge(base: string, head: string, message: string): Promise<MergeOutcome> {
    const response = await fetchGitHub(this.request, `${this.path}/merges`, this.token, {
      method: 'POST',
      body: JSON.stringify({ base, head, commit_message: message }),
    });
    if (response.status === 204) {
      return { status: 'up_to_date' };
    }
    if (response.status === 409) {
      return { status: 'conflict' };
    }
    if (!response.ok) {
      throw new GitHubError(`GitHub refused the merge (${response.status}).`, response.status);
    }
    return { status: 'merged', sha: shaSchema.parse(await response.json()).sha };
  }

  /** The website its admins set in the repository's About settings, or null. */
  async homepage(): Promise<string | null> {
    return (await this.call('', repositorySchema)).homepage ?? null;
  }

  /** What the repository's pipeline (Workers Builds, typically) has reported for a commit so far. */
  async buildStatus(sha: string): Promise<BuildStatus> {
    const { check_runs: all } = await this.call(`/commits/${sha}/check-runs?per_page=50`, checkRunsSchema);
    // Workers Builds' runs decide when it has them; a repository without it is judged by all its checks.
    const pipeline = all.filter(isWorkersBuildsRun);
    const runs = pipeline.length > 0 ? pipeline : all;
    if (runs.length === 0) {
      return { state: 'none', previewUrl: null, detailsUrl: null, conclusion: null, workersBuilds: false };
    }
    const pending = runs.some((run) => run.status !== 'completed');
    const failed = runs.find(
      (run) => run.status === 'completed' && !PASSING_CONCLUSIONS.has(run.conclusion ?? 'unknown'),
    );
    const text = runs.map((run) => `${run.output.title ?? ''}\n${run.output.summary ?? ''}`).join('\n');
    return {
      state: failed ? 'failure' : pending ? 'pending' : 'success',
      previewUrl: /https:\/\/[^\s)"'<>\]]+\.workers\.dev[^\s)"'<>\]]*/.exec(text)?.[0] ?? null,
      detailsUrl: (failed?.details_url ? failed : runs.find((run) => run.details_url))?.details_url ?? null,
      conclusion: failed ? (failed.conclusion ?? 'unknown') : null,
      workersBuilds: pipeline.length > 0,
    };
  }

  private get path(): string {
    return `/repos/${this.fullName}`;
  }

  private call<T>(path: string, schema: z.ZodType<T>, init: { method?: string; body?: string } = {}): Promise<T> {
    return callGitHub(this.request, `${this.path}${path}`, this.token, schema, init);
  }
}

function encodeRef(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}
