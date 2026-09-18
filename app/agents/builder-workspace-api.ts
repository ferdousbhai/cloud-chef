import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { CreateAIToolsOptions } from '@cloudflare/computer/tools';
import type { DeploymentProjectProfile } from '~/lib/.server/cloudflare/deployment-project-profile';
import type { PreparedDeploymentArtifact } from '~/lib/.server/cloudflare/deployment-artifact';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type {
  BuilderWorkspaceApplyResult,
  BuilderWorkspaceClientChange,
  BuilderWorkspaceFileInput,
  BuilderWorkspaceSeedStartResult,
  BuilderWorkspaceState,
  BuilderWorkspaceSyncPage,
} from './builder-workspace-types';

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

export type WorkspaceDeploymentSessionRequest = {
  operationId: string;
  expectedWorkspaceRevision: number;
  expectedSnapshotRevision: string;
};

export type WorkspaceDeploymentArtifactRequest = {
  sessionId: string;
  operationId: string;
  revision: string;
  deploymentId: string;
  executionGeneration: number;
  accountId: string;
  workerName: string;
  projectType: DeploymentProjectProfile['type'];
  workersAi: boolean;
  appAgent: boolean;
  d1DatabaseId?: string;
  d1DatabaseName?: string;
  agentSecurityD1DatabaseId?: string;
  agentSecurityD1DatabaseName?: string;
  r2BucketName?: string;
  kvNamespaceId?: string;
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
 * Read-only discovery over the workspace VFS. These carry no operation key: the workspace serves
 * them outside the exclusive operation lane and without waking the Container, so they are never
 * journalled as tool operations and never need reattaching.
 */
export type WorkspaceListingRequest = {
  /** Absolute project directory; the project root when omitted. */
  path?: string;
  recursive?: boolean;
  limit?: number;
};

export type WorkspaceSearchRequest = {
  /** Literal, single-line text. Never a regular expression and never a shell argument. */
  pattern: string;
  path?: string;
  ignoreCase?: boolean;
  limit?: number;
};

type BuilderWorkspaceProjectEntry = { path: string; type: 'file' | 'dir' };

export type BuilderWorkspaceListing = {
  path: string;
  recursive: boolean;
  entries: BuilderWorkspaceProjectEntry[];
  entryCount: number;
  truncated: boolean;
  revision: number;
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

export type BuilderWorkspaceDeploymentPlan = BuilderWorkspaceCheckpoint & {
  project: DeploymentProjectProfile;
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
  listWorkspaceFiles(): Promise<BuilderWorkspaceFileMetadata[]>;
  readDirectory(path: string): Promise<BuilderWorkspaceDirectoryEntry[]>;
  listProjectEntries(value: WorkspaceListingRequest): Promise<BuilderWorkspaceListing>;
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
  validationStatus(revision: string): { valid: boolean } | Promise<{ valid: boolean }>;
  deploymentPlan(revision: string): Promise<BuilderWorkspaceDeploymentPlan>;
  beginDeploymentSession(value: WorkspaceDeploymentSessionRequest): Promise<void>;
  assertDeploymentSession(value: { sessionId: string }): Promise<BuilderWorkspaceCheckpoint>;
  prepareDeploymentArtifact(value: WorkspaceDeploymentArtifactRequest): Promise<PreparedDeploymentArtifact>;
  finishDeploymentSession(value: { sessionId: string; status: 'completed' | 'failed' }): Promise<void>;
  terminalizeInterruptedDeploymentSession(value: { sessionId: string }): Promise<void>;
  deleteProject(): Promise<void>;
}

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
  listProjectEntries(request: WorkspaceListingRequest, abortSignal?: AbortSignal): Promise<BuilderWorkspaceListing>;
  searchProjectFiles(request: WorkspaceSearchRequest, abortSignal?: AbortSignal): Promise<BuilderWorkspaceSearchResult>;
  checkpoint(): Promise<BuilderWorkspaceCheckpoint>;
  executeCommand(
    args: WorkspaceCommandRequest & {
      onUpdate?: (partialResult: WorkspaceCommandProgress) => void;
      abortSignal?: AbortSignal;
    },
  ): Promise<WorkspaceCommandResult & { streamTruncated?: boolean }>;
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
  hasSuccessfulValidation(revision: string): Promise<boolean>;
  prepareDeployment(revision: string): Promise<BuilderWorkspaceDeploymentPlan>;
  deleteProject(): Promise<void>;
}
