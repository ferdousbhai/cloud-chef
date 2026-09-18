import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { z, ZodType } from 'zod';
import { MODEL_TOOL_NAMES, type ModelToolName } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';
import { isWorkspaceToolOperationIndeterminateError, type BuilderWorkspaceApi } from '~/agents/builder-workspace-api';
import type { BuilderValidationStage } from '~/lib/common/builder-validation-progress';
import type { BuilderSkillReader } from './builder-skills';
import { BUILDER_TURN_TIMEOUTS, BuilderTurnBudgetExceededError } from './builder-turn-budget';
import { createWorkersAiTools } from './workers-ai-tools';
import type { CloudflareMcpModelToolContext } from './cloudflare-mcp-model-tools';

type BuilderOperationContext = {
  onValidationStage?: (toolCallId: string, stage: BuilderValidationStage | null) => void;
  runWithKeepAlive: <T>(operation: () => Promise<T>) => Promise<T>;
};

const toolLabels = {
  read: 'Read file',
  ls: 'List files',
  grep: 'Search files',
  write: 'Write file',
  edit: 'Edit file',
  exec: 'Run command',
  validate: 'Validate project',
  search_cloudflare_docs: 'Search Cloudflare docs',
  cloudflare_docs: 'Search Cloudflare MCP docs',
  cloudflare_search: 'Search Cloudflare account',
  cloudflare_execute: 'Propose Cloudflare change',
} satisfies Record<ModelToolName, string>;

/** Adapt the canonical model tools to Pi's validated tool contract. */
export function createPiToolBundle(
  workspace: BuilderWorkspaceApi,
  operationContext: BuilderOperationContext,
  skillReader?: BuilderSkillReader,
  cloudflareMcp?: CloudflareMcpModelToolContext,
): Record<string, AgentTool> {
  const canonicalTools = createWorkersAiTools(workspace, operationContext, skillReader, cloudflareMcp);
  const tools: Record<string, AgentTool> = Object.fromEntries(
    MODEL_TOOL_NAMES.flatMap((name) => {
      const definition = canonicalTools[name];
      return definition ? [[name, adaptTool(name, definition, toolLabels[name])]] : [];
    }),
  );
  return tools;
}

function adaptTool(name: ModelToolName, definition: Tool, label: string): AgentTool {
  const { inputSchema } = definition;
  if (!(inputSchema instanceof ZodType)) {
    throw new Error(`${name} does not define an input schema.`);
  }
  return {
    name,
    label,
    description: definition.description ?? name,
    parameters: z.toJSONSchema(inputSchema, {
      io: 'input',
      target: 'draft-07',
      unrepresentable: 'throw',
    }),
    execute: async (toolCallId, rawInput, signal, onUpdate) => {
      signal?.throwIfAborted();
      const parsed = await inputSchema.safeParseAsync(rawInput);
      if (!parsed.success) {
        throw new Error(`Invalid tool input for "${name}": ${parsed.error.message}`, { cause: parsed.error });
      }
      signal?.throwIfAborted();
      if (!definition.execute) {
        throw new Error(`${name} is not executable.`);
      }

      const timeoutController = new AbortController();
      const timeout = setTimeout(
        () => timeoutController.abort(new BuilderTurnBudgetExceededError('tool_timeout')),
        BUILDER_TURN_TIMEOUTS.tools[name],
      );
      const executionSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
      let updatesOpen = true;
      try {
        const result = await definition.execute(parsed.data, {
          toolCallId,
          abortSignal: executionSignal,
          onUpdate: onUpdate
            ? (partialResult) => {
                if (updatesOpen) {
                  executionSignal.throwIfAborted();
                  onUpdate(toPiToolResult(partialResult));
                }
              }
            : undefined,
        });
        executionSignal.throwIfAborted();
        return toPiToolResult(result);
      } catch (error) {
        if (executionSignal.aborted && !isWorkspaceToolOperationIndeterminateError(error)) {
          executionSignal.throwIfAborted();
        }
        throw error;
      } finally {
        updatesOpen = false;
        clearTimeout(timeout);
      }
    },
  };
}

function toPiToolResult(result: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: stringifyToolResult(result) }],
    details: result,
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    try {
      return String(result);
    } catch {
      return '[Unserializable tool result]';
    }
  }
}
