import {
  COMPUTER_DEFAULT_SHELL_BACKEND,
  COMPUTER_EXEC_APPLICATION_POLICY,
  COMPUTER_TOOL_LIMITS,
  computerSyncUnconfirmedToolResult,
} from 'cloudchef-agent/cloudflare-computer';
import type { CloudChefToolSet } from 'cloudchef-agent/types';
import {
  applyLineEdits,
  lineAnchoredRead,
  lineEditBaseTag,
  lineEditToolParameters,
  logicalLines,
  type LineEditToolInput,
} from 'cloudchef-agent/line-edit';
import {
  isWorkspaceReadOnlyToolName,
  MODEL_TOOL_INPUT_SCHEMAS,
  WORKSPACE_TOOL_NAMES,
  type WorkspaceToolName,
} from 'cloudchef-agent/model-tool-inputs';
import { parseDependencyCommand } from 'cloudchef-agent/tools/dependency-command';
import { rejectedWorkspaceCommand, rejectedWorkspaceFileMutation } from 'cloudchef-agent/workspace-boundary';
import { toolFailure } from 'cloudchef-agent/tool-result';
import { isWorkspaceToolOperationIndeterminateError, type BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { Tool } from 'cloudchef-agent/tool';
import { type BuilderSkillReader, isBuilderSkillPath } from './builder-skills';
import { cloudflareDocsSearchTool } from './cloudflare-docs-search';
import { sha256Hex } from '~/lib/hex-digest';
import type { CloudflareApiModelToolContext } from './cloudflare-api-model-tools';
import { linkedProjectModelTools, type LinkedProjectModelToolContext } from './linked-project-model-tools';
import { isRecord } from 'cloudchef-agent/utils/isRecord';

/** What a builder turn lends its workspace tools: validation progress, and keeping the turn alive while one runs. */
export type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
};

type TurnStatefulToolCoordinator = <T>(toolName: string, operation: () => Promise<T>) => Promise<T>;

const CLOUDFLARE_REQUEST_TOOL_DESCRIPTION =
  'Send one Cloudflare API request for the connected account; the account is fixed by the server, so never choose another. ' +
  'In the workspace, find the operation with `cf cli search "<task>"` (describe the action only, never names or IDs), ' +
  'check it with `cf schema <command>`, run `cf <command> --dry-run`, and pass that JSON unchanged here: cf has no ' +
  'credential in the workspace, so only this tool sends requests. Report insufficient scopes honestly, and deploy ' +
  'generated apps through the workspace deployment path, not this tool. GET runs immediately; any other method is ' +
  'stored for fresh user approval and pauses the turn.';

export function createWorkersAiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
  skillReader: BuilderSkillReader,
  cloudflareApi?: CloudflareApiModelToolContext,
  linkedProject?: LinkedProjectModelToolContext,
): CloudChefToolSet {
  const coordinateStatefulTool = createTurnStatefulToolCoordinator(operationContext.runWithKeepAlive);
  const tools: CloudChefToolSet = {
    read: lineAnchoredReadTool(workspace, skillReader),
    ls: projectListingTool(workspace),
    grep: projectSearchTool(workspace),
    write: abortAwareWriteTool(workspace),
    edit: lineAnchoredEditTool(workspace),
    exec: streamingExecTool(workspace),
    validate: canonicalValidationTool(linkedProject !== undefined),
    // Stateless and remote: it must not take the workspace operation lane.
    search_cloudflare_docs: cloudflareDocsSearchTool(),
  };

  if (cloudflareApi) {
    tools.cloudflare_request = {
      description: CLOUDFLARE_REQUEST_TOOL_DESCRIPTION,
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.cloudflare_request,
      execute: async (input, options) =>
        cloudflareApi.request(MODEL_TOOL_INPUT_SCHEMAS.cloudflare_request.parse(input), options),
    };
  }

  if (linkedProject) {
    Object.assign(tools, linkedProjectModelTools(linkedProject));
  }

  for (const toolName of WORKSPACE_TOOL_NAMES) {
    tools[toolName] = computerWorkspaceTool(
      toolName,
      tools[toolName],
      workspace,
      operationContext,
      coordinateStatefulTool,
    );
  }
  return tools;
}

function lineAnchoredReadTool(workspace: BuilderWorkspaceApi, skillReader: BuilderSkillReader): Tool {
  return {
    description:
      'Read a UTF-8 project or /__skills__/ reference file as numbered lines. Project reads return a compact base snapshot tag required by edit. Skill files are read-only. Output is bounded; use offset and limit to continue.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.read,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.read.parse(input);
      options.abortSignal?.throwIfAborted();
      const skillResult = isBuilderSkillPath(parsed.path) ? await skillReader.read(parsed.path) : null;
      if (skillResult) {
        return lineAnchoredRead({
          path: parsed.path,
          content: skillResult.content,
          sha256: await sha256Hex(skillResult.content),
          offset: parsed.offset,
          limit: parsed.limit,
          maxLines: COMPUTER_TOOL_LIMITS.readMaxLines,
          maxBytes: COMPUTER_TOOL_LIMITS.readMaxBytes,
        });
      }
      if (isBuilderSkillPath(parsed.path)) {
        throw new Error(`Skill reference not found: ${parsed.path}`);
      }
      const file = await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
      return lineAnchoredRead({
        path: file.path,
        content: file.content,
        sha256: file.sha256,
        offset: parsed.offset,
        limit: parsed.limit,
        maxLines: COMPUTER_TOOL_LIMITS.readMaxLines,
        maxBytes: COMPUTER_TOOL_LIMITS.readMaxBytes,
      });
    },
  };
}

function projectListingTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description:
      'List project files and directories from the durable workspace index. It answers from storage without starting the container, so use it instead of exec to discover what exists. Omit path for the project root; set recursive for the whole tree beneath a directory. A recursive walk shows node_modules and build output as directories but does not descend into them; list one of those directories directly to look inside it. Output is bounded: when truncated is true, narrow path or lower limit.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.ls,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.ls.parse(input);
      rejectSkillNamespacePath(parsed.path);
      options.abortSignal?.throwIfAborted();
      return workspace.listProjectEntries(parsed, options.abortSignal);
    },
  };
}

function projectSearchTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description:
      'Find lines containing literal text across project files, from the durable workspace index and without starting the container. pattern is matched as plain single-line text: it is not a regular expression and not a glob. Each match returns its file path, 1-based line number, and the matching line, so a hit can be read or edited directly. A search does not descend into node_modules or build output unless path names one of them. Output is bounded: when truncated is true, use a more specific pattern or a narrower path.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.grep,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.grep.parse(input);
      rejectSkillNamespacePath(parsed.path);
      options.abortSignal?.throwIfAborted();
      return workspace.searchProjectFiles(parsed, options.abortSignal);
    },
  };
}

/**
 * `/__skills__/` is a read-only control-plane overlay that never enters the project VFS. Deciding
 * that here, before the workspace sees the path, is the same order `read` uses: the namespace
 * cannot be shadowed by a project file, and it cannot appear in a listing of the project because
 * the workspace is never asked about it.
 */
function rejectSkillNamespacePath(path: string | undefined): void {
  if (path !== undefined && isBuilderSkillPath(path)) {
    throw new Error(
      `${path} is a bundled skill reference, not part of the project workspace. Use read to open it or list its directory.`,
    );
  }
}

function abortAwareWriteTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description: 'Write content to a file. Overwrites any existing file at the path.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.write,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.write.parse(input);
      if (isBuilderSkillPath(parsed.path)) {
        throw new Error(`Skill files are read-only: ${parsed.path}`);
      }
      const mutationRejection = rejectedWorkspaceFileMutation(parsed.path, parsed.content);
      if (mutationRejection) {
        return { path: parsed.path, error: mutationRejection };
      }
      const bytes = new TextEncoder().encode(parsed.content);
      if (bytes.byteLength > COMPUTER_TOOL_LIMITS.mutationMaxBytes) {
        return {
          error: `Content too large: ${bytes.byteLength} bytes exceeds the ${COMPUTER_TOOL_LIMITS.mutationMaxBytes}-byte write cap. Use the edit tool for incremental changes to existing files, or split the write into smaller pieces.`,
        };
      }

      options.abortSignal?.throwIfAborted();
      let mode: number | undefined;
      try {
        mode = (await workspace.computer.fs.stat(parsed.path)).mode;
      } catch (error) {
        options.abortSignal?.throwIfAborted();
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      options.abortSignal?.throwIfAborted();
      // Once the write lands it is the outcome, even if a stop arrived while it did: reporting it as
      // stopped would tell the model a change on disk was never made.
      await workspace.computer.fs.writeFile(parsed.path, bytes, mode === undefined ? undefined : { mode });
      return { path: parsed.path, bytesWritten: bytes.byteLength };
    },
  };
}

type ExecToolReport = {
  command: string;
  cwd: string | null;
  backend: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  streamTruncated?: boolean;
  /** The command left the project over its limits: what is over, and how to get back within them. */
  workspaceLimits?: string;
  error?: string;
};

/**
 * The steer toward `ls`/`grep` is what makes the VFS discovery tools pay for themselves. Left to
 * a bare "runs a shell command", the model falls back on shell habit and every `ls`/`find`/`grep`
 * becomes a container round trip — or a cold container start — for an answer the Durable Object
 * already holds.
 */
const EXEC_TOOL_DESCRIPTION =
  'Run a shell command in the project workspace using its Cloudflare Container. Starting the ' +
  'container and syncing its filesystem costs far more than a workspace read, so do not shell ' +
  'out to discover the project: use ls instead of ls/find, and grep instead of grep/rg. Reach ' +
  'for exec when a command has to actually run — installing, building, testing, or inspecting ' +
  'anything the durable workspace index does not hold.\n\n' +
  COMPUTER_EXEC_APPLICATION_POLICY;

/**
 * The one canonical validation entry point. Deployment and preview recognize exactly this
 * validation, so a dedicated tool keeps the model from approximating it with separate typecheck,
 * lint, and build commands that leave the revision green but unrecognized.
 *
 * Only the model-facing schema and description live here: the composed Computer tool runs the
 * validation itself, through the workspace coordinator.
 */
function canonicalValidationTool(linked: boolean): Tool {
  return {
    description: linked
      ? "Install dependencies and run the repository's own checks (its typecheck, lint, test, and build scripts, " +
        'whichever it has), reporting each failure.'
      : 'Install dependencies and run the full project validation: typecheck, lint, stack verification, and the ' +
        'production build, reporting each failure. It is the same build the hosted preview and deployment use, so a ' +
        'passing run of the current revision is reused when it publishes.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.validate,
  };
}

function streamingExecTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description: EXEC_TOOL_DESCRIPTION,
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.exec,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.exec.parse(input);
      options.abortSignal?.throwIfAborted();
      const result = await workspace.executeCommand({
        command: parsed.command,
        cwd: parsed.cwd,
        onUpdate: options.onUpdate,
        abortSignal: options.abortSignal,
      });
      // A stop mid-run rejects the command above; a result here is a command that ran to completion.
      const report: ExecToolReport = {
        command: parsed.command,
        cwd: parsed.cwd ?? null,
        backend: COMPUTER_DEFAULT_SHELL_BACKEND,
        ...result,
      };
      if (result.exitCode !== 0) {
        report.error = `Command exited with code ${result.exitCode}.`;
      }
      return report;
    },
  };
}

function lineAnchoredEditTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description:
      'Edit one existing file. The base tag must come from the latest read or successful edit; every operation addresses that same original snapshot, and operations must not overlap. ' +
      'Prefer {oldText,newText} for small changes: oldText is copied exactly from the file, without the "N:" line-number prefixes, and must occur exactly once. ' +
      '{startLine,endLine,content} replaces original lines startLine through endLine inclusive, so content must restate every line in that range you mean to keep; {afterLine,content} inserts without removing anything. ' +
      'The result diff shows each changed region (removed lines under their original numbers, added lines and context under the new ones). Check it for a line removed by accident, and fix any reported bracket imbalance before moving on.',
    inputSchema: lineEditToolParameters,
    execute: async (input, options) => {
      const parsed: LineEditToolInput = lineEditToolParameters.parse(input);
      if (isBuilderSkillPath(parsed.path)) {
        throw new Error(`Skill files are read-only: ${parsed.path}`);
      }
      options.abortSignal?.throwIfAborted();
      const before = await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
      const liveBase = lineEditBaseTag(before.sha256);
      if (parsed.base !== liveBase) {
        throw new Error(
          `Edit rejected because ${parsed.path} changed after it was read. Read the file again and use its current base tag.`,
        );
      }
      const applied = applyLineEdits(before.content, parsed.edits);
      const mutationRejection = rejectedWorkspaceFileMutation(parsed.path, applied.content);
      if (mutationRejection) {
        return { path: parsed.path, error: mutationRejection };
      }
      // The edited file is bounded like a write: an edit is not a way around the write cap.
      const bytes = new TextEncoder().encode(applied.content);
      if (bytes.byteLength > COMPUTER_TOOL_LIMITS.mutationMaxBytes) {
        return {
          path: parsed.path,
          error: `Edit rejected: the edited file would be ${bytes.byteLength} bytes, over the ${COMPUTER_TOOL_LIMITS.mutationMaxBytes}-byte file cap. Split the file into smaller modules instead.`,
        };
      }
      options.abortSignal?.throwIfAborted();
      await workspace.computer.fs.writeFile(parsed.path, bytes);
      const after = await editedFile(workspace, parsed.path, applied.content, options.abortSignal);
      const result: LineEditToolResult = {
        path: after.path,
        base: lineEditBaseTag(after.sha256),
        editsApplied: applied.editsApplied,
        firstChangedLine: applied.firstChangedLine,
        // Numbered exactly as the next read will number them.
        totalLines: logicalLines(after.content).length,
        diff: applied.diff,
      };
      if (applied.bracketImbalance.length > 0 && BRACKETED_SOURCE_PATH.test(parsed.path)) {
        result.warning = `The edit was applied, but the file now has ${applied.bracketImbalance.join('; ')}. Check the diff and fix it if that was not intended.`;
      }
      return result;
    },
  };
}

/**
 * The file an edit left, read back so the next base tag is the workspace's own. Once the write has
 * landed a stop must not turn the edit into a failure, so a stopped edit is described from the
 * content it wrote instead of the read.
 */
async function editedFile(
  workspace: BuilderWorkspaceApi,
  path: string,
  content: string,
  abortSignal: AbortSignal | undefined,
): Promise<{ path: string; content: string; sha256: string }> {
  if (!abortSignal?.aborted) {
    try {
      return await workspace.readText(path, abortSignal);
    } catch (error) {
      if (!abortSignal?.aborted) {
        throw error;
      }
    }
  }
  return { path, content, sha256: await sha256Hex(content) };
}

type LineEditToolResult = {
  path: string;
  base: string;
  editsApplied: number;
  firstChangedLine: number;
  totalLines: number;
  diff: string;
  warning?: string;
};

/** Files whose brackets must balance, where an edit that changes the balance is worth flagging. */
const BRACKETED_SOURCE_PATH = /\.(?:[cm]?[jt]sx?|json|jsonc|css|scss|vue|svelte|astro)$/i;

function computerWorkspaceTool(
  toolName: WorkspaceToolName,
  definition: Tool,
  workspace: BuilderWorkspaceApi,
  context: BuilderOperationContext,
  coordinateStatefulTool: TurnStatefulToolCoordinator,
): Tool {
  return {
    ...definition,
    execute: async (input, options) => {
      options.abortSignal?.throwIfAborted();
      return coordinateStatefulTool(toolName, async () => {
        options.abortSignal?.throwIfAborted();

        if (toolName === 'validate') {
          const validation = await validateWorkspace(workspace, context, options.toolCallId, options.abortSignal);
          return { validation };
        }

        if (toolName === 'exec' && isExecInput(input)) {
          if (isFullValidationCommand(input.command)) {
            const validation = await validateWorkspace(workspace, context, options.toolCallId, options.abortSignal);
            return { command: input.command, validation };
          }
          const rejection = rejectedWorkspaceCommand(input.command);
          if (rejection) {
            return { command: input.command, error: rejection };
          }
        }

        let result: unknown;
        try {
          if (!definition.execute) {
            throw new Error(`${toolName} is not executable.`);
          }

          const dependencyCommand =
            toolName === 'exec' && isExecInput(input) ? parseDependencyCommand(input.command) : null;
          if (dependencyCommand) {
            options.abortSignal?.throwIfAborted();
            const installRequest: Parameters<BuilderWorkspaceApi['installDependencies']>[0] = {
              toolCallId: options.toolCallId,
              input,
              mode: dependencyCommand.mode,
              packages: dependencyCommand.packages,
            };
            if (options.abortSignal) {
              installRequest.abortSignal = options.abortSignal;
            }
            result = await workspace.installDependencies(installRequest);
          } else {
            // A VFS read has nothing to journal: it commits no revision, so there is no
            // at-most-once outcome for a retry to adopt and no lane for it to wait behind.
            result = isWorkspaceReadOnlyToolName(toolName)
              ? await definition.execute(input, options)
              : await workspace.executeToolOnce(
                  options.toolCallId,
                  toolName,
                  input,
                  async () => {
                    options.abortSignal?.throwIfAborted();
                    return definition.execute!(input, options);
                  },
                  options.abortSignal,
                );
          }
          // A tool that returned finished its work: a stop that arrived meanwhile does not undo it.
        } catch (error) {
          if (isWorkspaceToolOperationIndeterminateError(error)) {
            throw error;
          }
          options.abortSignal?.throwIfAborted();
          const syncResult = computerSyncUnconfirmedToolResult(error);
          result =
            syncResult ??
            (error instanceof Error
              ? {
                  error:
                    error.message.length <= 4_000
                      ? error.message
                      : `${toolName} failed; its unusually large internal error was omitted from the model response.`,
                }
              : isRecord(error)
                ? error
                : { error: String(error) });
        }

        return result;
      });
    },
  };
}

async function validateWorkspace(
  workspace: BuilderWorkspaceApi,
  context: BuilderOperationContext,
  toolCallId: string,
  abortSignal?: AbortSignal,
) {
  abortSignal?.throwIfAborted();
  const validationToolCallId = await derivedValidationToolCallId(toolCallId);
  context.onValidationStage?.(toolCallId, 'computer validation');
  try {
    return await workspace.validate({
      toolCallId: validationToolCallId,
      input: {},
      abortSignal,
      // The workspace refines the stage as it walks the pipeline; until it does, the honest answer
      // is the one already published above.
      onStage: (stage) => context.onValidationStage?.(toolCallId, stage),
    });
  } catch (error) {
    if (isWorkspaceToolOperationIndeterminateError(error)) {
      throw error;
    }
    abortSignal?.throwIfAborted();
    return toolFailure(error instanceof Error ? error.message : String(error));
  } finally {
    context.onValidationStage?.(toolCallId, null);
  }
}

async function derivedValidationToolCallId(toolCallId: string): Promise<string> {
  if (toolCallId.length <= 501) {
    return `${toolCallId}:validation`;
  }
  return `validation:${await sha256Hex(toolCallId)}`;
}

function isExecInput(input: unknown): input is { command: string } {
  return isRecord(input) && typeof input.command === 'string';
}

function isFullValidationCommand(command: string): boolean {
  return /^(?:cd\s+\/home\/project\s*&&\s*)?pnpm\s+run\s+validate(?:\s+2>&1)?$/.test(command.trim());
}

function isMissingFileError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (error.code === 'ENOENT') {
    return true;
  }
  return typeof error.message === 'string' && /ENOENT|no such file/i.test(error.message);
}

export function createTurnStatefulToolCoordinator(
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>,
): TurnStatefulToolCoordinator {
  let tail = Promise.resolve();
  return (toolName, operation) => {
    // Read-only workspace tools are served from DO SQLite. Serializing them behind the mutation
    // queue would make discovery wait on the very container round trip it exists to avoid.
    if (isWorkspaceReadOnlyToolName(toolName)) {
      return operation();
    }
    const scheduled = tail.then(() => runWithKeepAlive(operation));
    tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };
}
