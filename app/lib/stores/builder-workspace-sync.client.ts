import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceState,
} from '@cloudchef/user-workspace-runtime/protocol';
import {
  callWorkspaceAgent,
  createBuilderWorkspaceCollection,
  type BuilderWorkspaceAgent,
  type BuilderWorkspaceCollection,
  type BuilderWorkspacePullResult,
  workspaceCollectionSnapshot,
} from './builder-workspace-collection.client';
import { workbenchStore } from './workbench.client';

const logger = createScopedLogger('BuilderWorkspaceSyncController');

/**
 * Keeps the browser presentation and its in-memory TanStack DB collection
 * aligned with the authoritative Durable Object workspace. Browser writes are
 * single-revision CAS operations; conflicts reload server state and never
 * rebase a stale local edit.
 */
export class BuilderWorkspaceSyncController {
  #revision = 0;
  #operationQueue: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #changeListener = (changes: BuilderWorkspaceClientChange[], isCurrentChange: () => boolean) =>
    this.push(changes, isCurrentChange);

  private constructor(
    private readonly agent: BuilderWorkspaceAgent,
    private readonly workspaceId: string,
    private readonly collection: BuilderWorkspaceCollection,
    private readonly source: ReturnType<typeof createBuilderWorkspaceCollection>['source'],
  ) {}

  static async initialize(
    agent: BuilderWorkspaceAgent,
    { workspaceId, isCurrent }: { workspaceId: string; isCurrent: () => boolean },
  ): Promise<BuilderWorkspaceSyncController> {
    if (!isCurrent()) {
      throw new Error('The durable workspace connection was superseded.');
    }
    workbenchStore.activateWorkspace(workspaceId);
    const state = await callWorkspaceAgent<BuilderWorkspaceState>(agent, 'getWorkspaceState', []);
    if (!isCurrent() || !workbenchStore.isWorkspaceActive(workspaceId)) {
      throw new Error('The durable workspace connection was superseded.');
    }
    if (!state.initialized) {
      throw new Error('The durable project workspace is not initialized.');
    }
    const { collection, source } = createBuilderWorkspaceCollection({
      agent,
      workspaceId,
    });
    const controller = new BuilderWorkspaceSyncController(agent, workspaceId, collection, source);
    const initialPullOutcome = source.initialPull.then(
      (pull) => ({ ok: true as const, pull }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await collection.preload();
      if (!isCurrent()) {
        throw new Error('The durable workspace connection was superseded.');
      }
      const initialPull = await initialPullOutcome;
      if (!initialPull.ok) {
        throw initialPull.error;
      }
      if (!isCurrent() || !workbenchStore.isWorkspaceActive(workspaceId)) {
        throw new Error('The durable workspace connection was superseded.');
      }
      controller.#revision = initialPull.pull.revision;
      controller.#replacePresentationFromCollection();
      workbenchStore.setWorkspaceChangeListener(controller.#changeListener);
      return controller;
    } catch (error) {
      controller.dispose();
      throw error;
    }
  }

  dispose(): void {
    this.#disposed = true;
    workbenchStore.clearWorkspaceChangeListener(this.#changeListener);
    void this.collection.cleanup();
  }

  async push(
    changes: BuilderWorkspaceClientChange[],
    isCurrentChange: () => boolean,
  ): Promise<BuilderWorkspaceApplyResult> {
    if (this.#disposed) {
      throw new Error('The durable workspace connection was closed.');
    }
    if (changes.length === 0) {
      return { ok: true, state: await callWorkspaceAgent(this.agent, 'getWorkspaceState', []), changedPaths: [] };
    }
    return this.#enqueue(async () => {
      const applied = await callWorkspaceAgent<BuilderWorkspaceApplyResult>(this.agent, 'applyWorkspaceClientChanges', [
        { baseRevision: this.#revision, changes },
      ]);
      if (applied.ok) {
        this.#revision = applied.state.revision;
        try {
          const pull = await this.source.pull();
          this.#revision = pull.revision;
          if (!this.#disposed) {
            this.#presentPull(pull, isCurrentChange() ? undefined : new Set(changes.map((change) => change.path)));
          }
        } catch (error) {
          // The edit is already durable. Preserve success and let the next
          // normal reconciliation retry the in-memory workspace refresh.
          logger.warn('Failed to refresh the browser workspace view after a durable edit', error);
        }
      } else {
        const pull = await this.source.replaceFromSnapshot();
        this.#revision = pull.revision;
        this.#replacePresentationFromCollection();
      }
      return applied;
    });
  }

  pull(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    return this.#enqueue(async () => {
      const pull = await this.source.pull();
      this.#revision = pull.revision;
      this.#presentPull(pull);
    });
  }

  #presentPull(pull: BuilderWorkspacePullResult, preservedPaths?: ReadonlySet<string>): void {
    if (this.#disposed || !workbenchStore.isWorkspaceActive(this.workspaceId)) {
      return;
    }
    if (pull.mode === 'snapshot') {
      this.#replacePresentationFromCollection(preservedPaths);
    } else if (pull.entries.length > 0) {
      const entries = preservedPaths ? pull.entries.filter((entry) => !preservedPaths.has(entry.path)) : pull.entries;
      if (entries.length > 0) {
        workbenchStore.applyWorkspaceSyncEntries(entries);
      }
    }
  }

  #replacePresentationFromCollection(preservedPaths?: ReadonlySet<string>): void {
    if (this.#disposed || !workbenchStore.isWorkspaceActive(this.workspaceId)) {
      return;
    }
    const snapshot = workspaceCollectionSnapshot(this.collection);
    workbenchStore.replaceWorkspaceSnapshot(snapshot, preservedPaths);
  }

  /** Runs `operation` after every operation queued before it, settled or not. */
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.#operationQueue.then(operation);
    this.#operationQueue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
}
