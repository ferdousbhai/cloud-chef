import { createCollection, type SyncConfig } from '@tanstack/db';
import { z } from 'zod';
import { WORK_DIR } from 'cloudchef-agent/constants';
import type {
  BuilderWorkspaceEncoding,
  BuilderWorkspaceSyncEntry,
  BuilderWorkspaceSyncPage,
} from '@cloudchef/user-workspace-runtime/protocol';

const WORKSPACE_RPC_TIMEOUT_MS = 30_000;
const MAX_SYNC_RESTARTS = 3;

const revisionSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();
const workspacePathSchema = z
  .string()
  .min(WORK_DIR.length + 2)
  .max(1_024)
  .refine(isCanonicalWorkspacePath, `Path must be a canonical file path under ${WORK_DIR}.`);
const workspaceFileFields = {
  path: workspacePathSchema,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  size: countSchema,
  sha256: z.string(),
  revision: revisionSchema,
};

type BuilderWorkspaceFileRecord = {
  path: string;
  content: string;
  encoding: BuilderWorkspaceEncoding;
  size: number;
  sha256: string;
  revision: number;
};

const workspaceFileSchema = z.object(workspaceFileFields).strict() satisfies z.ZodType<BuilderWorkspaceFileRecord>;

const workspaceStateSchema = z
  .object({
    initialized: z.boolean(),
    revision: revisionSchema,
    resetRevision: revisionSchema,
    fileCount: countSchema,
    totalBytes: countSchema,
    seeding: z.boolean(),
  })
  .strict();
const workspaceSyncEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('write'),
      ...workspaceFileFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal('delete'),
      path: workspacePathSchema,
      revision: revisionSchema,
    })
    .strict(),
]);
const workspaceSyncPageSchema = z
  .object({
    state: workspaceStateSchema,
    fromRevision: revisionSchema,
    targetRevision: revisionSchema,
    mode: z.enum(['current', 'snapshot', 'delta']),
    entries: z.array(workspaceSyncEntrySchema),
    nextCursor: z.string().min(1).optional(),
    restart: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<BuilderWorkspaceSyncPage>;

/** The `getWorkspaceSyncPage` argument as this client sends it over the untyped agent RPC. */
type WorkspaceSyncPageRequest = {
  fromRevision: number;
  targetRevision?: number;
  cursor?: string;
};

export type BuilderWorkspaceAgent = {
  call(method: string, args: unknown[], options?: { timeout?: number }): Promise<unknown>;
};

/** A workspace RPC to the builder agent, which answers within the workspace timeout or fails. */
export async function callWorkspaceAgent<T>(agent: BuilderWorkspaceAgent, method: string, args: unknown[]): Promise<T> {
  // SAFETY: the agent's RPC is untyped; each caller names the result its workspace method returns.
  return (await agent.call(method, args, { timeout: WORKSPACE_RPC_TIMEOUT_MS })) as T;
}

type WorkspaceSyncParams = Parameters<SyncConfig<BuilderWorkspaceFileRecord, string>['sync']>[0];

export type BuilderWorkspacePullResult = {
  mode: 'current' | 'snapshot' | 'delta';
  entries: BuilderWorkspaceSyncEntry[];
  revision: number;
};

/**
 * Bridges the authoritative BuilderAgent revision protocol into an in-memory
 * TanStack DB presentation collection.
 */
class BuilderWorkspaceCollectionSource {
  #params: WorkspaceSyncParams | null = null;
  #disposed = false;
  #revision = 0;
  readonly #started = deferred<void>();
  readonly #initialPull = deferred<BuilderWorkspacePullResult>();

  constructor(private readonly agent: BuilderWorkspaceAgent) {}

  readonly sync: SyncConfig<BuilderWorkspaceFileRecord, string> = {
    rowUpdateMode: 'full',
    sync: (params) => {
      this.#params = params;
      this.#revision = 0;
      this.#started.resolve();
      params.markReady();
      void this.#pullFromRevision(0, true).then(this.#initialPull.resolve, this.#initialPull.reject);

      return () => {
        this.#disposed = true;
        this.#params = null;
      };
    },
  };

  get initialPull(): Promise<BuilderWorkspacePullResult> {
    return this.#initialPull.promise;
  }

  async pull(): Promise<BuilderWorkspacePullResult> {
    await this.#started.promise;
    return this.#pullFromRevision(this.#revision);
  }

  async replaceFromSnapshot(): Promise<BuilderWorkspacePullResult> {
    await this.#started.promise;
    return this.#pullFromRevision(0, true);
  }

  async #pullFromRevision(initialFromRevision: number, requireSnapshot = false): Promise<BuilderWorkspacePullResult> {
    let fromRevision = initialFromRevision;
    let restartCount = 0;
    while (true) {
      let cursor: string | undefined;
      let targetRevision: number | undefined;
      let mode: BuilderWorkspacePullResult['mode'] | undefined;
      let expectedState: BuilderWorkspaceSyncPage['state'] | undefined;
      const entries: BuilderWorkspaceSyncEntry[] = [];
      const paths = new Set<string>();
      let restart = false;

      do {
        const request: WorkspaceSyncPageRequest = { fromRevision };
        if (targetRevision !== undefined) {
          request.targetRevision = targetRevision;
        }
        if (cursor) {
          request.cursor = cursor;
        }
        const page = parseSyncPage(await callWorkspaceAgent(this.agent, 'getWorkspaceSyncPage', [request]));
        if (page.fromRevision !== fromRevision) {
          throw syncProtocolError('the response fromRevision does not match the request');
        }
        if (page.state.revision !== page.targetRevision) {
          throw syncProtocolError('the workspace state revision does not match the target revision');
        }
        if (!page.state.initialized) {
          throw new Error('The durable project workspace is not initialized.');
        }
        if (page.restart) {
          if (page.mode !== 'snapshot' || page.entries.length > 0 || page.nextCursor) {
            throw syncProtocolError('a restart response must be an empty snapshot page');
          }
          restartCount += 1;
          if (restartCount > MAX_SYNC_RESTARTS) {
            throw syncProtocolError('too many revision restarts');
          }
          fromRevision = 0;
          requireSnapshot = true;
          restart = true;
          break;
        }
        if (targetRevision === undefined) {
          targetRevision = page.targetRevision;
          mode = page.mode;
          expectedState = page.state;
        } else {
          if (page.targetRevision !== targetRevision) {
            throw syncProtocolError('the target revision changed between pages');
          }
          if (page.mode !== mode) {
            throw syncProtocolError('the sync mode changed between pages');
          }
          if (!sameWorkspaceState(page.state, expectedState!)) {
            throw syncProtocolError('the workspace state changed between pages');
          }
        }
        if (
          page.mode === 'current' &&
          (page.targetRevision !== fromRevision || page.entries.length > 0 || page.nextCursor)
        ) {
          throw syncProtocolError('a current response must be an empty, complete page at the requested revision');
        }
        for (const entry of page.entries) {
          if (entry.revision !== page.targetRevision) {
            throw syncProtocolError('an entry revision does not match the target revision');
          }
          if (page.mode === 'snapshot' && entry.kind !== 'write') {
            throw syncProtocolError('a snapshot cannot contain delete entries');
          }
          if (paths.has(entry.path)) {
            throw syncProtocolError(`duplicate entry path: ${entry.path}`);
          }
          paths.add(entry.path);
        }
        entries.push(...page.entries);
        cursor = page.nextCursor;
      } while (cursor);

      if (restart) {
        continue;
      }
      if (targetRevision === undefined || mode === undefined || expectedState === undefined) {
        throw new Error('The durable workspace sync did not return a target revision.');
      }
      if (requireSnapshot && mode !== 'snapshot' && !(mode === 'current' && targetRevision === 0)) {
        throw syncProtocolError('an authoritative snapshot was required');
      }
      if (this.#disposed || !this.#params) {
        throw new Error('The durable workspace connection was closed.');
      }
      if (mode === 'current') {
        const localState = workspaceFileTotals(this.#params.collection.toArray, targetRevision);
        if (
          !localState ||
          localState.fileCount !== expectedState.fileCount ||
          localState.totalBytes !== expectedState.totalBytes
        ) {
          if (fromRevision !== 0) {
            fromRevision = 0;
            requireSnapshot = true;
            continue;
          }
          requireSnapshot = true;
        }
      }

      const committedMode = requireSnapshot ? 'snapshot' : mode;
      this.#commit(this.#params, committedMode, entries);
      this.#revision = targetRevision;
      return { mode: committedMode, entries, revision: targetRevision };
    }
  }

  #commit(
    params: WorkspaceSyncParams,
    mode: BuilderWorkspacePullResult['mode'],
    entries: BuilderWorkspaceSyncEntry[],
  ): void {
    params.begin({ immediate: true });
    if (mode === 'snapshot') {
      params.truncate();
    }
    for (const entry of entries) {
      if (entry.kind === 'delete') {
        params.write({ type: 'delete', key: entry.path });
      } else {
        params.write({
          type: 'update',
          value: {
            path: entry.path,
            content: entry.content,
            encoding: entry.encoding,
            size: entry.size,
            sha256: entry.sha256,
            revision: entry.revision,
          },
        });
      }
    }
    params.commit();
  }
}

export type BuilderWorkspaceCollection = ReturnType<typeof createBuilderWorkspaceCollection>['collection'];

export function createBuilderWorkspaceCollection(args: { agent: BuilderWorkspaceAgent; workspaceId: string }) {
  const source = new BuilderWorkspaceCollectionSource(args.agent);
  const options = {
    id: `builder-workspace:${args.workspaceId}`,
    schema: workspaceFileSchema,
    getKey: (file: BuilderWorkspaceFileRecord) => file.path,
    sync: source.sync,
  };
  const collection = createCollection(options);
  return { collection, source };
}

export function workspaceCollectionSnapshot(collection: BuilderWorkspaceCollection): BuilderWorkspaceSyncEntry[] {
  return collection.toArray
    .map((file): BuilderWorkspaceSyncEntry => ({
      kind: 'write',
      path: file.path,
      content: file.content,
      encoding: file.encoding,
      size: file.size,
      sha256: file.sha256,
      revision: file.revision,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function isCanonicalWorkspacePath(path: string): boolean {
  return (
    path.startsWith(`${WORK_DIR}/`) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.includes('//') &&
    !path.endsWith('/') &&
    !path.split('/').some((part) => part === '.' || part === '..')
  );
}

function parseSyncPage(value: unknown): BuilderWorkspaceSyncPage {
  const parsed = workspaceSyncPageSchema.safeParse(value);
  if (!parsed.success) {
    throw syncProtocolError(parsed.error.issues[0]?.message ?? 'invalid page');
  }
  return parsed.data;
}

function sameWorkspaceState(
  left: BuilderWorkspaceSyncPage['state'],
  right: BuilderWorkspaceSyncPage['state'],
): boolean {
  return (
    left.initialized === right.initialized &&
    left.revision === right.revision &&
    left.resetRevision === right.resetRevision &&
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.seeding === right.seeding
  );
}

function workspaceFileTotals(
  files: readonly BuilderWorkspaceFileRecord[],
  revision: number,
): { fileCount: number; totalBytes: number } | null {
  if ((revision === 0 && files.length > 0) || files.some((file) => file.revision !== revision)) {
    return null;
  }
  return { fileCount: files.length, totalBytes: files.reduce((total, file) => total + file.size, 0) };
}

function syncProtocolError(message: string): Error {
  return new Error(`Invalid durable workspace sync response: ${message}.`);
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
