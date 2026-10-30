import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { RefUpdate } from '~/lib/.server/cloudflare/git-proxy';
import type { CreateAIToolsOptions } from '@cloudflare/computer/tools/ai-sdk';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceLinkedProject,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from '@cloudchef/user-workspace-runtime/protocol';

export type BuilderWorkspaceFileMetadata = {
  path: string;
  encoding: 'utf8' | 'base64';
  size: number;
  mode: number;
  sha256: string;
  revision: number;
};

export type BuilderWorkspaceCheckpoint = {
  workspaceRevision: number;
  revision: string;
};

/**
 * `reattach` is `execute` for an operation that was interrupted after it started: running the tool
 * again adopts the execution the previous workspace instance left behind instead of repeating it.
 */
export type ToolOperationStartResult =
  | { status: 'execute' | 'active' | 'reattach' }
  | { status: 'completed'; result: unknown }
  | { status: 'failed' | 'indeterminate'; error: string };

export type ToolOperationBeginRequest = {
  toolCallId: string;
  toolName: string;
  argsJson: string;
};

export type ToolOperationCompleteRequest = {
  toolCallId: string;
  /** Opaque tool payload: each tool owns its own result shape, so the workspace stores it verbatim. */
  result: unknown;
};

export type ToolOperationFailureRequest = {
  toolCallId: string;
  error: string;
};

export type WorkspaceSeedExpectation = {
  fileCount: number;
  totalBytes: number;
};

export type WorkspaceApplyChangesRequest = {
  baseRevision: number;
  changes: BuilderWorkspaceClientChange[];
  toolCallId?: string;
  operationKey?: string;
};

export type WorkspaceSyncPageRequest = {
  fromRevision: number;
  cursor?: string;
};

export type WorkspaceCommandRequest = {
  command: string;
  /** Absolute or project-relative directory; the workspace root when omitted. */
  cwd?: string;
  /** Forwarded from the Computer exec options; the runtime accepts only `container-shell`. */
  backend?: string;
  operationKey?: string;
  /** The agent whose tool call runs the command: a change `cf` asks for meanwhile is approved in its chat. */
  agentName?: string;
};

export type WorkspaceCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Partial output streamed while a command is still running. */
export type WorkspaceCommandProgress = {
  command: string;
  cwd: string | null;
  backend: string;
  stdout: string;
  stderr: string;
  running: true;
};

export type WorkspaceCancelExecutionRequest = {
  operationKey: string;
};

export type WorkspaceInstallDependenciesRequest = {
  toolCallId: string;
  /** Raw model-supplied tool arguments, echoed back in the tool result for the transcript. */
  input: unknown;
  mode: 'add' | 'sync-lockfile';
  packages: string[];
};

export type WorkspaceValidateRequest = {
  toolCallId: string;
  /** Raw model-supplied tool arguments, echoed back in the tool result for the transcript. */
  input: unknown;
};

/**
 * Reports the stage a running validation just entered. Workers RPC forwards a function parameter as
 * a callback into the workspace runtime, so the stage the container is actually on reaches the UI
 * while the operation runs instead of only in its result.
 */
export type WorkspaceValidationStageReporter = (stage: BuilderValidationStage) => void;

export type WorkspaceCancelValidationRequest = {
  toolCallId?: string;
};

export type BuilderWorkspaceTextFile = {
  path: string;
  content: string;
  encoding: 'utf8';
  size: number;
  sha256: string;
  revision: number;
};

export type BuilderWorkspaceBinaryFile = {
  path: string;
  bytes: Uint8Array;
  encoding: 'utf8' | 'base64';
  size: number;
  mode: number;
  sha256: string;
  revision: number;
};

export type BuilderWorkspaceDirectoryEntry = {
  name: string;
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

/**
 * A read-only search over the workspace VFS. It carries no operation key: the workspace serves it
 * outside the exclusive operation lane and without waking the Container, so it is never journalled
 * as a tool operation and never needs reattaching.
 */
export type WorkspaceSearchRequest = {
  /** Literal, single-line text. Never a regular expression and never a shell argument. */
  pattern: string;
  path?: string;
  ignoreCase?: boolean;
  limit?: number;
};

type BuilderWorkspaceSearchMatch = { path: string; line: number; text: string };

export type BuilderWorkspaceSearchResult = {
  pattern: string;
  path: string;
  matches: BuilderWorkspaceSearchMatch[];
  matchCount: number;
  filesScanned: number;
  filesSkipped: number;
  truncated: boolean;
  revision: number;
};

export const WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE = 'workspace_tool_operation_indeterminate';

export function isWorkspaceToolOperationIndeterminateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('code' in error && error.code === WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE) {
    return true;
  }
  // Workers RPC may preserve only an exception message, so a workspace-raised indeterminate
  // outcome carries the same code in its message and must not be read as an ordinary failure.
  return (
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.startsWith(`[${WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE}]`)
  );
}

export class WorkspaceToolOperationIndeterminateError extends Error {
  readonly code = WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(
      JSON.stringify({
        code: WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE,
        error: message,
        retryable: false,
      }),
      options,
    );
    this.name = 'WorkspaceToolOperationIndeterminateError';
  }
}

/**
 * A project's builder in the runtime (`user-workspace-runtime/src/project-builder.ts`): CloudChef's own build and
 * deploy of a project it deploys itself, one commit at a time.
 */
export interface ProjectBuilderRpc extends Rpc.DurableObjectBranded {
  enqueue(value: {
    orgProjectId: string;
    branch: string;
    commit: string;
    headReadAt?: number;
  }): Promise<{ queued: boolean }>;
  retry(value: {
    orgProjectId: string;
    deploymentId: string;
    toWantedWorker?: true;
  }): Promise<{ deploymentId: string }>;
  log(deploymentId: string): string | null | Promise<string | null>;
}

export interface ProjectWorkspaceRpc extends Rpc.DurableObjectBranded {
  initializeProjectIdentity(value: { projectId: string; userId: string }): void | Promise<void>;
  beginToolOperation(value: ToolOperationBeginRequest): Promise<ToolOperationStartResult>;
  completeToolOperation(value: ToolOperationCompleteRequest): Promise<unknown>;
  failToolOperation(value: ToolOperationFailureRequest): void | Promise<void>;
  cancelToolOperation(value: ToolOperationFailureRequest): Promise<{ status: 'active' | 'settled' }>;
  getWorkspaceState(): Promise<BuilderWorkspaceState>;
  getWorkspaceSnapshot(): Promise<{ state: BuilderWorkspaceState; files: BuilderWorkspaceFileMetadata[] }>;
  beginSeed(seedId: unknown): Promise<BuilderWorkspaceSeedStartResult>;
  appendSeed(seedId: unknown, entries: unknown): Promise<BuilderWorkspaceState>;
  commitSeed(seedId: unknown, expected: unknown): Promise<BuilderWorkspaceState>;
  abortSeed(seedId: unknown): Promise<BuilderWorkspaceState>;
  applyChanges(value: unknown): Promise<BuilderWorkspaceApplyResult>;
  getSyncPage(value: unknown): Promise<BuilderWorkspaceSyncPage>;
  readText(path: unknown): Promise<BuilderWorkspaceTextFile>;
  readWorkspaceFile(path: unknown): Promise<BuilderWorkspaceBinaryFile>;
  streamWorkspaceFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readDirectory(path: string): Promise<BuilderWorkspaceDirectoryEntry[]>;
  searchProjectFiles(value: WorkspaceSearchRequest): Promise<BuilderWorkspaceSearchResult>;
  makeDirectory(path: string): Promise<void>;
  warmContainer(): Promise<void>;
  execute(value: WorkspaceCommandRequest): Promise<WorkspaceCommandResult>;
  executeStream(value: WorkspaceCommandRequest): Promise<ReadableStream<Uint8Array>>;
  cancelExecution(value: WorkspaceCancelExecutionRequest): Promise<void>;
  checkpoint(): Promise<BuilderWorkspaceCheckpoint>;
  installDependenciesTool(value: WorkspaceInstallDependenciesRequest): Promise<CloudChefToolResult>;
  validateTool(
    value: WorkspaceValidateRequest,
    onStage?: WorkspaceValidationStageReporter,
  ): Promise<CloudChefToolResult>;
  cancelValidation(value: WorkspaceCancelValidationRequest): Promise<void>;
  deleteProject(): Promise<void>;
  setLinkedProject(value: BuilderWorkspaceLinkedProject): Promise<void>;
  linkedProject(): Promise<BuilderWorkspaceLinkedProject | null>;
  setGitRepository(value: BuilderWorkspaceGitRepository): Promise<void>;
  takeGitPushes(): Promise<RefUpdate[]>;
  knownMain(): Promise<string | null>;
}

/**
 * The project repository git in the workspace reaches through its git proxy, with the project it belongs to.
 */
export type BuilderWorkspaceGitRepository = { repo: string; orgProjectId: string | null };

/**
 * Project workspace operations available to the CloudChef control plane.
 *
 * The Cloudflare Computer VFS remains the sole source of truth. This facade
 * exposes product operations without exposing the underlying DO storage.
 */
export interface BuilderWorkspaceApi {
  readonly projectId: string;
  readonly computer: CreateAIToolsOptions['workspace'];
  refresh(): Promise<BuilderWorkspaceState>;
  getState(): BuilderWorkspaceState;
  beginSeed(seedId: string): Promise<BuilderWorkspaceSeedStartResult>;
  appendSeed(seedId: string, entries: BuilderWorkspaceFileInput[]): Promise<BuilderWorkspaceState>;
  commitSeed(seedId: string, expected: WorkspaceSeedExpectation): Promise<BuilderWorkspaceState>;
  abortSeed(seedId: string): Promise<BuilderWorkspaceState>;
  applyClientChanges(value: WorkspaceApplyChangesRequest): Promise<BuilderWorkspaceApplyResult>;
  /** Best-effort container pre-start. Never throws; a cold container is still a working one. */
  warmContainer(): Promise<void>;
  getSyncPage(value: WorkspaceSyncPageRequest): Promise<BuilderWorkspaceSyncPage>;
  readText(path: string, abortSignal?: AbortSignal): Promise<BuilderWorkspaceTextFile>;
  readFile(path: string): Promise<BuilderWorkspaceBinaryFile>;
  listFiles(): BuilderWorkspaceFileMetadata[];
  searchProjectFiles(request: WorkspaceSearchRequest, abortSignal?: AbortSignal): Promise<BuilderWorkspaceSearchResult>;
  checkpoint(): Promise<BuilderWorkspaceCheckpoint>;
  executeCommand(
    args: WorkspaceCommandRequest & {
      onUpdate?: (partialResult: WorkspaceCommandProgress) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<WorkspaceCommandResult & { streamTruncated?: boolean; workspaceLimits?: string }>;
  executeToolOnce<T>(
    toolCallId: string,
    toolName: string,
    args: unknown,
    execute: () => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T>;
  installDependencies(
    args: WorkspaceInstallDependenciesRequest & { abortSignal?: AbortSignal },
  ): Promise<CloudChefToolResult>;
  validate(
    args: WorkspaceValidateRequest & { abortSignal?: AbortSignal; onStage?: WorkspaceValidationStageReporter },
  ): Promise<CloudChefToolResult>;
  cancelActiveValidation(): Promise<void>;
  /** Records the project this workspace was opened from (its base commit and files). */
  setLinkedProject(value: BuilderWorkspaceLinkedProject): Promise<void>;
  /** The project this workspace works on, or null before it is prepared. */
  linkedProject(): Promise<BuilderWorkspaceLinkedProject | null>;
  /** Records the repository git in the workspace pushes to and fetches from. */
  setGitRepository(value: BuilderWorkspaceGitRepository): Promise<void>;
  /** The refs git in the workspace pushed since this was last asked, each given once. */
  takeGitPushes(): Promise<RefUpdate[]>;
  /**
   * The commit main was at when git in the workspace last fetched or pushed it, or CloudChef seeded the workspace
   * at; null when that isn't known.
   */
  knownMain(): Promise<string | null>;
  deleteProject(): Promise<void>;
}
