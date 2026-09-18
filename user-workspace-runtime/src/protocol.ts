/**
 * The stable boundary shared by the browser, BuilderAgent, control plane, and
 * user-owned workspace runtime. Runtime implementation details stay out of
 * this module so consumers cannot reach through the Worker boundary.
 */

export const BUILDER_WORKSPACE_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const BUILDER_WORKSPACE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const BUILDER_WORKSPACE_MAX_FILES = 10_000;
export const BUILDER_WORKSPACE_SYNC_BATCH_BYTES = 4 * 1024 * 1024;
export const BUILDER_WORKSPACE_SYNC_BATCH_FILES = 100;

export type BuilderWorkspaceEncoding = 'utf8' | 'base64';

export type BuilderWorkspaceFileInput = {
  path: string;
  content: string;
  encoding?: BuilderWorkspaceEncoding;
};

export type BuilderWorkspaceClientChange =
  | {
      kind: 'write';
      path: string;
      content: string;
      encoding?: BuilderWorkspaceEncoding;
      mode?: number;
    }
  | {
      kind: 'delete';
      path: string;
    };

export type BuilderWorkspaceState = {
  initialized: boolean;
  revision: number;
  resetRevision: number;
  fileCount: number;
  totalBytes: number;
  seeding: boolean;
};

export type BuilderWorkspaceSyncEntry =
  | {
      kind: 'write';
      path: string;
      content: string;
      encoding: BuilderWorkspaceEncoding;
      size: number;
      sha256: string;
      revision: number;
    }
  | {
      kind: 'delete';
      path: string;
      revision: number;
    };

export type BuilderWorkspaceSyncPage = {
  state: BuilderWorkspaceState;
  fromRevision: number;
  targetRevision: number;
  mode: 'current' | 'snapshot' | 'delta';
  entries: BuilderWorkspaceSyncEntry[];
  nextCursor?: string;
  restart?: boolean;
};

export type BuilderWorkspaceSeedStartResult =
  | { status: 'initialized'; state: BuilderWorkspaceState }
  | { status: 'seeding'; state: BuilderWorkspaceState }
  | { status: 'started'; seedId: string; state: BuilderWorkspaceState };

export type BuilderWorkspaceApplyResult =
  | {
      ok: true;
      state: BuilderWorkspaceState;
      changedPaths: string[];
    }
  | {
      ok: false;
      conflict: true;
      state: BuilderWorkspaceState;
    };

/** One unpromoted Worker version, bound to the exact checkpoint validation built it from. */
export type BuilderPreviewSuccess = {
  id: string;
  url: string;
  workspaceRevision: number;
  snapshotRevision: string;
  readyAt: string;
};

export const USER_WORKSPACE_RUNTIME_SERVICE = 'cloudchef-user-workspace-runtime';
