import { copyJson, type JsonValue } from '@earendil-works/chord';
import type { ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { z, ZodType } from 'zod';
import { MODEL_TOOL_NAMES, type ModelToolName } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';
import { toolResultSucceeded } from 'cloudchef-agent/tool-result';
import type { CloudChefToolSet } from 'cloudchef-agent/types';
import {
  isWorkspaceToolOperationIndeterminateError,
  WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE,
} from '~/agents/builder-workspace-api';
import {
  BUILDER_TOOL_DEADLINES_MS,
  BUILDER_TOOL_STOP_GRACE_MS,
  BuilderToolDeadlineError,
  BuilderToolUnsettledError,
} from './builder-turn-limits';

/**
 * The builder's four tools, `read`, `write`, `edit` and `exec` (`createWorkersAiTools`), as pi-durable tools. Each call is its own durable
 * task: its intent is stored before it runs, and one a restart cut off reports `interrupted` to the model rather than
 * running again, except `read`, which changes nothing and simply runs again.
 */
export function createBuilderTools(canonicalTools: CloudChefToolSet): ToolRegistration[] {
  return MODEL_TOOL_NAMES.map((name) => builderTool(name, canonicalTools[name]));
}

function builderTool(name: ModelToolName, definition: Tool): ToolRegistration {
  const { inputSchema } = definition;
  if (!(inputSchema instanceof ZodType)) {
    throw new Error(`${name} does not define an input schema.`);
  }
  return {
    name,
    description: definition.description ?? name,
    parameters: z.toJSONSchema(inputSchema, { io: 'input', target: 'draft-07', unrepresentable: 'throw' }),
    replay: name === 'read' ? 'safe' : 'unsafe',
    execute: async (args, api, context) => {
      const parsed = await inputSchema.safeParseAsync(args);
      if (!parsed.success) {
        throw new Error(`Invalid tool input for "${name}": ${parsed.error.message}`, { cause: parsed.error });
      }
      try {
        return builderToolResult(
          await runWithDeadline(
            name,
            definition,
            copyJson(parsed.data, { omitUndefinedProperties: true }),
            {
              callId: api.callId,
              // Running details are for the chat only; a details write that fails leaves the call running.
              details: (value) => void api.details(value, context).catch(() => undefined),
            },
            context.abortSignal,
          ),
        );
      } catch (error) {
        if (isWorkspaceToolOperationIndeterminateError(error)) {
          // What the workspace did is unknown: the run stops here rather than build on a guess.
          return {
            isError: true,
            output: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: WORKSPACE_TOOL_OPERATION_INDETERMINATE_CODE,
                  error: error instanceof Error ? error.message : String(error),
                }),
              },
            ],
            control: { terminate: true },
          };
        }
        throw error;
      }
    },
  };
}

/**
 * Runs one call within its tool's deadline. A stopped tool gets a bounded moment to settle; one that ignores its
 * signal ends the call without it instead of holding the run.
 */
export async function runWithDeadline(
  name: ModelToolName,
  definition: Tool,
  input: JsonValue,
  call: { callId: string; details: (value: JsonValue) => void },
  signal: AbortSignal | undefined,
): Promise<JsonValue> {
  const execute = definition.execute;
  if (!execute) {
    throw new Error(`${name} is not executable.`);
  }
  signal?.throwIfAborted();
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new BuilderToolDeadlineError(name)),
    BUILDER_TOOL_DEADLINES_MS[name],
  );
  const executionSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let updatesOpen = true;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const unsettled = new Promise<never>((_resolve, reject) => {
    executionSignal.addEventListener(
      'abort',
      () => {
        if (updatesOpen) {
          giveUp = setTimeout(() => reject(new BuilderToolUnsettledError(name)), BUILDER_TOOL_STOP_GRACE_MS);
        }
      },
      { once: true },
    );
  });
  // The deadline's rejection is what ends a stopped call; nothing else awaits this one.
  unsettled.catch(() => undefined);
  try {
    const execution = execute(input, {
      toolCallId: call.callId,
      abortSignal: executionSignal,
      onUpdate: (partialResult) => {
        if (updatesOpen && !executionSignal.aborted) {
          call.details(copyJson(JSON.parse(JSON.stringify(partialResult) ?? 'null')));
        }
      },
    });
    // A result that completed is the tool's outcome, even when its deadline passed while it returned: a write
    // that landed must not be reported as stopped.
    const result = await Promise.race([execution, unsettled]);
    // The canonical tools answer JSON; what isn't is kept as its JSON text.
    return copyJson(JSON.parse(JSON.stringify(result) ?? 'null'), { omitUndefinedProperties: true });
  } catch (error) {
    if (
      executionSignal.aborted &&
      !(error instanceof BuilderToolUnsettledError) &&
      !isWorkspaceToolOperationIndeterminateError(error)
    ) {
      executionSignal.throwIfAborted();
    }
    throw error;
  } finally {
    updatesOpen = false;
    clearTimeout(timeout);
    clearTimeout(giveUp);
  }
}

/**
 * A finished call as the model and the chat see it: the model reads the result as JSON text, and the chat shows the
 * structured result itself. A result that reports a failure is an error result.
 */
export function builderToolResult(details: JsonValue): ToolExecutionResult {
  const text = z.string().safeParse(details).data ?? JSON.stringify(details);
  const output: ToolExecutionResult['output'] = [{ type: 'text', text }];
  return toolResultSucceeded(details) ? { output, details } : { output, details, isError: true };
}
