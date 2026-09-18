import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext, AgentMessage } from '@earendil-works/pi-agent-core';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { PiStreamChunk } from './pi-stream';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL, type WorkersAiModelId } from '~/lib/workers-ai-model';

type UIMessageChunk = PiStreamChunk;
type RunnerEvent =
  | RunnerTurnStartEvent
  | RunnerMessageUpdateEvent
  | RunnerToolExecutionStartEvent
  | RunnerToolExecutionEndEvent
  | RunnerTurnEndEvent;
type RunnerEventSink = (event: RunnerEvent) => Promise<void>;

interface RunnerTurnStartEvent {
  type: 'turn_start';
}

interface RunnerMessageUpdateEvent {
  type: 'message_update';
  message: { timestamp: number };
  assistantMessageEvent: { type: string; contentIndex: number; delta?: string };
}

interface RunnerToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: Record<string, never>;
}

interface RunnerToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result: object;
  isError: boolean;
}

interface RunnerTurnEndEvent {
  type: 'turn_end';
  message: ReturnType<typeof assistantMessage>;
  toolResults: object[];
}

interface StopAwareLoopConfig {
  shouldStopAfterTurn(): boolean;
}

const mocks = vi.hoisted(() => ({
  completion: undefined as string | undefined,
  validateExecute: vi.fn(),
  piMessages: [] as unknown[],
  piRun: vi.fn(),
  getValidatedBuildCompletion: vi.fn(),
  prepareModelInput: vi.fn(async (options: { messages: unknown[] }) => ({
    messages: [],
    promptMessages: options.messages,
    nextCompaction: null,
    contextCompacted: false,
    estimatedTokens: 1,
  })),
  getPiModel: vi.fn(() => ({
    model: { id: 'test-workers-ai', contextWindow: 128_000, maxTokens: 1_000 },
    stream: vi.fn(),
  })),
  recordFinish: vi.fn(),
}));

vi.mock('@earendil-works/pi-agent-core', () => ({
  runAgentLoopContinue: mocks.piRun,
}));
vi.mock('./pi-ai-models', () => ({
  getPiModel: mocks.getPiModel,
}));

vi.mock('./model-input', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareModelInput: mocks.prepareModelInput,
}));
vi.mock('./pi-message-conversion', () => ({
  modelMessagesToPi: vi.fn(() => mocks.piMessages),
}));
vi.mock('./builder-skills', () => ({
  createBuilderSkillContext: vi.fn(async () => ({
    prompt: 'Bundled guidance.',
    reader: { read: vi.fn(async () => null) },
  })),
}));
vi.mock('./pi-tools-adapter', () => ({
  createPiToolBundle: vi.fn(() => ({
    write: { name: 'write', description: 'write', parameters: 'canonical-schema' },
    validate: {
      name: 'validate',
      label: 'Validate project',
      description: 'validate',
      parameters: 'canonical-schema',
      execute: mocks.validateExecute,
    },
  })),
}));
vi.mock('./workers-ai-tools', () => ({
  createWorkersAiTools: vi.fn(() => ({})),
  getValidatedBuildCompletion: mocks.getValidatedBuildCompletion,
}));
vi.mock('./workers-ai-telemetry', () => ({
  recordFirstWorkersAiResponse: vi.fn(),
  recordFirstMeaningfulWorkersAiProgress: vi.fn(),
  recordFirstBuilderMutation: vi.fn(),
  recordWorkersAiFinish: mocks.recordFinish,
}));
import { piAgentRunner } from './pi-agent-runner';
import { PiSteeringQueue } from './pi-steering';
import { BUILDER_TURN_FIRST_PROGRESS_MS, BUILDER_TURN_INACTIVITY_MS } from './builder-turn-budget';

describe('piAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completion = undefined;
    mocks.piMessages = [];
    mocks.getValidatedBuildCompletion.mockImplementation((_messages: unknown, currentStepResults: unknown[] = []) =>
      currentStepResults.length > 0 ? mocks.completion : undefined,
    );
    mocks.piRun.mockResolvedValue(undefined);
  });

  it('surfaces provider protocol failures instead of finishing an empty successful turn', async () => {
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [],
          usage: piUsage(),
          stopReason: 'error',
          errorMessage: 'upstream failed',
        },
        toolResults: [],
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'The model request failed: upstream failed. Retry, or pick a different model.',
    });
    expect(mocks.recordFinish).not.toHaveBeenCalled();
  });

  it('routes the validated model selection to the Pi provider', async () => {
    await collectChunks(await createAgentStream('@cf/openai/gpt-oss-120b'));

    expect(mocks.getPiModel).toHaveBeenCalledWith(
      expect.anything(),
      '@cf/openai/gpt-oss-120b',
      expect.objectContaining({
        model: expect.objectContaining({ id: '@cf/openai/gpt-oss-120b' }),
        sessionAffinity: expect.any(String),
      }),
    );
  });

  it('classifies pre-stream preparation failures without exposing their cause', async () => {
    mocks.prepareModelInput.mockRejectedValueOnce(new Error('private prompt details'));

    await expect(createAgentStream()).rejects.toMatchObject({
      name: 'PiAgentPreparationError',
      diagnosticCode: 'pi_prepare:model_input',
    });
  });

  it('translates Pi tool events into chat tool chunks with structured details', async () => {
    const result = { version: 1, ok: true, summary: 'Read package.json', data: { content: '{}' } };
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'tool_execution_start',
        toolCallId: 'read-1',
        toolName: 'read',
        args: { path: '/home/project/package.json' },
      });
      await emit({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
        result: { content: [{ type: 'text', text: JSON.stringify(result) }], details: result },
        isError: false,
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-input-start', toolCallId: 'read-1', toolName: 'read' }),
        expect.objectContaining({
          type: 'tool-input-available',
          toolCallId: 'read-1',
          input: { path: '/home/project/package.json' },
        }),
        expect.objectContaining({ type: 'tool-output-available', toolCallId: 'read-1', output: result }),
      ]),
    );
    expect(mocks.getValidatedBuildCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([{ toolName: 'read', result }]),
    );
  });

  it('streams Pi tool arguments and transient execution progress before the final result', async () => {
    const call = { type: 'toolCall', id: 'exec-1', name: 'exec', arguments: {} };
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      const message = { timestamp: 123 };
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: { content: [call] } },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":"pnpm test"}' },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { ...call, arguments: { command: 'pnpm test' } },
        },
      });
      await emit({
        type: 'tool_execution_start',
        toolCallId: 'exec-1',
        toolName: 'exec',
        args: { command: 'pnpm test' },
      });
      await emit({
        type: 'tool_execution_update',
        toolCallId: 'exec-1',
        toolName: 'exec',
        args: { command: 'pnpm test' },
        partialResult: { details: { stdout: 'building\n' } },
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1);
    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'tool-input-delta', toolCallId: 'exec-1', inputTextDelta: '{"command":"pnpm test"}' },
        expect.objectContaining({
          type: 'tool-input-available',
          toolCallId: 'exec-1',
          input: { command: 'pnpm test' },
        }),
        expect.objectContaining({
          type: 'data-tool-progress',
          id: 'exec-1',
          transient: true,
        }),
      ]),
    );
  });

  it('preserves Pi text part boundaries in the chat stream', async () => {
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      const message = { timestamp: 123 };
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Building' },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_end', contentIndex: 0 },
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'text-start', id: 'pi-123-0' },
        { type: 'text-delta', id: 'pi-123-0', delta: 'Building' },
        { type: 'text-end', id: 'pi-123-0' },
      ]),
    );
  });

  it('streams the model reasoning as its own part alongside the answer', async () => {
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      const message = { timestamp: 123 };
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Checking the routes' },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0 },
      });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Done' },
      });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toEqual(
      expect.arrayContaining([
        { type: 'reasoning-start', id: 'pi-123-0' },
        { type: 'reasoning-delta', id: 'pi-123-0', delta: 'Checking the routes' },
        { type: 'reasoning-end', id: 'pi-123-0' },
        { type: 'text-delta', id: 'pi-123-1', delta: 'Done' },
      ]),
    );
  });

  it('closes a reasoning part the model never ended', async () => {
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      await emit({
        type: 'message_update',
        message: { timestamp: 123 },
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Half a thought' },
      });
    });

    const chunks = await collectChunks(await createAgentStream());
    const terminal = chunks.findIndex((chunk) => chunk.type === 'finish');

    expect(chunks.slice(0, terminal)).toEqual(
      expect.arrayContaining([
        { type: 'reasoning-start', id: 'pi-123-0' },
        { type: 'reasoning-delta', id: 'pi-123-0', delta: 'Half a thought' },
        { type: 'reasoning-end', id: 'pi-123-0' },
      ]),
    );
  });

  it('exposes exactly the four primitive Pi tools with automatic selection', async () => {
    mocks.piRun.mockImplementation(
      async (context: { tools: Array<{ name: string }> }, config: { toolChoice: string }) => {
        expect(context.tools.map((tool) => tool.name)).toEqual(['read', 'write', 'edit', 'exec']);
        expect(config.toolChoice).toBe('auto');
      },
    );

    await collectChunks(await createAgentStream());
  });

  it('exposes Pi one-at-a-time steering without a model timeout', async () => {
    const steering = new PiSteeringQueue();
    mocks.piMessages = [{ role: 'user', content: 'Use blue instead', timestamp: 1 }];
    steering.reserve({ id: 'steer-1', role: 'user', parts: [{ type: 'text', text: 'Use blue instead' }] })?.commit();
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { getSteeringMessages: () => Promise<Array<{ role: string; content: string }>>; timeoutMs?: number },
      ) => {
        await expect(config.getSteeringMessages()).resolves.toEqual([
          expect.objectContaining({ role: 'user', content: 'Use blue instead' }),
        ]);
        await expect(config.getSteeringMessages()).resolves.toEqual([]);
        expect(config.timeoutMs).toBeUndefined();
      },
    );

    await collectChunks(await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, steering));
  });

  it('stops before another model turn after a typed tool timeout', async () => {
    const timeoutPayload = JSON.stringify({
      code: 'builder_turn_budget_exhausted',
      error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
      reason: 'tool_timeout',
      retryable: true,
    });
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { shouldStopAfterTurn: () => boolean },
        emit: (event: unknown) => Promise<void>,
      ) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'write-timeout',
          toolName: 'write',
          result: { content: [{ type: 'text', text: timeoutPayload }], details: {} },
          isError: true,
        });
        expect(config.shouldStopAfterTurn()).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([{ type: 'toolCall', id: 'write-timeout', name: 'write', arguments: {} }]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: timeoutPayload });
  });

  it('ends the current run after cloudflare_execute stores an approval proposal', async () => {
    const proposal = {
      kind: 'cloudflare_execute_proposal',
      status: 'awaiting_approval',
      executionId: 'execution-1',
      toolCallId: 'cloudflare-execute-1',
      accountId: 'account-1',
      code: 'return mutate()',
      proposalSha256: 'a'.repeat(64),
      riskNote: 'This exact digest requires approval.',
      expiresAt: Date.now() + 60_000,
    };
    mocks.piRun.mockImplementation(
      async (_context: AgentContext, config: StopAwareLoopConfig, emit: RunnerEventSink) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: proposal.toolCallId,
          toolName: 'cloudflare_execute',
          result: { details: proposal },
          isError: false,
        });
        expect(config.shouldStopAfterTurn()).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([
            { type: 'toolCall', id: proposal.toolCallId, name: 'cloudflare_execute', arguments: {} },
          ]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({
      type: 'tool-output-available',
      toolCallId: proposal.toolCallId,
      output: proposal,
      dynamic: true,
    });
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  it('stops before another model turn after an indeterminate tool settlement', async () => {
    const payload = JSON.stringify({
      code: 'workspace_tool_operation_indeterminate',
      error: 'Unable to confirm workspace tool settlement; the workspace operation outcome is indeterminate.',
      retryable: false,
    });
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { shouldStopAfterTurn: () => boolean },
        emit: (event: unknown) => Promise<void>,
      ) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'write-indeterminate',
          toolName: 'write',
          result: { content: [{ type: 'text', text: payload }], details: {} },
          isError: true,
        });
        expect(config.shouldStopAfterTurn()).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([{ type: 'toolCall', id: 'write-indeterminate', name: 'write', arguments: {} }]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: payload });
  });

  it.each([
    ['budget result first', ['budget', 'indeterminate']],
    ['indeterminate result first', ['indeterminate', 'budget']],
  ] as const)('prioritizes an indeterminate error in a combined parallel batch with the %s', async (_label, order) => {
    const budgetPayload = JSON.stringify({
      code: 'builder_turn_budget_exhausted',
      error: 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
      reason: 'tool_timeout',
      retryable: true,
    });
    const indeterminatePayload = JSON.stringify({
      code: 'workspace_tool_operation_indeterminate',
      error: 'Unable to confirm workspace tool settlement; the workspace operation outcome is indeterminate.',
      retryable: false,
    });
    const results = {
      budget: { toolCallId: 'write-timeout', payload: budgetPayload },
      indeterminate: { toolCallId: 'edit-indeterminate', payload: indeterminatePayload },
    } as const;
    mocks.piRun.mockImplementation(
      async (
        _context: unknown,
        config: { shouldStopAfterTurn: () => boolean },
        emit: (event: unknown) => Promise<void>,
      ) => {
        for (const result of order) {
          await emit({
            type: 'tool_execution_end',
            toolCallId: results[result].toolCallId,
            toolName: result === 'budget' ? 'write' : 'edit',
            result: { content: [{ type: 'text', text: results[result].payload }], details: {} },
            isError: true,
          });
        }
        expect(config.shouldStopAfterTurn()).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([
            { type: 'toolCall', id: 'write-timeout', name: 'write', arguments: {} },
            { type: 'toolCall', id: 'edit-indeterminate', name: 'edit', arguments: {} },
          ]),
          toolResults: [],
        });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({ type: 'error', errorText: indeterminatePayload });
    expect(chunks).not.toContainEqual({ type: 'error', errorText: budgetPayload });
  });

  it('compacts live tool-loop context before another model step', async () => {
    const summarize = vi.fn(async () => '## Goal\nFinish the build.');
    const requestDurableCompaction = vi.fn();
    mocks.piMessages = runtimeHistory();
    mocks.piRun.mockImplementation(
      async (
        context: { messages: unknown[] },
        config: { prepareNextTurn?: (value: unknown) => Promise<{ context?: { messages: unknown[] } } | undefined> },
        emit: (event: unknown) => Promise<void>,
      ) => {
        const toolMessage = assistantMessage([{ type: 'toolCall', id: 'read-1', name: 'read', arguments: {} }]);
        const next = await config.prepareNextTurn?.({
          message: toolMessage,
          context,
          newMessages: [],
          toolResults: [],
        });
        expect(next?.context?.messages[0]).toMatchObject({ role: 'user' });
        expect(JSON.stringify(next?.context?.messages[0])).toContain('<summary>');
        await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
      },
    );

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, { summarize, requestDurableCompaction }),
    );

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(summarize).toHaveBeenCalled();
    expect(requestDurableCompaction).toHaveBeenCalled();
  });

  it('compacts and retries one invisible context-overflow response', async () => {
    const summarize = vi.fn(async () => '## Goal\nRecover the build.');
    const requestDurableCompaction = vi.fn();
    mocks.piMessages = runtimeHistory();
    mocks.piRun
      .mockImplementationOnce(
        async (context: { messages: unknown[] }, _config: unknown, emit: (event: unknown) => Promise<void>) => {
          const overflow = assistantMessage([], {
            stopReason: 'error',
            errorMessage: 'The prompt exceeds the context window.',
          });
          context.messages.push(overflow);
          await emit({ type: 'turn_end', message: overflow, toolResults: [] });
        },
      )
      .mockImplementationOnce(
        async (context: { messages: unknown[] }, _config: unknown, emit: (event: unknown) => Promise<void>) => {
          expect(JSON.stringify(context.messages[0])).toContain('<summary>');
          await emit({
            type: 'turn_end',
            message: assistantMessage([{ type: 'text', text: 'Recovered' }]),
            toolResults: [],
          });
        },
      );

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, { summarize, requestDurableCompaction }),
    );

    expect(mocks.piRun).toHaveBeenCalledTimes(2);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(requestDurableCompaction).toHaveBeenCalled();
  });

  it('preserves the provider rejection when a new chat has nothing to compact', async () => {
    const summarize = vi.fn(async () => 'Unused');
    mocks.piMessages = [{ role: 'user', content: 'a to do app', timestamp: 1 }];
    mocks.piRun.mockImplementation(
      async (
        context: { messages: Array<AgentMessage | ReturnType<typeof assistantMessage>> },
        _config: StopAwareLoopConfig,
        emit: RunnerEventSink,
      ) => {
        const overflow = assistantMessage([], {
          stopReason: 'error',
          errorMessage: 'The prompt exceeds the context window.',
        });
        context.messages.push(overflow);
        await emit({ type: 'turn_end', message: overflow, toolResults: [] });
      },
    );

    const chunks = await collectChunks(await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, { summarize }));

    expect(summarize).not.toHaveBeenCalled();
    expect(mocks.piRun).toHaveBeenCalledOnce();
    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'The model request failed: The prompt exceeds the context window. Retry, or pick a different model.',
    });
  });

  it('does not retry a second invisible overflow', async () => {
    mocks.piMessages = runtimeHistory();
    const overflowRun = async (
      context: { messages: unknown[] },
      _config: unknown,
      emit: (event: unknown) => Promise<void>,
    ) => {
      const overflow = assistantMessage([], {
        stopReason: 'error',
        errorMessage: 'The prompt exceeds the context window.',
      });
      context.messages.push(overflow);
      await emit({ type: 'turn_end', message: overflow, toolResults: [] });
    };
    mocks.piRun.mockImplementation(overflowRun);

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, { summarize: async () => 'Checkpoint' }),
    );

    expect(mocks.piRun).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'The model request failed: The prompt exceeds the context window. Retry, or pick a different model.',
    });
  });

  it('stops the loop once a validated completion is reached', async () => {
    const onSettled = vi.fn();
    mocks.getValidatedBuildCompletion.mockImplementation((_messages: unknown, results: unknown[] = []) =>
      results.length >= 3 ? 'Project validation passed.' : undefined,
    );
    mocks.piRun.mockImplementation(
      fakeModelLoop((step, emit) => emitToolRound(step, emit, { isError: false, details: { summary: 'wrote' } })),
    );

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
    );

    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalReason: 'completed',
        stepCount: 3,
        lastValidationState: 'validated',
      }),
    );
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(mocks.recordFinish).toHaveBeenCalled();
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'validated-build-completion',
      delta: 'Project validation passed.',
    });
  });

  it('runs the canonical validation when a mutated turn finishes without one', async () => {
    const onSettled = vi.fn();
    mocks.getValidatedBuildCompletion.mockImplementation(
      (_messages: CloudChefMessage[], results: Array<{ toolName: string }> = []) =>
        results.some((entry) => entry.toolName === 'validate') ? 'Validated automatically.' : undefined,
    );
    mocks.validateExecute.mockResolvedValue({
      content: [{ type: 'text', text: 'validation passed' }],
      details: { validation: { version: 1, ok: true, summary: 'ok' } },
    });
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      await emitToolRound(1, emit, { isError: false, details: { ok: true } });
      await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
    });

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
    );

    expect(mocks.piRun).toHaveBeenCalledTimes(1);
    expect(mocks.validateExecute).toHaveBeenCalledTimes(1);
    expect(mocks.validateExecute).toHaveBeenCalledWith(
      expect.stringMatching(/^auto-validate:/),
      {},
      expect.anything(),
      undefined,
    );
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-input-start', toolName: 'validate' }));
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'validated-build-completion',
      delta: 'Validated automatically.',
    });
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ terminalReason: 'completed', lastValidationState: 'validated' }),
    );
  });

  it('feeds an automatic validation failure back into the same turn for repair', async () => {
    mocks.getValidatedBuildCompletion.mockImplementation(
      (
        _messages: CloudChefMessage[],
        results: Array<{ toolName: string; result: { validation?: { ok?: boolean } } }> = [],
      ) => {
        const latestValidation = results.findLast((entry) => entry.toolName === 'validate');
        return latestValidation?.result.validation?.ok ? 'Validated after repair.' : undefined;
      },
    );
    mocks.validateExecute
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'lint failed' }],
        details: { validation: { version: 1, ok: false, summary: 'lint failed' } },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'validation passed' }],
        details: { validation: { version: 1, ok: true, summary: 'ok' } },
      });
    const repairContexts: AgentMessage[][] = [];
    mocks.piRun.mockImplementation(async (ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      repairContexts.push([...ctx.messages]);
      if (repairContexts.length === 1) {
        await emitToolRound(1, emit, { isError: false, details: { ok: true } });
      }
      await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(mocks.piRun).toHaveBeenCalledTimes(2);
    expect(mocks.validateExecute).toHaveBeenCalledTimes(2);
    // The repair round sees the failed validation as a normal tool call and result in context.
    const repairMessages = repairContexts.at(1) ?? [];
    expect(repairMessages.at(-1)).toMatchObject({ role: 'toolResult', toolName: 'validate', isError: true });
    expect(repairMessages.at(-2)).toMatchObject({ role: 'assistant' });
    expect(chunks).toContainEqual({
      type: 'text-delta',
      id: 'validated-build-completion',
      delta: 'Validated after repair.',
    });
  });

  it('does not auto-validate a turn without durable mutations', async () => {
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      await emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: {} });
      await emit({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'read',
        result: { details: { ok: true } },
        isError: false,
      });
      await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
    });

    await collectChunks(await createAgentStream());

    expect(mocks.validateExecute).not.toHaveBeenCalled();
  });

  it('surfaces a turn that exhausted its output budget on hidden reasoning', async () => {
    const onSettled = vi.fn();
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      await emit({ type: 'turn_start' });
      await emit({ type: 'turn_end', message: assistantMessage([], { stopReason: 'length' }), toolResults: [] });
    });

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
    );

    expect(chunks).toContainEqual({
      type: 'error',
      errorText:
        'The model used up its output budget on internal reasoning without producing a result. Retry, or pick a different model.',
    });
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ terminalReason: 'failed' }));
  });

  it('ends a stalled turn on the inactivity budget once meaningful progress was seen', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    mocks.piRun.mockImplementation(stallAfterAssistantEvent('text_start'));

    try {
      const collected = collectChunks(
        await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
      );
      await vi.advanceTimersByTimeAsync(BUILDER_TURN_INACTIVITY_MS);
      const chunks = await collected;

      expect(chunks).toContainEqual({ type: 'error', errorText: budgetErrorText('inactivity') });
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ terminalReason: 'inactivity', stepCount: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a silent turn on the first-progress deadline with an actionable error', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    // Transport noise without visible text or tool activity must not count as progress.
    mocks.piRun.mockImplementation(stallAfterAssistantEvent('start'));

    try {
      const collected = collectChunks(
        await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
      );
      await vi.advanceTimersByTimeAsync(BUILDER_TURN_FIRST_PROGRESS_MS);
      const chunks = await collected;

      expect(chunks).toContainEqual({ type: 'error', errorText: budgetErrorText('no_first_progress') });
      expect(onSettled).toHaveBeenCalledWith(
        expect.objectContaining({ terminalReason: 'no_first_progress', stepCount: 0 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not trip the first-progress deadline while the model is still reasoning', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    // A reasoning model streams thinking long before its first visible token: that is work, not a stall.
    mocks.piRun.mockImplementation(stallAfterAssistantEvent('thinking_delta'));

    try {
      const collected = collectChunks(
        await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
      );
      await vi.advanceTimersByTimeAsync(BUILDER_TURN_FIRST_PROGRESS_MS);
      expect(onSettled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(BUILDER_TURN_INACTIVITY_MS);
      const chunks = await collected;

      expect(chunks).not.toContainEqual({ type: 'error', errorText: budgetErrorText('no_first_progress') });
      expect(chunks).toContainEqual({ type: 'error', errorText: budgetErrorText('inactivity') });
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ terminalReason: 'inactivity' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not trip the first-progress deadline while tool calls stream normally', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      await emit({ type: 'turn_start' });
      await emit({
        type: 'message_update',
        message: { timestamp: 1 },
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      });
      await vi.advanceTimersByTimeAsync(BUILDER_TURN_FIRST_PROGRESS_MS * 2);
      await emit({
        type: 'turn_end',
        message: assistantMessage([{ type: 'text', text: 'done' }]),
        toolResults: [],
      });
    });

    try {
      const chunks = await collectChunks(
        await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
      );

      expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ terminalReason: 'completed' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an owner cancellation as cancellation rather than budget exhaustion', async () => {
    const onSettled = vi.fn();
    const abortSignal = AbortSignal.abort();
    mocks.piRun.mockImplementation(async (_ctx: unknown, _cfg: unknown, emit: (event: unknown) => Promise<void>) => {
      await emit({
        type: 'turn_end',
        message: assistantMessage([], { stopReason: 'aborted', errorMessage: 'aborted' }),
        toolResults: [],
      });
    });

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { abortSignal, onSettled }),
    );

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ terminalReason: 'cancelled' }));
  });

  it('does not retry an overflow after model content was streamed', async () => {
    mocks.piMessages = runtimeHistory();
    mocks.piRun.mockImplementation(
      async (context: { messages: unknown[] }, _config: unknown, emit: (event: unknown) => Promise<void>) => {
        await emit({
          type: 'message_update',
          message: { timestamp: 123 },
          assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
        });
        const overflow = assistantMessage([], {
          stopReason: 'error',
          errorMessage: 'The prompt exceeds the context window.',
        });
        context.messages.push(overflow);
        await emit({ type: 'turn_end', message: overflow, toolResults: [] });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(mocks.piRun).toHaveBeenCalledOnce();
    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'The model request failed: The prompt exceeds the context window. Retry, or pick a different model.',
    });
  });
});

function createAgentStream(
  modelId: WorkersAiModelId = CLOUDFLARE_WORKERS_AI_MODEL,
  compactionOverrides: Partial<Parameters<typeof piAgentRunner>[0]['compaction']> = {},
  steering = new PiSteeringQueue(),
  overrides: Partial<Parameters<typeof piAgentRunner>[0]> = {},
) {
  return piAgentRunner({
    firstUserMessage: false,
    messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] }],
    model: {
      ...DEFAULT_WORKERS_AI_MODEL,
      id: modelId,
      label: modelId,
    },
    compaction: {
      current: null,
      pending: false,
      summarize: async () => 'summary',
      save: vi.fn(),
      ...compactionOverrides,
    },
    accountCredentials: { binding: {} as Ai },
    sessionAffinity: 'opaque-session',
    workspace: {} as never,
    runWithKeepAlive: (operation) => operation(),
    steering,
    onSettled: vi.fn(),
    ...overrides,
  });
}

function budgetErrorText(reason: string) {
  return JSON.stringify({
    code: 'builder_turn_budget_exhausted',
    error:
      reason === 'no_first_progress'
        ? 'The model did not start responding within a minute. Retry, or pick a different model.'
        : 'This build reached its safe execution limit before it finished. Send a follow-up to continue.',
    reason,
    retryable: true,
  });
}

/** Drive the runner's loop config the way pi-agent-core does: turn_end, then the stop check. */
function fakeModelLoop(turn: (step: number, emit: (event: unknown) => Promise<void>) => Promise<void>) {
  return async (
    _context: unknown,
    config: { shouldStopAfterTurn?: (value: unknown) => boolean | Promise<boolean> },
    emit: (event: unknown) => Promise<void>,
  ) => {
    // Fixed safety bound: the production loop has no step ceiling, so a test
    // whose stop condition never fires must fail instead of spinning forever.
    for (let step = 1; step <= 200; step += 1) {
      await turn(step, emit);
      const message = assistantMessage([{ type: 'toolCall', id: `call-${step}`, name: 'write', arguments: {} }]);
      await emit({ type: 'turn_end', message, toolResults: [] });
      if (await config.shouldStopAfterTurn?.({ message, toolResults: [], context: {}, newMessages: [] })) {
        return;
      }
    }
    throw new Error('The runner never stopped the fake model loop.');
  };
}

/** A model that streams one assistant event of this type and then never says anything again. */
function stallAfterAssistantEvent(assistantEventType: string) {
  return async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink, signal?: AbortSignal) => {
    await emit({ type: 'turn_start' });
    await emit({
      type: 'message_update',
      message: { timestamp: 1 },
      assistantMessageEvent: { type: assistantEventType, contentIndex: 0 },
    });
    await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
  };
}

async function emitToolRound(step: number, emit: RunnerEventSink, result: { isError: boolean; details: unknown }) {
  await emit({ type: 'tool_execution_start', toolCallId: `call-${step}`, toolName: 'write', args: {} });
  await emit({
    type: 'tool_execution_end',
    toolCallId: `call-${step}`,
    toolName: 'write',
    result: { details: result.details },
    isError: result.isError,
  });
}

function runtimeHistory() {
  return Array.from({ length: 6 }, (_, index) => ({
    role: 'user',
    content: `${index}:${'x'.repeat(70_000)}`,
    timestamp: index,
  }));
}

function assistantMessage(content: unknown[], overrides: { stopReason?: string; errorMessage?: string } = {}) {
  return {
    role: 'assistant',
    content,
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    model: 'test-workers-ai',
    usage: piUsage(),
    stopReason: overrides.stopReason ?? 'stop',
    ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
  };
}

function piUsage(overrides: Partial<{ input: number; output: number; totalTokens: number }> = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

async function collectChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}
