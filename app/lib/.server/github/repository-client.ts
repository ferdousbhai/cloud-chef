import { z } from 'zod';
import { callGitHub, fetchGitHub, GitHubError } from './github-api';

const refSchema = z.looseObject({ object: z.looseObject({ sha: z.string() }) });
const commitSchema = z.looseObject({ sha: z.string(), tree: z.looseObject({ sha: z.string() }) });
const shaSchema = z.looseObject({ sha: z.string() });
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

/** What a repository's pipeline reported for a commit, read from its check runs. */
type BuildStatus = {
  state: 'pending' | 'success' | 'failure' | 'none';
  /** The first workers.dev or https link a check run reported: Workers Builds' preview, typically. */
  previewUrl: string | null;
  detailsUrl: string | null;
};

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
   * the branch when it doesn't exist). Returns the new commit.
   */
  async commit(args: {
    branch: string;
    parent: string;
    baseTree: string;
    message: string;
    changes: CommitChange[];
    branchExists: boolean;
  }): Promise<string> {
    const tree = [];
    for (const change of args.changes) {
      const mode = change.executable ? '100755' : '100644';
      if (change.contentBase64 === null) {
        tree.push({ path: change.path, mode, type: 'blob', sha: null });
        continue;
      }
      const blob = await this.call('/git/blobs', shaSchema, {
        method: 'POST',
        body: JSON.stringify({ content: change.contentBase64, encoding: 'base64' }),
      });
      tree.push({ path: change.path, mode, type: 'blob', sha: blob.sha });
    }
    const createdTree = await this.call('/git/trees', shaSchema, {
      method: 'POST',
      body: JSON.stringify({ base_tree: args.baseTree, tree }),
    });
    const commit = await this.call('/git/commits', shaSchema, {
      method: 'POST',
      body: JSON.stringify({ message: args.message, tree: createdTree.sha, parents: [args.parent] }),
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

  /** What the repository's pipeline (Workers Builds, typically) has reported for a commit so far. */
  async buildStatus(sha: string): Promise<BuildStatus> {
    const { check_runs: runs } = await this.call(`/commits/${sha}/check-runs?per_page=50`, checkRunsSchema);
    if (runs.length === 0) {
      return { state: 'none', previewUrl: null, detailsUrl: null };
    }
    const pending = runs.some((run) => run.status !== 'completed');
    const failed = runs.some((run) => run.conclusion === 'failure' || run.conclusion === 'timed_out');
    const text = runs.map((run) => `${run.output.title ?? ''}\n${run.output.summary ?? ''}`).join('\n');
    return {
      state: failed ? 'failure' : pending ? 'pending' : 'success',
      previewUrl: /https:\/\/[^\s)"'<>\]]+\.workers\.dev[^\s)"'<>\]]*/.exec(text)?.[0] ?? null,
      detailsUrl: runs.find((run) => run.details_url)?.details_url ?? null,
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
