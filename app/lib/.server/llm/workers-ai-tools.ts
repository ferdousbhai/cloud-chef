import {
  COMPUTER_DEFAULT_SHELL_BACKEND,
  COMPUTER_EXEC_APPLICATION_POLICY,
  COMPUTER_TOOL_LIMITS,
  computerSyncUnconfirmedToolResult,
} from 'cloudchef-agent/cloudflare-computer';
import type { CloudChefToolSet } from 'cloudchef-agent/types';
import { readFileLines, replaceText } from 'cloudchef-agent/file-edit';
import {
  isWorkspaceReadOnlyToolName,
  MODEL_TOOL_INPUT_SCHEMAS,
  MODEL_TOOL_NAMES,
  type ModelToolName,
} from 'cloudchef-agent/model-tool-inputs';
import { parseDependencyCommand } from 'cloudchef-agent/tools/dependency-command';
import { rejectedWorkspaceCommand } from 'cloudchef-agent/workspace-boundary';
import { toolFailure, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { isWorkspaceToolOperationIndeterminateError, type BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { Tool } from 'cloudchef-agent/tool';
import { type BuilderSkillReader, isBuilderSkillPath } from './builder-skills';
import { sha256Hex } from '~/lib/hex-digest';
import type { CloudflareCommandChange } from 'cloudchef-agent/cloudflare-api';
import { VALIDATE_COMMAND } from 'cloudchef-agent/constants';
import { isRecord } from 'cloudchef-agent/utils/isRecord';

/** What a builder turn lends its workspace tools: validation progress, and keeping the turn alive while one runs. */
export type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  /**
   * What a finished command pushed to the project's repository, as a publish reports it (its build followed
   * in the background, like a publish's), or nothing when it pushed nothing the chat shows.
   */
  pushResult?: (toolCallId: string) => Promise<CloudChefToolResult | undefined>;
  /**
   * Settles the Cloudflare changes the ended command asked for, given for its output: one still waiting for the
   * person stays waiting in the chat when the command finished (withdrawn when it was stopped), and those filed for
   * a team's admins are given too; what is decided later replaces each in the output.
   */
  cloudflareChanges?: (toolCallId: string, ended: 'finished' | 'stopped') => Promise<CloudflareCommandChange[]>;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
};

type TurnStatefulToolCoordinator = <T>(toolName: string, operation: () => Promise<T>) => Promise<T>;

export function createWorkersAiTools(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
  skillReader: BuilderSkillReader,
): CloudChefToolSet {
  const coordinateStatefulTool = createTurnStatefulToolCoordinator(operationContext.runWithKeepAlive);
  const tools: CloudChefToolSet = {
    read: fileReadTool(workspace, skillReader),
    write: abortAwareWriteTool(workspace),
    edit: fileEditTool(workspace),
    exec: streamingExecTool(workspace, operationContext),
  };
  for (const toolName of MODEL_TOOL_NAMES) {
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

function fileReadTool(workspace: BuilderWorkspaceApi, skillReader: BuilderSkillReader): Tool {
  return {
    description:
      'Read a UTF-8 project file, or a read-only /__skills__/ reference file, as text from line offset (1-based). Output is bounded; when truncated is true, continue from nextOffset.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.read,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.read.parse(input);
      options.abortSignal?.throwIfAborted();
      const skillResult = isBuilderSkillPath(parsed.path) ? await skillReader.read(parsed.path) : null;
      if (isBuilderSkillPath(parsed.path) && !skillResult) {
        throw new Error(`Skill reference not found: ${parsed.path}`);
      }
      const file = skillResult
        ? { path: parsed.path, content: skillResult.content }
        : await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
      return readFileLines({
        path: file.path,
        content: file.content,
        offset: parsed.offset,
        limit: parsed.limit,
        maxLines: COMPUTER_TOOL_LIMITS.readMaxLines,
        maxBytes: COMPUTER_TOOL_LIMITS.readMaxBytes,
      });
    },
  };
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
      const bytes = new TextEncoder().encode(parsed.content);
      if (bytes.byteLength > COMPUTER_TOOL_LIMITS.mutationMaxBytes) {
        return {
          error: `Content too large: ${bytes.byteLength} bytes exceeds the ${COMPUTER_TOOL_LIMITS.mutationMaxBytes}-byte file cap.`,
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
  /** What the command pushed to the project's repository, and its build: the chat shows it as a publish. */
  push?: CloudChefToolResult;
  /**
   * The changes to the Cloudflare account the command ended without: left waiting in the chat for the person, or
   * filed for a team's admins, then what was decided.
   */
  cloudflareChanges?: CloudflareCommandChange[];
};

const EXEC_TOOL_DESCRIPTION =
  'Run a shell command in the project workspace using its Cloudflare Container. ' +
  `\`${VALIDATE_COMMAND}\`, run as a command of its own, installs dependencies and runs the project's full ` +
  'checks and production build, reporting each failure; a passing run of the current version is reused when ' +
  'it publishes.\n\n' +
  COMPUTER_EXEC_APPLICATION_POLICY;

function streamingExecTool(workspace: BuilderWorkspaceApi, context: BuilderOperationContext): Tool {
  return {
    description: EXEC_TOOL_DESCRIPTION,
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.exec,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.exec.parse(input);
      options.abortSignal?.throwIfAborted();
      let result: Awaited<ReturnType<BuilderWorkspaceApi['executeCommand']>>;
      try {
        result = await workspace.executeCommand({
          command: parsed.command,
          cwd: parsed.cwd,
          onUpdate: options.onUpdate,
          abortSignal: options.abortSignal,
        });
      } catch (error) {
        // A command that stopped leaves no change `cf` still waited for: nothing would read its answer.
        await context.cloudflareChanges?.(options.toolCallId, 'stopped').catch(() => undefined);
        throw error;
      }
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
      const push = await context.pushResult?.(options.toolCallId);
      if (push) {
        report.push = push;
      }
      const cloudflareChanges = (await context.cloudflareChanges?.(options.toolCallId, 'finished')) ?? [];
      if (cloudflareChanges.length > 0) {
        report.cloudflareChanges = cloudflareChanges;
      }
      return report;
    },
  };
}

function fileEditTool(workspace: BuilderWorkspaceApi): Tool {
  return {
    description:
      'Replace exact text in one existing file. old_string must occur exactly once unless replace_all is set, which replaces every occurrence.',
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.edit,
    execute: async (input, options) => {
      const parsed = MODEL_TOOL_INPUT_SCHEMAS.edit.parse(input);
      if (isBuilderSkillPath(parsed.path)) {
        throw new Error(`Skill files are read-only: ${parsed.path}`);
      }
      options.abortSignal?.throwIfAborted();
      const before = await workspace.readText(parsed.path, options.abortSignal);
      options.abortSignal?.throwIfAborted();
      const edited = replaceText(before.content, parsed.old_string, parsed.new_string, parsed.replace_all);
      // The edited file is bounded like a write: an edit is not a way around the write cap.
      const bytes = new TextEncoder().encode(edited.content);
      if (bytes.byteLength > COMPUTER_TOOL_LIMITS.mutationMaxBytes) {
        return {
          path: parsed.path,
          error: `Edit rejected: the edited file would be ${bytes.byteLength} bytes, over the ${COMPUTER_TOOL_LIMITS.mutationMaxBytes}-byte file cap.`,
        };
      }
      options.abortSignal?.throwIfAborted();
      await workspace.computer.fs.writeFile(parsed.path, bytes);
      return { path: before.path, replacements: edited.replacements };
    },
  };
}

function computerWorkspaceTool(
  toolName: ModelToolName,
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

        if (toolName === 'exec' && isExecInput(input)) {
          if (input.command.trim() === VALIDATE_COMMAND) {
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
