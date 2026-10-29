import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { MODEL_TOOL_INPUT_SCHEMAS, MODEL_TOOL_NAMES } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';
import {
  BUILDER_TOOL_DEADLINES_MS,
  BUILDER_TOOL_STOP_GRACE_MS,
  BuilderToolDeadlineError,
  BuilderToolUnsettledError,
} from './builder-turn-limits';
import { builderToolResult, createBuilderTools, runWithDeadline } from './builder-tools';

const call = { callId: 'call-1', details: vi.fn() };

function tool(execute: NonNullable<Tool['execute']>, name: keyof typeof MODEL_TOOL_INPUT_SCHEMAS = 'write'): Tool {
  return { description: name, inputSchema: MODEL_TOOL_INPUT_SCHEMAS[name], execute };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the deadline of a builder tool call', () => {
  it.each(MODEL_TOOL_NAMES)('stops %s at its deadline with the typed builder timeout error', async (name) => {
    vi.useFakeTimers();
    let executionSignal: AbortSignal | undefined;
    const hung = tool(
      async (_input, options) =>
        new Promise((_resolve, reject) => {
          executionSignal = options.abortSignal;
          executionSignal?.addEventListener('abort', () => reject(executionSignal?.reason), { once: true });
        }),
      name,
    );
    let rejection: unknown;
    const execution = runWithDeadline(name, hung, {}, call, undefined).catch((error: Error) => {
      rejection = error;
    });

    await vi.advanceTimersByTimeAsync(BUILDER_TOOL_DEADLINES_MS[name] - 1);
    expect(rejection).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await execution;
    expect(rejection).toBeInstanceOf(BuilderToolDeadlineError);
    expect(executionSignal?.reason).toBe(rejection);
  });

  it('keeps an indeterminate settlement found after the deadline, so the run stops on it', async () => {
    vi.useFakeTimers();
    const indeterminate = Object.assign(new Error('workspace outcome is indeterminate'), {
      code: 'workspace_tool_operation_indeterminate',
    });
    const execution = runWithDeadline(
      'write',
      tool(
        async (_input, options) =>
          new Promise((_resolve, reject) => {
            options.abortSignal?.addEventListener('abort', () => reject(indeterminate), { once: true });
          }),
      ),
      {},
      call,
      undefined,
    );
    const rejection = expect(execution).rejects.toBe(indeterminate);
    await vi.advanceTimersByTimeAsync(BUILDER_TOOL_DEADLINES_MS.write);
    await rejection;
  });

  it('reports a write that landed as its deadline passed as the write, not as stopped', async () => {
    vi.useFakeTimers();
    const landed = { path: '/home/project/src/app.ts', bytesWritten: 7 };
    const execution = runWithDeadline(
      'write',
      tool(
        async (_input, options) =>
          new Promise((resolve) => {
            options.abortSignal?.addEventListener('abort', () => resolve(landed), { once: true });
          }),
      ),
      {},
      call,
      undefined,
    );
    const outcome = expect(execution).resolves.toEqual(landed);
    await vi.advanceTimersByTimeAsync(BUILDER_TOOL_DEADLINES_MS.write);
    await outcome;
  });

  it('ends the call of a tool that ignores its deadline, saying its outcome is unknown', async () => {
    vi.useFakeTimers();
    let rejection: unknown;
    const execution = runWithDeadline(
      'exec',
      tool(async () => new Promise(() => undefined), 'exec'),
      {},
      call,
      undefined,
    ).catch((error: Error) => {
      rejection = error;
    });

    await vi.advanceTimersByTimeAsync(BUILDER_TOOL_DEADLINES_MS.exec + BUILDER_TOOL_STOP_GRACE_MS - 1);
    expect(rejection).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await execution;
    expect(rejection).toBeInstanceOf(BuilderToolUnsettledError);
  });

  it("passes a running command's output to the chat as the call's details", async () => {
    const details = vi.fn();
    await runWithDeadline(
      'exec',
      tool(async (_input, options) => {
        options.onUpdate?.({ stdout: 'installing' });
        return { exitCode: 0 };
      }, 'exec'),
      {},
      { callId: 'call-2', details },
      undefined,
    );
    expect(details).toHaveBeenCalledWith({ stdout: 'installing' });
  });
});

describe('a builder tool result', () => {
  it('is JSON for the model and the structured result for the chat, an error when it reports a failure', () => {
    expect(builderToolResult({ command: 'ls', exitCode: 0 })).toEqual({
      output: [{ type: 'text', text: '{"command":"ls","exitCode":0}' }],
      details: { command: 'ls', exitCode: 0 },
    });
    expect(builderToolResult({ command: 'ls', exitCode: 2 })).toMatchObject({ isError: true });
    expect(builderToolResult({ error: 'No such file' })).toMatchObject({ isError: true });
  });
});

describe('the four builder tools in a pi-durable run', () => {
  it('offers the model exactly read, write, edit and exec, and runs a call it makes', async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let offered: string[] = [];
    faux.setResponses([
      (context) => {
        // Pi declares the tools in the transcript's system messages, as they become available.
        offered = context.messages.flatMap((message) =>
          message.role === 'system' ? (message.toolsAdded ?? []).map((offeredTool) => offeredTool.name) : [],
        );
        return fauxAssistantMessage(fauxToolCall('read', { path: '/home/project/README.md' }, { id: 'read-1' }), {
          stopReason: 'toolUse',
        });
      },
      fauxAssistantMessage('It says Hello.'),
    ]);
    const registry = createRegistry();
    registry.install({
      name: 'cloudchef',
      tools: createBuilderTools({
        read: tool(async (input) => ({ read: input, content: 'Hello' }), 'read'),
        write: tool(async () => ({ ok: true }), 'write'),
        edit: tool(async () => ({ ok: true }), 'edit'),
        exec: tool(async () => ({ exitCode: 0 }), 'exec'),
      }),
    });
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
    });

    const submission = await root.submit({ type: 'input', content: 'What does the README say?' }, BACKGROUND_CONTEXT);
    const settled = await submission.wait(BACKGROUND_CONTEXT);
    const { entries } = await root.context(BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);

    expect(settled.status).toBe('done');
    expect(offered).toEqual(['read', 'write', 'edit', 'exec']);
    const result = entries.find((entry) => entry.kind === 'pi.tool-result')?.model?.[0];
    expect(result).toMatchObject({
      role: 'toolResult',
      toolCallId: 'read-1',
      isError: false,
      details: { read: { path: '/home/project/README.md' }, content: 'Hello' },
    });
  });
});
