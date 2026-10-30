import { z } from 'zod';
import { base64ToBytes, bytesToBase64 } from '~/lib/hex-digest';
import type { RuntimeConnectionIdentity } from './cloudflare-api-runtime-identity';
import { MAIN_BRANCH, ProjectRepositoryError, type ProjectRepositories } from './project-repository';
import { sharedProjectRequest } from './user-workspace-cloudflare-credential';

/**
 * A project shared with someone whose workspace runs in another Cloudflare account than the project's. Their runtime
 * has no binding to the project's Artifacts and is never given a token for it: everything it reads or pushes goes to
 * the control plane (`runtime-shared/<project>/<op>`), which checks their role on each request and sends it on to a
 * runtime in the project's account, which answers it from its own Artifacts binding and applies every push check
 * there (`handleSharedProjectRequest` in the runtime). The token never leaves the project's account.
 *
 * The reads are the few a workspace needs besides git: main's commit, one commit, main's history, a commit's files
 * (to seed the workspace or restore a version), and a ZIP of a commit.
 */
const SHARED_READS = ['head', 'resolve', 'log', 'files', 'archive'] as const;
export type SharedRead = (typeof SHARED_READS)[number];
/** git's three requests, under `git/`. */
const SHARED_GIT = ['git/info/refs', 'git/git-upload-pack', 'git/git-receive-pack'] as const;
export type SharedOp = SharedRead | (typeof SHARED_GIT)[number];

const SHARED_OPS: ReadonlySet<string> = new Set([...SHARED_READS, ...SHARED_GIT]);
const SHARED_READ_OPS: ReadonlySet<string> = new Set(SHARED_READS);

export function isSharedOp(op: string): op is SharedOp {
  return SHARED_OPS.has(op);
}

export function isSharedRead(op: string): op is SharedRead {
  return SHARED_READ_OPS.has(op);
}

/** Whether a request changes the repository: a push, or git asking what a push may send. */
export function sharedOpWrites(op: SharedOp, search: URLSearchParams): boolean {
  return op === 'git/git-receive-pack' || (op === 'git/info/refs' && search.get('service') === 'git-receive-pack');
}

/** The header naming the workspace whose saved branches a forwarded git request may see and write. */
export const SHARED_WORKSPACE_HEADER = 'x-cloudchef-workspace';
const WORKSPACE = /^[A-Za-z0-9_-]{1,128}$/;

/** A workspace name as the header may carry it, or null. */
export function sharedWorkspaceName(value: string | null): string | null {
  return value && WORKSPACE.test(value) ? value : null;
}

/**
 * The folder under `refs/cloudchef/workspaces/` where a shared workspace keeps its branches in the project's
 * repository: under the person's own id, which the control plane vouches for, so no one reaches another's.
 */
export function sharedWorkspaceRefsId(userId: string, workspace: string): string {
  return `shared-${userId.replace(/[^A-Za-z0-9_-]/g, '_')}-${workspace}`;
}

/**
 * The capability subject the control plane signs for a runtime in the project's account to answer a request of
 * someone it is shared with: the project, their role and who they are. Only the control plane mints one.
 */
export function sharedCapabilitySubject(args: { projectId: string; role: 'view' | 'edit'; userId: string }): string {
  return `shared/${args.projectId}/${args.role}/${args.userId}`;
}

export function readSharedCapabilitySubject(
  subject: string,
): { projectId: string; role: 'view' | 'edit'; userId: string } | null {
  const match = /^shared\/([0-9a-f-]{36})\/(view|edit)\/(.{1,128})$/.exec(subject);
  return match ? { projectId: match[1]!, role: match[2] === 'edit' ? 'edit' : 'view', userId: match[3]! } : null;
}

const REF = /^(main|[0-9a-f]{40})$/;

type ReadableRepositories = Pick<ProjectRepositories, 'head' | 'resolve' | 'log' | 'streamFilesAt' | 'archiveZip'>;

/**
 * The project's account answering a read for someone it is shared with, from its own repository `repo`. `keep` is
 * what a workspace takes of a commit's files (never installed or built output).
 */
export async function answerSharedRead(
  repositories: ReadableRepositories,
  repo: string,
  op: SharedRead,
  search: URLSearchParams,
  keep: (path: string) => boolean,
): Promise<Response> {
  const ref = search.get('ref') ?? MAIN_BRANCH;
  if (!REF.test(ref)) {
    return Response.json({ error: 'Name main or a commit.' }, { status: 400 });
  }
  try {
    switch (op) {
      case 'head':
        return Response.json({ commit: await repositories.head(repo, MAIN_BRANCH) });
      case 'resolve':
        return Response.json({ commit: await repositories.resolve(repo, ref) });
      case 'log': {
        const limit = Math.min(Math.max(Number.parseInt(search.get('limit') ?? '50', 10) || 50, 1), 200);
        const offset = Math.max(Number.parseInt(search.get('offset') ?? '0', 10) || 0, 0);
        return Response.json({ commits: await repositories.log(repo, { ref: MAIN_BRANCH, limit, offset }) });
      }
      case 'files': {
        const { commit, files } = await repositories.streamFilesAt(repo, ref, keep);
        const encoder = new TextEncoder();
        // A line for the commit, then one per file: read a file at a time, so a project never sits in memory whole.
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ commit })}\n`));
          },
          async pull(controller) {
            try {
              const next = await files.next();
              if (next.done) {
                controller.close();
                return;
              }
              const { path, mode, oid, bytes } = next.value;
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ path, mode, oid, content: bytesToBase64(bytes) })}\n`),
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : 'The project could not be read.';
              controller.enqueue(encoder.encode(`${JSON.stringify({ error: message })}\n`));
              controller.close();
            }
          },
        });
        return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
      }
      case 'archive': {
        const folder = (search.get('folder') ?? 'project').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'project';
        const { stream } = await repositories.archiveZip(repo, ref, folder);
        return new Response(stream, { headers: { 'content-type': 'application/zip' } });
      }
    }
  } catch (error) {
    if (error instanceof ProjectRepositoryError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'too_large' ? 413 : 503;
      return Response.json({ error: error.message, code: error.code }, { status });
    }
    throw error;
  }
}

type SharedEnv = Pick<Env, 'CLOUDCHEF_CONTROL_PLANE_ENDPOINT' | 'CONTROL_PLANE_SECRET'>;
type Identity = Pick<RuntimeConnectionIdentity, 'userId' | 'connectionId' | 'connectionGeneration'>;

const commitSchema = z.object({
  hash: z.string(),
  treeHash: z.string(),
  message: z.string(),
  author: z.object({ name: z.string(), email: z.string() }),
  committedAt: z.number(),
  parents: z.array(z.string()),
});
const fileLineSchema = z.object({ path: z.string(), mode: z.string(), oid: z.string(), content: z.string() });
const MAX_JSON_BYTES = 4 * 1024 * 1024;

/**
 * A shared project's repository as its workspace reads it, through the control plane: the reads of
 * `ProjectRepositories` a workspace makes, for one project, whatever repository name the caller passes.
 */
export class SharedProjectRepositories {
  readonly #env: SharedEnv;
  readonly #identity: Identity;
  readonly #orgProjectId: string;

  constructor(env: SharedEnv, identity: Identity, orgProjectId: string) {
    this.#env = env;
    this.#identity = identity;
    this.#orgProjectId = orgProjectId;
  }

  async head(_repo: string, branch: string = MAIN_BRANCH): Promise<string | null> {
    if (branch !== MAIN_BRANCH) {
      throw new ProjectRepositoryError('Only main is read for a shared project.', 'refused');
    }
    return (await this.#json('head', new URLSearchParams(), z.object({ commit: z.string().nullable() }))).commit;
  }

  async resolve(_repo: string, ref: string) {
    return (await this.#json('resolve', new URLSearchParams({ ref }), z.object({ commit: commitSchema.nullable() })))
      .commit;
  }

  async log(_repo: string, options: { ref?: string; limit: number; offset?: number }) {
    const search = new URLSearchParams({ limit: String(options.limit), offset: String(options.offset ?? 0) });
    return (await this.#json('log', search, z.object({ commits: z.array(commitSchema) }))).commits;
  }

  /** A commit's files, as `ProjectRepositories.streamFilesAt` gives them; `keep` is applied again here. */
  async streamFilesAt(_repo: string, ref: string, keep: (path: string) => boolean = () => true) {
    const response = await this.#request('files', new URLSearchParams({ ref }));
    if (!response.body) {
      throw new ProjectRepositoryError('The project could not be read.', 'unavailable');
    }
    const lines = ndjsonLines(response.body);
    const first = await lines.next();
    const head = first.done ? null : z.object({ commit: commitSchema }).safeParse(JSON.parse(first.value));
    if (!head?.success) {
      throw new ProjectRepositoryError('The project could not be read.', 'unavailable');
    }
    async function* files() {
      for await (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        const failed = z.object({ error: z.string() }).safeParse(parsed);
        if (failed.success) {
          throw new ProjectRepositoryError(failed.data.error, 'unavailable');
        }
        const file = fileLineSchema.parse(parsed);
        if (keep(file.path)) {
          yield { path: file.path, mode: file.mode, oid: file.oid, bytes: base64ToBytes(file.content) };
        }
      }
    }
    return { commit: head.data.commit, files: files() };
  }

  async readFilesAt(repo: string, ref: string, keep: (path: string) => boolean = () => true) {
    const { commit, files } = await this.streamFilesAt(repo, ref, keep);
    const read = [];
    for await (const file of files) {
      read.push(file);
    }
    return { commit, files: read };
  }

  async archiveZip(_repo: string, ref: string, folder: string) {
    const commit = await this.resolve(_repo, ref);
    if (!commit) {
      throw new ProjectRepositoryError('That version is not in the project.', 'not_found');
    }
    const response = await this.#request('archive', new URLSearchParams({ ref: commit.hash, folder }));
    if (!response.body) {
      throw new ProjectRepositoryError('The project could not be downloaded.', 'unavailable');
    }
    return { commit, stream: response.body };
  }

  async #json<T>(op: SharedRead, search: URLSearchParams, schema: z.ZodType<T>): Promise<T> {
    const response = await this.#request(op, search);
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) {
      throw new ProjectRepositoryError('The project’s answer was too large.', 'unavailable');
    }
    return schema.parse(JSON.parse(text));
  }

  async #request(op: SharedRead, search: URLSearchParams): Promise<Response> {
    const response = await sharedProjectRequest(this.#env, this.#identity, this.#orgProjectId, op, {
      search: `?${search.toString()}`,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.ok) {
      return response;
    }
    const message = await response
      .json()
      .then((body) => z.object({ error: z.string() }).parse(body).error)
      .catch(() => 'The project could not be read just now. Try again.');
    throw new ProjectRepositoryError(
      message,
      response.status === 404
        ? 'not_found'
        : response.status === 413
          ? 'too_large'
          : response.status === 401 || response.status === 403
            ? 'refused'
            : 'unavailable',
    );
  }
}

/** The lines of a newline-separated stream, each whole. */
async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) {
        yield line;
      }
      newline = buffered.indexOf('\n');
    }
    if (done) {
      if (buffered) {
        yield buffered;
      }
      return;
    }
  }
}
