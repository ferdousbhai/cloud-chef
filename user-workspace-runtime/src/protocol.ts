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

/**
 * A workspace opened from one of an organization's GitHub projects: which project, and the commit it was
 * opened from, with each file's SHA-256 then, so its changes can be told from what GitHub already has.
 */
export type BuilderWorkspaceLinkedProject = {
  orgProjectId: string;
  repository: string;
  defaultBranch: string;
  baseCommit: string;
  /**
   * Project-relative paths and SHA-256s of the files at `baseCommit`, and which are executable there:
   * the workspace keeps no file modes, so GitHub's are carried here to commit them back unchanged.
   */
  baseManifest: { path: string; sha256: string; executable?: boolean }[];
};

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

/**
 * The contract between this runtime and the browser and control plane that talk to it: its routes,
 * request and response shapes, Agent callables and state, and its calls to the control plane. A
 * release whose runtime still speaks the protocol of the one a workspace runs keeps that runtime
 * working until nothing is running in it, then upgrades it; a release that bumps this number makes the
 * browser wait for the upgrade instead, still only once nothing is running. Bump it only for a change
 * the previous runtime cannot serve: a new route or callable the browser relies on, or one it changed
 * or removed.
 */
export const USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION = 1;
