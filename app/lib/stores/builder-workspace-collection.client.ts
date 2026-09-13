import { createCollection, type SyncConfig } from '@tanstack/db';
import { z } from 'zod';
import {
  BUILDER_WORKSPACE_MAX_FILE_BYTES,
  BUILDER_WORKSPACE_MAX_FILES,
  BUILDER_WORKSPACE_MAX_TOTAL_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_FILES,
  type BuilderWorkspaceEncoding,
  type BuilderWorkspaceSyncEntry,
  type BuilderWorkspaceSyncPage,
} from '~/agents/builder-workspace-types';
import { sha256Hex } from '~/lib/hex-digest';

const WORKSPACE_RPC_TIMEOUT_MS = 30_000;
const WORKSPACE_ROOT = '/home/project';
const MAX_SYNC_CURSOR_CHARS = 256;
const MAX_SYNC_RESTARTS = 3;
const MAX_BASE64_CONTENT_CHARS = Math.ceil(BUILDER_WORKSPACE_MAX_FILE_BYTES / 3) * 4;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const workspacePathSchema = z
  .string()
  .min(WORKSPACE_ROOT.length + 2)
  .max(1_024)
  .refine(isCanonicalWorkspacePath, `Path must be a canonical file path under ${WORKSPACE_ROOT}.`);
const workspaceFileFields = {
  path: workspacePathSchema,
  content: z.string().max(MAX_BASE64_CONTENT_CHARS),
  encoding: z.enum(['utf8', 'base64']),
  size: z.number().int().nonnegative().max(BUILDER_WORKSPACE_MAX_FILE_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
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

const workspaceFileSchema = z
  .object(workspaceFileFields)
  .strict()
  .superRefine(validateFileContent) satisfies z.ZodType<BuilderWorkspaceFileRecord>;

const workspaceStateSchema = z
  .object({
    initialized: z.boolean(),
    revision: revisionSchema,
    resetRevision: revisionSchema,
    fileCount: z.number().int().nonnegative().max(BUILDER_WORKSPACE_MAX_FILES),
    totalBytes: z.number().int().nonnegative().max(BUILDER_WORKSPACE_MAX_TOTAL_BYTES),
    seeding: z.boolean(),
  })
  .strict();
const workspaceSyncEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('write'),
      ...workspaceFileFields,
    })
    .strict()
    .superRefine(validateFileContent),
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
    entries: z.array(workspaceSyncEntrySchema).max(BUILDER_WORKSPACE_SYNC_BATCH_FILES),
    nextCursor: z.string().min(1).max(MAX_SYNC_CURSOR_CHARS).optional(),
    restart: z.boolean().optional(),
  })
  .strict()
  .superRefine((page, context) => {
    const pageBytes = page.entries.reduce((total, entry) => total + (entry.kind === 'write' ? entry.size : 0), 0);
    if (
      pageBytes > BUILDER_WORKSPACE_SYNC_BATCH_BYTES &&
      !(page.entries.length === 1 && pageBytes <= BUILDER_WORKSPACE_MAX_FILE_BYTES)
    ) {
      context.addIssue({ code: 'custom', message: 'Workspace sync page exceeds its byte limit.' });
    }
  }) satisfies z.ZodType<BuilderWorkspaceSyncPage>;

const syncCursorSchema = z
  .object({
    revision: revisionSchema,
    index: z.number().int().nonnegative().max(BUILDER_WORKSPACE_MAX_FILES),
  })
  .strict();

/** The `getWorkspaceSyncPage` argument as this client sends it over the untyped agent RPC. */
type WorkspaceSyncPageRequest = {
  fromRevision: number;
  targetRevision?: number;
  cursor?: string;
};

export type BuilderWorkspaceAgent = {
  call(method: string, args: unknown[], options?: { timeout?: number }): Promise<unknown>;
};

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
      const cursors = new Set<string>();
      let aggregateBytes = 0;
      let cursorIndex = 0;
      let restart = false;

      do {
        const request: WorkspaceSyncPageRequest = { fromRevision };
        if (targetRevision !== undefined) {
          request.targetRevision = targetRevision;
        }
        if (cursor) {
          request.cursor = cursor;
        }
        const page = await parseSyncPage(await this.#call('getWorkspaceSyncPage', [request]));
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
          if (entry.kind === 'write') {
            aggregateBytes += entry.size;
          }
        }
        entries.push(...page.entries);
        if (entries.length > BUILDER_WORKSPACE_MAX_FILES || aggregateBytes > BUILDER_WORKSPACE_MAX_TOTAL_BYTES) {
          throw syncProtocolError('the aggregate workspace payload exceeds its limits');
        }
        if (page.nextCursor) {
          if (cursors.has(page.nextCursor)) {
            throw syncProtocolError('the sync cursor was repeated');
          }
          cursors.add(page.nextCursor);
          const decodedCursor = parseSyncCursor(page.nextCursor);
          if (
            decodedCursor.revision !== page.targetRevision ||
            decodedCursor.index !== entries.length ||
            decodedCursor.index <= cursorIndex
          ) {
            throw syncProtocolError('the sync cursor did not advance to the next entry');
          }
          cursorIndex = decodedCursor.index;
        }
        cursor = page.nextCursor;
      } while (cursor);

      if (restart) {
        continue;
      }
      if (targetRevision === undefined || mode === undefined || expectedState === undefined) {
        throw new Error('The durable workspace sync did not return a target revision.');
      }
      if (
        mode === 'snapshot' &&
        (entries.length !== expectedState.fileCount || aggregateBytes !== expectedState.totalBytes)
      ) {
        throw syncProtocolError('the snapshot totals do not match the workspace state');
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

  async #call(method: string, args: unknown[]): Promise<unknown> {
    return this.agent.call(method, args, { timeout: WORKSPACE_RPC_TIMEOUT_MS });
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
    path.startsWith(`${WORKSPACE_ROOT}/`) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.includes('//') &&
    !path.endsWith('/') &&
    !path.split('/').some((part) => part === '.' || part === '..')
  );
}

function validateFileContent(
  file: { content: string; encoding: BuilderWorkspaceEncoding; size: number },
  context: z.RefinementCtx,
): void {
  const contentBytes = encodedContentSize(file.content, file.encoding);
  if (contentBytes === null) {
    context.addIssue({ code: 'custom', path: ['content'], message: 'Invalid base64 file content.' });
  } else if (contentBytes !== file.size) {
    context.addIssue({ code: 'custom', path: ['size'], message: 'File size does not match its encoded content.' });
  }
}

function encodedContentSize(content: string, encoding: BuilderWorkspaceEncoding): number | null {
  if (encoding === 'utf8') {
    return new TextEncoder().encode(content).byteLength;
  }
  if (!BASE64_PATTERN.test(content)) {
    return null;
  }
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
  return (content.length / 4) * 3 - padding;
}

async function parseSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage> {
  const parsed = workspaceSyncPageSchema.safeParse(value);
  if (!parsed.success) {
    throw syncProtocolError(parsed.error.issues[0]?.message ?? 'invalid page');
  }
  for (const entry of parsed.data.entries) {
    if (entry.kind === 'write' && (await sha256FileContent(entry.content, entry.encoding)) !== entry.sha256) {
      throw syncProtocolError(`the content hash does not match for ${entry.path}`);
    }
  }
  return parsed.data;
}

function parseSyncCursor(value: string): z.infer<typeof syncCursorSchema> {
  try {
    return syncCursorSchema.parse(JSON.parse(atob(value)));
  } catch {
    throw syncProtocolError('invalid sync cursor');
  }
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
  files: readonly unknown[],
  revision: number,
): { fileCount: number; totalBytes: number } | null {
  if (files.length > BUILDER_WORKSPACE_MAX_FILES || (revision === 0 && files.length > 0)) {
    return null;
  }
  let totalBytes = 0;
  for (const file of files) {
    const parsed = workspaceFileSchema.safeParse(file);
    if (!parsed.success || parsed.data.revision !== revision) {
      return null;
    }
    totalBytes += parsed.data.size;
    if (totalBytes > BUILDER_WORKSPACE_MAX_TOTAL_BYTES) {
      return null;
    }
  }
  return { fileCount: files.length, totalBytes };
}

async function sha256FileContent(content: string, encoding: BuilderWorkspaceEncoding): Promise<string> {
  const bytes =
    encoding === 'utf8'
      ? new TextEncoder().encode(content)
      : Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  return sha256Hex(bytes);
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
