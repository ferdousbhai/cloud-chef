import { getToolInvocation, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  COMPUTER_AI_TOOL_OPTIONS,
  COMPUTER_DEFAULT_SHELL_BACKEND,
  COMPUTER_EXEC_APPLICATION_POLICY,
  computerSyncUnconfirmedToolResult,
} from 'ghostbuild-agent/cloudflare-computer';
import type { GhostbuildToolSet } from 'ghostbuild-agent/types';
import {
  applyLineEdits,
  lineAnchoredRead,
  lineEditBaseTag,
  lineEditToolParameters,
  type LineEditToolInput,
} from 'ghostbuild-agent/line-edit';
import {
  isWorkspaceReadOnlyToolName,
  MODEL_TOOL_INPUT_SCHEMAS,
  WORKSPACE_TOOL_NAMES,
  type WorkspaceToolName,
} from 'ghostbuild-agent/model-tool-inputs';
import { parseNpmInstallCommand } from 'ghostbuild-agent/tools/npmInstall';
import { rejectedWorkspaceCommand, rejectedWorkspaceFileMutation } from 'ghostbuild-agent/workspace-boundary';
import { isGhostbuildToolResult, toolFailure } from 'ghostbuild-agent/tool-result';
import { isWorkspaceToolOperationIndeterminateError, type BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { Tool } from 'ghostbuild-agent/tool';
import { type BuilderSkillReader, isBuilderSkillPath } from './builder-skills';
import { cloudflareDocsSearchTool } from './cloudflare-docs-search';
import { sha256Hex } from '~/lib/hex-digest';
import type { CloudflareMcpModelToolContext } from './cloudflare-mcp-model-tools';

type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
};

type ToolResultEvent = {
  toolName: string;
  result: unknown;
};

type TurnStatefulToolCoordinator = <T>(toolName: string, operation: () => Promise<T>) => Promise<T>;

type AutoValidatedResult = Record<string, unknown> & {
  validation?: unknown;
  dependencyMutation?: boolean;
};

export function createWorkersAiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
  skillReader?: BuilderSkillReader,
  cloudflareMcp?: CloudflareMcpModelToolContext,
): GhostbuildToolSet {
  const coordinateStatefulTool = createTurnStatefulToolCoordinator(operationContext.runWithKeepAlive);
  const tools: GhostbuildToolSet = {
    read: lineAnchoredReadTool(workspace, skillReader),
    ls: projectListingTool(workspace),
    grep: projectSearchTool(workspace),
    write: abortAwareWriteTool(workspace),
    edit: lineAnchoredEditTool(workspace),
    exec: streamingExecTool(workspace),
    validate: canonicalValidationTool(),
    // Stateless and remote: it must not take the workspace operation lane.
    search_cloudflare_docs: cloudflareDocsSearchTool(),
  };

  if (cloudflareMcp) {
    tools.cloudflare_docs = {
      description:
        'Search the official Cloudflare MCP documentation. Use this before generating API code. The authenticated account is fixed by Ghostbuild and cannot be supplied by the model.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.cloudflare_docs,
      execute: async (input, options) =>
        cloudflareMcp.docs(MODEL_TOOL_INPUT_SCHEMAS.cloudflare_docs.parse(input), options),
    };
    tools.cloudflare_search = {
      description:
        'Search the authenticated Cloudflare account with read-only API code. Use it to inspect current state and reconcile mutations. Missing OAuth scopes are reported as tool results.',
      inputSchema: MODEL_TOOL_INPUT_SCHEMAS.cloudflare_search,
      execute: async (input, options) =>
        cloudflareMcp.search(MODEL_TOOL_INPUT_SCHEMAS.cloudflare_search.parse(input), options),
    };
    if (cloudflareMcp.executeEnabled) {
      tools.cloudflare_execute = {
        description:
          'Propose exact Cloudflare API code for explicit user approval. This call never executes the code; it creates a durable, expiring approval bound to this account, connection, transcript, and exact digest. Use the specialized deployment flow for application deployment.',
        inputSchema: MODEL_TOOL_INPUT_SCHEMAS.cloudflare_execute,
        execute: async (input, options) =>
          cloudflareMcp.proposeExecute(MODEL_TOOL_INPUT_SCHEMAS.cloudflare_execute.parse(input), options),
      };
    }
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

function lineAnchoredReadTool(workspace: BuilderWorkspaceApi, skillReader?: BuilderSkillReader): Tool {
  return {
    description:
      'Read a UTF-8 project or /__skills__/ reference file as numbered lines. Project reads return a compact base snapshot tag required by edit. Skill files are read-only. Output is bounded; use offset and limit to continue.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.read,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.read.parse(input);
      options.abortSignal?.throwIfAborted();
      const skillResult = isBuilderSkillPath(parsed.path) ? await skillReader?.read(parsed.path) : null;
      if (skillResult) {
        return lineAnchoredRead({
          path: parsed.path,
          content: skillResult.content,
          sha256: await sha256Hex(skillResult.content),
          offset: parsed.offset,
          limit: parsed.limit,
          maxLines: COMPUTER_AI_TOOL_OPTIONS.read.maxLines,
          maxBytes: COMPUTER_AI_TOOL_OPTIONS.read.maxBytes,
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
        maxLines: COMPUTER_AI_TOOL_OPTIONS.read.maxLines,
        maxBytes: COMPUTER_AI_TOOL_OPTIONS.read.maxBytes,
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
      if (bytes.byteLength > COMPUTER_AI_TOOL_OPTIONS.write.maxBytes) {
        return {
          error: `Content too large: ${bytes.byteLength} bytes exceeds the ${COMPUTER_AI_TOOL_OPTIONS.write.maxBytes}-byte write cap. Use the edit tool for incremental changes to existing files, or split the write into smaller pieces.`,
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
      await workspace.computer.fs.writeFile(parsed.path, bytes, mode === undefined ? undefined : { mode });
      options.abortSignal?.throwIfAborted();
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
  error?: string;
};

/**
 * One exec description for both places that build one, because they drift silently otherwise —
 * the composed Computer tool overrides the streaming tool's description, so guidance added to
 * only one of them never reaches the model.
 *
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
  'anything the durable workspace index does not hold.';

/**
 * The one canonical validation entry point. Deployment and preview recognize exactly this
 * validation, so a dedicated tool keeps the model from approximating it with separate typecheck,
 * lint, and build commands that leave the revision green but unrecognized.
 *
 * Only the model-facing schema and description live here: the composed Computer tool runs the
 * validation itself, through the workspace coordinator.
 */
function canonicalValidationTool(): Tool {
  return {
    description:
      'Run the complete canonical project validation (typecheck, lint, stack verification, and production build). ' +
      'A passing run marks the exact current revision deployable; Ghostbuild then publishes the hosted preview and ' +
      'deployment automatically. Call it once after finishing changes instead of running typecheck, lint, or build ' +
      'individually.',
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
      options.abortSignal?.throwIfAborted();
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
      'Edit one existing file by replacing numbered original line ranges or inserting after an original line. The base tag must come from the latest read or successful edit. All operations address the same original snapshot and must not overlap.',
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
      options.abortSignal?.throwIfAborted();
      await workspace.computer.fs.writeFile(parsed.path, new TextEncoder().encode(applied.content));
      options.abortSignal?.throwIfAborted();
      const after = await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
      return {
        path: after.path,
        base: lineEditBaseTag(after.sha256),
        editsApplied: applied.editsApplied,
        firstChangedLine: applied.firstChangedLine,
        totalLines: countLogicalLines(after.content),
      };
    },
  };
}

function countLogicalLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n').length : normalized.split('\n').length;
}

function computerWorkspaceTool(
  toolName: WorkspaceToolName,
  definition: Tool,
  workspace: BuilderWorkspaceApi,
  context: BuilderOperationContext,
  coordinateStatefulTool: TurnStatefulToolCoordinator,
): Tool {
  return {
    ...definition,
    description:
      toolName === 'exec' ? `${EXEC_TOOL_DESCRIPTION}\n\n${COMPUTER_EXEC_APPLICATION_POLICY}` : definition.description,
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
            toolName === 'exec' && isExecInput(input) ? parseNpmInstallCommand(input.command) : null;
          if (dependencyCommand) {
            options.abortSignal?.throwIfAborted();
            const installRequest: Parameters<BuilderWorkspaceApi['installDependencies']>[0] = {
              toolCallId: options.toolCallId,
              input: { mode: dependencyCommand.mode, packages: dependencyCommand.packages.join(' ') || undefined },
              mode: dependencyCommand.mode,
              packages: dependencyCommand.packages,
            };
            if (options.abortSignal) {
              installRequest.abortSignal = options.abortSignal;
            }
            result = await workspace.installDependencies(installRequest);
            options.abortSignal?.throwIfAborted();
            result = markDependencyMutation(result);
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
                    const executionResult = await definition.execute!(input, options);
                    options.abortSignal?.throwIfAborted();
                    return executionResult;
                  },
                  options.abortSignal,
                );
          }
          options.abortSignal?.throwIfAborted();
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

function markDependencyMutation(result: unknown): AutoValidatedResult {
  return isRecord(result) ? { ...result, dependencyMutation: true } : { result, dependencyMutation: true };
}

function isExecInput(input: unknown): input is { command: string } {
  return isRecord(input) && typeof input.command === 'string';
}

function isFullValidationCommand(command: string): boolean {
  return /^(?:cd\s+\/home\/project\s*&&\s*)?pnpm\s+run\s+validate(?:\s+2>&1)?$/.test(command.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

export function getValidatedBuildCompletion(
  messages: GhostbuildMessage[],
  currentStepResults: ReadonlyArray<ToolResultEvent> = [],
): string | undefined {
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (lastUserIndex === -1) {
    return undefined;
  }

  const results = [
    ...collectToolResults(messages).filter(({ messageIndex }) => messageIndex > lastUserIndex),
    ...currentStepResults,
  ];
  const validation = latestSuccessfulValidation(results);
  if (!validation) {
    return undefined;
  }

  return 'Done. I built and validated the app. The hosted preview is publishing now, and deployment follows automatically.';
}

/** Tools whose result proves the workspace changed after whatever validated it last. */
const VALIDATION_INVALIDATING_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'edit', 'exec']);

function latestSuccessfulValidation(results: ReadonlyArray<ToolResultEvent>): unknown | undefined {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const event = results[index];
    const result = event?.result;
    if (isRecord(result) && 'validation' in result) {
      return isSuccessfulValidationResult(result.validation) ? result.validation : undefined;
    }
    // A mutation reached after the receipt means the receipt describes older content. Walking past
    // it let a pre-steering validation vouch for a post-steering write, and the turn then claimed
    // it had "built and validated the app" while deployment — which matches the validation record
    // against the current revision — shipped nothing.
    if (event && isWorkspaceMutationResult(event)) {
      return undefined;
    }
  }
  return undefined;
}

function isWorkspaceMutationResult(event: ToolResultEvent): boolean {
  return (
    VALIDATION_INVALIDATING_TOOL_NAMES.has(event.toolName) ||
    (isRecord(event.result) && event.result.dependencyMutation === true)
  );
}

function collectToolResults(messages: GhostbuildMessage[]): Array<{
  messageIndex: number;
  toolName: string;
  result: unknown;
}> {
  return messages.flatMap((message, messageIndex) =>
    message.parts.flatMap((part) => {
      const invocation = getToolInvocation(part);
      if (invocation?.state !== 'output-available') {
        return [];
      }
      return [{ messageIndex, toolName: invocation.toolName, result: invocation.output }];
    }),
  );
}

function isSuccessfulValidationResult(result: unknown): boolean {
  return (
    isGhostbuildToolResult(result) &&
    result.ok &&
    isRecord(result.data) &&
    result.data.level === 'full' &&
    typeof result.data.revision === 'string' &&
    result.data.nextAction === 'prepare-deployment'
  );
}
