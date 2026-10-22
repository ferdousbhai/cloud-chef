import type { BuilderWorkspaceApi, WorkspaceSyncPageRequest } from './builder-workspace-api';
import type {
  BuilderWorkspaceFileInput,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncEntry,
  BuilderWorkspaceSyncPage,
} from './builder-workspace-types';
import { batchBuilderWorkspaceSeed, builderTemplateTotals } from './builder-template';

/** How many times reading a workspace's whole sync feed starts over because the workspace changed. */
const MAX_SYNC_FEED_RESTARTS = 5;

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
    for (const batch of batchBuilderWorkspaceSeed(entries)) {
      await workspace.appendSeed(seedId, batch);
    }
    await beforeCommit();
    return await workspace.commitSeed(seedId, builderTemplateTotals(entries));
  } catch (error) {
    await workspace.abortSeed(seedId).catch(() => undefined);
    throw error;
  }
}
