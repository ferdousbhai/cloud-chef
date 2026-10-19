import type { BuilderWorkspaceApi } from './builder-workspace-api';
import type { BuilderWorkspaceFileInput, BuilderWorkspaceState } from './builder-workspace-types';
import { batchBuilderWorkspaceSeed, builderTemplateTotals } from './builder-template';

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
