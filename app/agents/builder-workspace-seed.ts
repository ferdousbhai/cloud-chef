import type { BuilderWorkspaceApi, WorkspaceSyncPageRequest } from './builder-workspace-api';
import {
  BUILDER_WORKSPACE_SYNC_BATCH_BYTES,
  BUILDER_WORKSPACE_SYNC_BATCH_FILES,
  type BuilderWorkspaceFileInput,
  type BuilderWorkspaceState,
  type BuilderWorkspaceSyncEntry,
  type BuilderWorkspaceSyncPage,
} from '@cloudchef/user-workspace-runtime/protocol';
import { z } from 'zod';
import { builderTemplateTotals } from './builder-template';

/** How many times reading a workspace's whole sync feed starts over because the workspace changed. */
const MAX_SYNC_FEED_RESTARTS = 5;

/**
 * The most path and content characters one `appendSeed` call carries, which keeps the Durable Object RPC
 * carrying it well under its 32 MiB message limit. Characters, not decoded bytes: base64 content goes over
 * the wire as written.
 */
const SEED_BATCH_CHARACTERS = BUILDER_WORKSPACE_SYNC_BATCH_BYTES * 6;

/**
 * Groups seed files into `appendSeed` calls of at most the runtime's file count per call and
 * `SEED_BATCH_CHARACTERS`; a file larger than that goes alone. It reads `entries` as they come, so a
 * streamed repository never sits in memory whole.
 */
export async function* seedBatches(
  entries: Iterable<BuilderWorkspaceFileInput> | AsyncIterable<BuilderWorkspaceFileInput>,
): AsyncGenerator<BuilderWorkspaceFileInput[]> {
  let batch: BuilderWorkspaceFileInput[] = [];
  let characters = 0;
  for await (const entry of entries) {
    const entryCharacters = entry.path.length + entry.content.length;
    if (
      batch.length > 0 &&
      (batch.length >= BUILDER_WORKSPACE_SYNC_BATCH_FILES || characters + entryCharacters > SEED_BATCH_CHARACTERS)
    ) {
      yield batch;
      batch = [];
      characters = 0;
    }
    batch.push(entry);
    characters += entryCharacters;
  }
  if (batch.length > 0) {
    yield batch;
  }
}

type BuilderWorkspaceSyncWrite = Extract<BuilderWorkspaceSyncEntry, { kind: 'write' }>;

/**
 * Every file a workspace holds, read page by page from the start of its sync feed, and the revision they
 * are at; null when the workspace kept changing under the read, which starts over each time.
 */
export async function readWholeSyncFeed(
  getPage: (request: WorkspaceSyncPageRequest) => Promise<BuilderWorkspaceSyncPage>,
): Promise<{ files: BuilderWorkspaceSyncWrite[]; targetRevision: number } | null> {
  let files: BuilderWorkspaceSyncWrite[] = [];
  let cursor: string | undefined;
  for (let restarts = 0; restarts <= MAX_SYNC_FEED_RESTARTS;) {
    const page = await getPage(cursor ? { fromRevision: 0, cursor } : { fromRevision: 0 });
    if (page.restart) {
      restarts += 1;
      files = [];
      cursor = undefined;
      continue;
    }
    files.push(...page.entries.filter((entry) => entry.kind === 'write'));
    if (!page.nextCursor) {
      return { files, targetRevision: page.targetRevision };
    }
    cursor = page.nextCursor;
  }
  return null;
}

export function parentBuilderWorkspaceSeedId(targetRevision: number): string {
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 0) {
    throw new Error('The parent workspace revision is invalid.');
  }
  return `parent_${targetRevision}`;
}

/**
 * Seed a workspace from the beginning. Replaying every batch is intentional:
 * Computer writes are replacements, so the same durable seed can resume after
 * an Agent eviction without maintaining a second progress ledger.
 */
export async function seedBuilderWorkspace(
  workspace: BuilderWorkspaceApi,
  seedId: string,
  entries: BuilderWorkspaceFileInput[],
  /** Runs after every file is in and before the seed commits: what must hold whenever the workspace does. */
  beforeCommit: () => Promise<void> = async () => undefined,
): Promise<BuilderWorkspaceState> {
  const started = await workspace.beginSeed(seedId);
  if (started.status === 'initialized') {
    return started.state;
  }
  try {
    for await (const batch of seedBatches(entries)) {
      await workspace.appendSeed(seedId, batch);
    }
    await beforeCommit();
    return await workspace.commitSeed(seedId, builderTemplateTotals(entries));
  } catch (error) {
    await workspace.abortSeed(seedId).catch(() => undefined);
    throw error;
  }
}

/**
 * What preparing a workspace answers when its project's files could not be put in it: a failure the person
 * reads and retries, which reconnecting would only repeat.
 */
export type WorkspaceSeedFailure = { initialized: false; failure: string };

const SEED_FAILED_MESSAGE = "CloudChef could not copy the project's files into your workspace.";

/**
 * A new workspace's seed failed. Its message is the cause's own, which CloudChef's project and repository
 * errors write for the person (a GitHub import refused, no access to the project), except a parse error's
 * dump of fields, or no message at all.
 */
export class WorkspaceSeedError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error && !(cause instanceof z.ZodError) && cause.message.trim()
        ? cause.message
        : SEED_FAILED_MESSAGE,
      { cause },
    );
    this.name = 'WorkspaceSeedError';
  }
}
