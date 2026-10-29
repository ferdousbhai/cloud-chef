import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext, AgentMessage, AgentLoopConfig } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { PiStreamChunk } from './pi-stream';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL, type BuilderModelId } from '~/lib/workers-ai-model';

type UIMessageChunk = PiStreamChunk;
type RunnerEvent =
  | RunnerTurnStartEvent
  | RunnerMessageStartEvent
  | RunnerMessageUpdateEvent
  | RunnerToolExecutionStartEvent
  | RunnerToolExecutionEndEvent
  | RunnerTurnEndEvent;
type RunnerEventSink = (event: RunnerEvent) => Promise<void>;

interface RunnerTurnStartEvent {
  type: 'turn_start';
}

/** A streamed assistant message as far as the runner reads it: which model wrote it, and its blocks. */
interface RunnerAssistantMessage {
  role: 'assistant';
  timestamp: number;
  provider: string;
  api: string;
  model: string;
  content: ReadonlyArray<Record<string, string | boolean | Record<string, string>>>;
}

interface RunnerMessageStartEvent {
  type: 'message_start';
  message: RunnerAssistantMessage;
}

interface RunnerMessageUpdateEvent {
  type: 'message_update';
  message: { timestamp: number };
  assistantMessageEvent: {
    type: string;
    contentIndex: number;
    delta?: string;
    content?: string;
    partial?: RunnerAssistantMessage;
    toolCall?: RunnerAssistantMessage['content'][number];
  };
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

type FinishTurnDecision = { action: 'continue' | 'end' } | void;

interface StopAwareLoopConfig {
  finishTurn?(turn: unknown): FinishTurnDecision | Promise<FinishTurnDecision>;
}

/** Ask the runner's `finishTurn` hook whether it ends the run after a completed tool turn. */
async function endsTurn(config: StopAwareLoopConfig): Promise<boolean> {
  const message = assistantMessage([{ type: 'toolCall', id: 'call-check', name: 'write', arguments: {} }]);
  const decision = await config.finishTurn?.({ message, toolResults: [], context: { messages: [] }, newMessages: [] });
  return decision?.action === 'end';
}

const mocks = vi.hoisted(() => ({
  piMessages: [] as unknown[],
  piRun: vi.fn(),
  prepareModelInput: vi.fn(async (options: { messages: unknown[] }) => ({
    messages: mocks.piMessages,
    promptMessages: options.messages,
    nextCompaction: null,
    contextCompacted: false,
    estimatedTokens: 1,
  })),
  getPiModel: vi.fn(() => ({
    model: { id: 'test-workers-ai', api: 'openai-completions', contextWindow: 128_000, maxTokens: 1_000 },
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
vi.mock('./builder-skills', () => ({
  createBuilderSkillContext: vi.fn(async () => ({
    prompt: 'Bundled guidance.',
    reader: { read: vi.fn(async () => null) },
  })),
}));
vi.mock('./pi-tools-adapter', () => ({
  createPiToolBundle: vi.fn(() => ({
    write: { name: 'write', description: 'write', parameters: 'canonical-schema' },
    validate: { name: 'validate', description: 'validate', parameters: 'canonical-schema' },
  })),
}));
vi.mock('./workers-ai-telemetry', () => ({
  recordFirstWorkersAiResponse: vi.fn(),
  recordFirstMeaningfulWorkersAiProgress: vi.fn(),
  recordFirstBuilderMutation: vi.fn(),
  recordPiStage: vi.fn(),
  recordPiTurnReport: vi.fn(),
  recordWorkersAiFinish: mocks.recordFinish,
  turnUsage: () => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 }),
}));
import { logger } from 'cloudchef-agent/utils/logger';
import { ModelInputBudgetExceededError } from './model-input';
import { piAgentRunner } from './pi-agent-runner';
import { PiSteeringQueue } from './pi-steering';
import {
  BUILDER_TURN_FIRST_PROGRESS_MS,
  BUILDER_TURN_INACTIVITY_MS,
  BuilderTurnLimitError,
} from './builder-turn-limits';

describe('piAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.piMessages = [];
    mocks.piRun.mockResolvedValue(undefined);
  });

  it('answers input too large to send with a 413 the browser shows', async () => {
    mocks.prepareModelInput.mockRejectedValueOnce(new ModelInputBudgetExceededError(10, 5));

    await expect(createAgentStream()).rejects.toMatchObject({ status: 413 });
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

  it("sends the turn's model requests with the gateway logging the turn was given", async () => {
    const gatewayLogging = { collectLog: false } as const;

    await collectChunks(await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { gatewayLogging }));

    expect(mocks.getPiModel).toHaveBeenCalledWith(
      { binding: expect.anything() },
      CLOUDFLARE_WORKERS_AI_MODEL,
      expect.objectContaining({ sessionAffinity: 'opaque-session', gatewayLogging }),
    );
  });

  it('answers a pre-stream preparation failure with a bare 500, logging its stage but not its cause', async () => {
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    mocks.prepareModelInput.mockRejectedValueOnce(
      Object.assign(new Error('private prompt details'), { requestBodyValues: { prompt: 'SECRET_PROVIDER_PROMPT' } }),
    );

    await expect(createAgentStream()).rejects.toMatchObject({ status: 500 });

    expect(logged).toHaveBeenCalledWith('Workers AI chat request failed', {
      kind: 'PiAgentPreparationError',
      diagnosticCode: 'pi_prepare:model_input',
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('SECRET_PROVIDER_PROMPT');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('private prompt details');
    logged.mockRestore();
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

  it("records Claude's signed and redacted thinking, and each response's tool calls, for the transcript", async () => {
    mocks.getPiModel.mockReturnValueOnce({
      model: { id: 'claude-opus-5-5', api: 'anthropic-messages', contextWindow: 1_000_000, maxTokens: 128_000 },
      stream: vi.fn(),
    });
    const model = { provider: 'cloudflare-ai-gateway', api: 'anthropic-messages', model: 'claude-opus-5-5' };
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      // One response: a signed thinking block, a redacted one, then a tool call.
      const first: RunnerAssistantMessage = {
        ...model,
        role: 'assistant',
        timestamp: 1,
        content: [
          { type: 'thinking', thinking: 'Look first.', thinkingSignature: 'sig-1' },
          { type: 'thinking', thinking: '[Reasoning redacted]', thinkingSignature: 'opaque', redacted: true },
          { type: 'toolCall', id: 'toolu_a', name: 'read_file', arguments: { path: '/a' } },
        ],
      };
      await emit({ type: 'message_start', message: first });
      for (const contentIndex of [0, 1]) {
        await emit({
          type: 'message_update',
          message: first,
          assistantMessageEvent: { type: 'thinking_start', contentIndex, partial: first },
        });
        await emit({
          type: 'message_update',
          message: first,
          assistantMessageEvent: { type: 'thinking_end', contentIndex, content: '', partial: first },
        });
      }
      await emit({
        type: 'message_update',
        message: first,
        assistantMessageEvent: { type: 'toolcall_end', contentIndex: 2, toolCall: first.content[2], partial: first },
      });
      // The next response, after the tool's result: its own thinking, cut off before its signature.
      const second: RunnerAssistantMessage = {
        ...model,
        role: 'assistant',
        timestamp: 2,
        content: [{ type: 'thinking', thinking: 'Hm' }],
      };
      await emit({ type: 'message_start', message: second });
      await emit({
        type: 'message_update',
        message: second,
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'Hm', partial: second },
      });
    });

    const chunks = await collectChunks(await createAgentStream());
    const step = (chunk: UIMessageChunk | undefined) =>
      chunk && 'providerMetadata' in chunk ? chunk.providerMetadata?.cloudchef?.step : undefined;
    const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-start' || chunk.type === 'reasoning-end');
    const toolInput = chunks.find((chunk) => chunk.type === 'tool-input-available');

    expect(reasoning).toEqual([
      { type: 'reasoning-start', id: 'pi-1-0' },
      {
        type: 'reasoning-end',
        id: 'pi-1-0',
        providerMetadata: { anthropic: { signature: 'sig-1' }, cloudchef: { step: step(toolInput), ...model } },
      },
      // A redacted block says so from its start, so it never shows.
      {
        type: 'reasoning-start',
        id: 'pi-1-1',
        providerMetadata: { anthropic: { redactedData: 'opaque' }, cloudchef: { step: step(toolInput), ...model } },
      },
      {
        type: 'reasoning-end',
        id: 'pi-1-1',
        providerMetadata: { anthropic: { redactedData: 'opaque' }, cloudchef: { step: step(toolInput), ...model } },
      },
      // Unsigned thinking has nothing to send back, so it records nothing.
      { type: 'reasoning-start', id: 'pi-2-0' },
      { type: 'reasoning-end', id: 'pi-2-0' },
    ]);
    expect(toolInput).toMatchObject({
      toolCallId: 'toolu_a',
      providerMetadata: { cloudchef: { step: expect.any(String) } },
    });
  });

  it('records no thinking metadata for a model that is not Claude', async () => {
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      const message: RunnerAssistantMessage = {
        role: 'assistant',
        timestamp: 1,
        provider: 'cloudflare-workers-ai',
        api: 'openai-completions',
        model: 'test-workers-ai',
        content: [{ type: 'thinking', thinking: 'x', thinkingSignature: 'encrypted' }],
      };
      await emit({ type: 'message_start', message });
      await emit({
        type: 'message_update',
        message,
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'x', partial: message },
      });
      await emit({ type: 'tool_execution_start', toolCallId: 'call_a', toolName: 'read_file', args: {} });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks.some((chunk) => 'providerMetadata' in chunk)).toBe(false);
  });

  it('lets the model carry on after a tool deadline, as with any failed tool', async () => {
    mocks.piRun.mockImplementation(
      async (_context: unknown, config: StopAwareLoopConfig, emit: (event: unknown) => Promise<void>) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'exec-timeout',
          toolName: 'exec',
          result: {
            content: [{ type: 'text', text: 'exec did not finish within 35 minutes and was stopped.' }],
            details: {},
          },
          isError: true,
        });
        expect(await endsTurn(config)).toBe(false);
        await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
      },
    );

    const chunks = await collectChunks(await createAgentStream());

    expect(chunks).toContainEqual({
      type: 'tool-output-error',
      toolCallId: 'exec-timeout',
      errorText: 'exec did not finish within 35 minutes and was stopped.',
      dynamic: true,
    });
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  it('never writes a completion message of its own after the model has finished', async () => {
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      await emitToolRound(1, emit, { isError: false, details: { validation: { version: 1, ok: true } } });
      await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
    });

    const chunks = await collectChunks(await createAgentStream());

    expect(mocks.piRun).toHaveBeenCalledOnce();
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([]);
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
  });

  it('ends the current run after cloudflare_request stores an approval proposal', async () => {
    const proposal = {
      kind: 'cloudflare_request_proposal',
      status: 'awaiting_approval',
      executionId: 'execution-1',
      toolCallId: 'cloudflare-execute-1',
      accountId: 'account-1',
      request: { method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/zone-1' },
      proposalSha256: 'a'.repeat(64),
      riskNote: 'This exact digest requires approval.',
      expiresAt: Date.now() + 60_000,
    };
    mocks.piRun.mockImplementation(
      async (_context: AgentContext, config: StopAwareLoopConfig, emit: RunnerEventSink) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: proposal.toolCallId,
          toolName: 'cloudflare_request',
          result: { details: proposal },
          isError: false,
        });
        expect(await endsTurn(config)).toBe(true);
        await emit({
          type: 'turn_end',
          message: assistantMessage([
            { type: 'toolCall', id: proposal.toolCallId, name: 'cloudflare_request', arguments: {} },
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
      async (_context: unknown, config: StopAwareLoopConfig, emit: (event: unknown) => Promise<void>) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: 'write-indeterminate',
          toolName: 'write',
          result: { content: [{ type: 'text', text: payload }], details: {} },
          isError: true,
        });
        expect(await endsTurn(config)).toBe(true);
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

  it("lists only this turn's own inputs as current-turn inputs after a live rollover", async () => {
    mocks.piMessages = [
      { role: 'user', content: 'Earlier request: add a login page', timestamp: 1 },
      assistantMessage([{ type: 'text', text: 'Login page added' }]),
      // The live prompt carries the injected turn context; its durable copy does not.
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Current file: src/app.tsx\nCloudChef publication status: draft' },
          { type: 'text', text: 'Build it' },
        ],
        timestamp: 3,
      },
    ];
    mocks.piRun.mockImplementation(async (context: AgentContext, config: AgentLoopConfig, emit: RunnerEventSink) => {
      // A context this full rolls over before the next model step.
      const call: AssistantMessage = {
        ...assistantMessage([]),
        role: 'assistant',
        api: 'openai-completions',
        stopReason: 'toolUse',
        usage: piUsage({ totalTokens: 10_000_000 }),
        content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/home/project/src/app.tsx' } }],
      };
      const result: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'export {}' }],
        isError: false,
        timestamp: 4,
      };
      context.messages.push({ role: 'user', content: 'Steer: use dark mode', timestamp: 4 }, call, result);
      const next = await config.prepareNextTurn?.({
        message: call,
        context,
        newMessages: [call, result],
        toolResults: [result],
      });
      const record = JSON.stringify(next?.context?.messages[1]);
      expect(record.split('current turn; search history')).toHaveLength(2);
      expect(record).toContain('Steer: use dark mode');
      expect(record.split('Earlier request: add a login page')).toHaveLength(2);
      expect(record).toContain('earlier-1');
      // The turn context survives the fresh window, once, beside the current prompt listed once under its id.
      expect(record.split('CloudChef publication status: draft')).toHaveLength(2);
      expect(record.split('Build it')).toHaveLength(2);
      expect(record).toContain('user-1');
      await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
    });
    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, new PiSteeringQueue(), {
        messages: [
          { id: 'earlier-1', role: 'user', parts: [{ type: 'text', text: 'Earlier request: add a login page' }] },
          { id: 'reply-1', role: 'assistant', parts: [{ type: 'text', text: 'Login page added' }] },
          { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build it' }] },
        ],
        turnContext: { version: 1, content: 'Current file: src/app.tsx\nCloudChef publication status: draft' },
      }),
    );
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });

  it('compacts live tool-loop context before another model step', async () => {
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
        expect(next?.context?.messages[0]).toMatchObject({ role: 'system' });
        expect(next?.context?.messages[1]).toMatchObject({ role: 'user' });
        expect(JSON.stringify(next?.context?.messages[1])).toContain('<summary>');
        await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
      },
    );

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, { requestDurableCompaction }),
    );

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(requestDurableCompaction).toHaveBeenCalled();
  });

  it('clears old tool output before another model step once the context is large', async () => {
    const results = Array.from({ length: 24 }, (_, index) => ({
      role: 'toolResult',
      toolCallId: `read-${index}`,
      toolName: 'read',
      content: [{ type: 'text', text: `${index}:${'x'.repeat(12_000)}` }],
      isError: false,
      timestamp: index,
    }));
    mocks.piMessages = [{ role: 'user', content: 'Build it', timestamp: 0 }];
    let stepContext: AgentMessage[] = [];
    mocks.piRun.mockImplementation(
      async (
        context: AgentContext,
        config: Pick<AgentLoopConfig, 'prepareNextTurn'>,
        emit: (event: unknown) => Promise<void>,
      ) => {
        const toolMessage = assistantMessage([{ type: 'toolCall', id: 'read-24', name: 'read', arguments: {} }]);
        // SAFETY: the fixtures are complete Pi tool-result and assistant messages.
        const live = [...context.messages, ...(results as AgentMessage[])];
        const next = await config.prepareNextTurn?.({
          // SAFETY: assistantMessage builds a complete Pi assistant message.
          message: toolMessage as AssistantMessage,
          context: { ...context, messages: live },
          newMessages: [],
          toolResults: [],
        });
        stepContext = next?.context?.messages ?? live;
        await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
      },
    );

    await collectChunks(await createAgentStream());

    const toolResults = stepContext.filter((message) => message.role === 'toolResult');
    expect(toolResults).toHaveLength(24);
    expect(JSON.stringify(toolResults.at(0))).toContain('output cleared to save context');
    expect(JSON.stringify(toolResults.at(-1))).toContain('x'.repeat(12_000));
  });

  it('compacts and retries one invisible context-overflow response', async () => {
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
          expect(context.messages[0]).toMatchObject({ role: 'system' });
          expect(JSON.stringify(context.messages[1])).toContain('<summary>');
          await emit({
            type: 'turn_end',
            message: assistantMessage([{ type: 'text', text: 'Recovered' }]),
            toolResults: [],
          });
        },
      );

    const chunks = await collectChunks(
      await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, { requestDurableCompaction }),
    );

    expect(mocks.piRun).toHaveBeenCalledTimes(2);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(requestDurableCompaction).toHaveBeenCalled();
  });

  it('preserves the provider rejection when a new chat has nothing to compact', async () => {
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

    const chunks = await collectChunks(await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}));

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

    const chunks = await collectChunks(await createAgentStream());

    expect(mocks.piRun).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({
      type: 'error',
      errorText: 'The model request failed: The prompt exceeds the context window. Retry, or pick a different model.',
    });
  });

  it.each([
    ['write', true],
    ['read', false],
  ] as const)('reports whether a turn ran %s, a tool that can change the project', async (toolName, changed) => {
    const onSettled = vi.fn();
    mocks.piRun.mockImplementation(async (_ctx: AgentContext, _cfg: StopAwareLoopConfig, emit: RunnerEventSink) => {
      await emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName, args: {} });
      await emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName,
        result: { details: { ok: true } },
        isError: false,
      });
      await emit({ type: 'turn_end', message: assistantMessage([{ type: 'text', text: 'Done' }]), toolResults: [] });
    });

    await collectChunks(await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }));

    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ terminalReason: 'completed', changedProject: changed }),
    );
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

  it('ends a stalled turn on the inactivity watchdog once meaningful progress was seen', async () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    mocks.piRun.mockImplementation(stallAfterAssistantEvent('text_start'));

    try {
      const collected = collectChunks(
        await createAgentStream(CLOUDFLARE_WORKERS_AI_MODEL, {}, undefined, { onSettled }),
      );
      await vi.advanceTimersByTimeAsync(BUILDER_TURN_INACTIVITY_MS);
      const chunks = await collected;

      expect(chunks).toContainEqual({ type: 'error', errorText: limitErrorText('inactivity') });
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

      expect(chunks).toContainEqual({ type: 'error', errorText: limitErrorText('no_first_progress') });
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

      expect(chunks).not.toContainEqual({ type: 'error', errorText: limitErrorText('no_first_progress') });
      expect(chunks).toContainEqual({ type: 'error', errorText: limitErrorText('inactivity') });
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

  it('reports an owner cancellation as cancellation rather than a hung turn', async () => {
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
  modelId: BuilderModelId = CLOUDFLARE_WORKERS_AI_MODEL,
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
      save: vi.fn(),
      schedule: async () => undefined,
      requestDurableCompaction: vi.fn(),
      ...compactionOverrides,
    },
    accountCredentials: { binding: {} as Ai },
    sessionAffinity: 'opaque-session',
    gatewayLogging: { collectLog: false },
    workspace: {} as never,
    runWithKeepAlive: (operation) => operation(),
    steering,
    onSettled: vi.fn(),
    ...overrides,
  });
}

function limitErrorText(reason: 'inactivity' | 'no_first_progress') {
  return new BuilderTurnLimitError(reason).message;
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
