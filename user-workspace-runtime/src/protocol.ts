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
 * A workspace opened from a project the control plane keeps (a team's, or one imported from GitHub): which
 * project, and the commit of its repository it was opened from, which git in the workspace starts from.
 */
export type BuilderWorkspaceLinkedProject = {
  orgProjectId: string;
  /** The project's repository in the account's Artifacts (the control plane's answer is authoritative). */
  repository: string;
  /** The project's name, as people see it. */
  name?: string;
  defaultBranch: string;
  baseCommit: string;
};

export type BuilderWorkspaceFileInput = {
  path: string;
  content: string;
  encoding?: BuilderWorkspaceEncoding;
  /** The file's mode (0o755 for an executable), when the seed carries it. */
  mode?: number;
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
      /** The file's mode, so a workspace copied from this one keeps its executables. */
      mode?: number;
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
export const USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION = 2;
