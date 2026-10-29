import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { normalizeContext, type Message } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { CLOUDFLARE_PROJECT_TITLE_MODEL, type BuilderModelId } from '~/lib/workers-ai-model';
import { gatewayKeyRejectedMessage, getPiModel, type WorkersAiAccountCredentials } from './pi-ai-models';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { redactedThinkingMetadata, signedThinkingMetadata, toolStepMetadata } from 'cloudchef-agent/signed-thinking';
import { transcriptToPiMessages } from './message-conversion';
import { completeText } from './pi-ai-invoke';
import type { ProviderRequestBody } from './provider-default-reasoning';
import {
  WORKERS_AI_GATEWAY_UNLOGGED,
  workersAiGatewayLogging,
  type WorkersAiGatewayLogging,
  type WorkersAiGatewayOptions,
} from './workers-ai-gateway';

const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read a file.',
  parameters: z.toJSONSchema(z.object({ path: z.string() })),
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * The title call site deliberately pass no `BuilderModel`, because pi-ai's own
 * static catalog already describes llama-4-scout correctly. That is an assumption about a
 * dependency, not about this repository: if an upgrade drops the entry or shrinks its window,
 * `getPiModel` silently substitutes its 128k non-reasoning defaults and title generation quietly
 * loses window instead of failing. This makes that upgrade turn `validate` red.
 */
describe('pinned title model in the pi-ai catalog', () => {
  const piCatalog = new Map<string, { api: string; contextWindow: number }>(
    Object.entries(CLOUDFLARE_WORKERS_AI_MODELS),
  );

  it.each([CLOUDFLARE_PROJECT_TITLE_MODEL])('describes %s', (modelId) => {
    expect(piCatalog.get(modelId)).toMatchObject({
      api: 'openai-completions',
      contextWindow: expect.any(Number),
    });
    expect(piCatalog.get(modelId)?.contextWindow).toBeGreaterThanOrEqual(131_000);
  });
});

/**
 * CloudChef names no thinking dialect of its own: `workersAiCompat` spreads Pi's catalog entry and
 * adds nothing, so whatever `compat.thinkingFormat` a request carries is Pi's opinion, and where Pi
 * has none, Pi's own provider detection resolves the Cloudflare base URL to its `"openai"` default
 * — a bare `reasoning_effort`, which is sent only when a caller asks for an effort.
 *
 * Pi 1.0 characterises exactly the DeepSeek v4 entries as `"deepseek"`: with no effort requested
 * they send `thinking: { type: 'disabled' }` (measured to change nothing on Workers AI) and replay
 * assistant turns with an empty `reasoning_content`, which DeepSeek requires. Any other change
 * silently reshapes every request for that model, so this pin turns it into a red `validate` and
 * a decision.
 */
describe('Pi Workers AI catalog thinking formats', () => {
  const entries = Object.entries(CLOUDFLARE_WORKERS_AI_MODELS);

  it('leaves the thinking format to Pi, which characterises only the reviewed DeepSeek entries', () => {
    expect(entries.filter(([, model]) => model.reasoning).length).toBeGreaterThan(0);

    expect(
      entries
        .filter(([, model]) => model.compat?.thinkingFormat !== undefined)
        .map(([modelId, model]) => [modelId, model.compat?.thinkingFormat]),
    ).toEqual([
      ['@cf/deepseek-ai/deepseek-v4-flash-0731', 'deepseek'],
      ['@cf/deepseek-ai/deepseek-v4-pro-0813', 'deepseek'],
      ['@cf/deepseek-ai/deepseek-v4.1-flash-1017', 'deepseek'],
    ]);
  });
});

describe('a DeepSeek model Pi characterises', () => {
  const v4Flash = '@cf/deepseek-ai/deepseek-v4-flash-0731';

  function captureBindingInputs() {
    /** The parts of the OpenAI-compatible body these tests read. */
    type CapturedInputs = { thinking?: { type: string }; messages?: ReadonlyArray<{ role: string }> };
    const calls: Array<{ model: string; inputs: CapturedInputs }> = [];
    const run = async (model: string, inputs: CapturedInputs) => {
      calls.push({ model, inputs });
      return new Response('{"errors":[{"message":"stop here"}]}', { status: 500 });
    };
    // SAFETY: the fake implements the one raw-response `run` call the binding fetch makes.
    return { calls, credentials: { binding: Object.assign({} as Ai, { run }) } };
  }

  it('sends a tool-calling transcript the way DeepSeek requires', async () => {
    const { calls, credentials } = captureBindingInputs();
    const handle = getPiModel(credentials, v4Flash, { gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED });
    const context = normalizeContext({
      systemPrompt: 'You are a builder.',
      tools: [READ_FILE_TOOL],
      messages: [
        { role: 'user', content: 'What is the project name?', timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_1', name: 'read_file', arguments: { path: 'package.json' } }],
          api: 'openai-completions',
          provider: 'cloudflare-workers-ai',
          model: v4Flash,
          usage: ZERO_USAGE,
          stopReason: 'toolUse',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'read_file',
          content: [{ type: 'text', text: '{"name":"demo"}' }],
          isError: false,
          timestamp: 3,
        },
      ],
    });

    for await (const _event of handle.stream(handle.model, context)) {
      // Drained: the fake binding ends the stream with an error after recording the request.
    }

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.model).toBe(v4Flash);
    // Pi writes `thinking: { type: 'disabled' }` when no level is asked for; CloudChef sends no
    // directive instead, so the model reasons at its own default.
    expect(call?.inputs).not.toHaveProperty('thinking');
    expect(call?.inputs).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', reasoning_content: '', tool_calls: expect.any(Array) }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
      ]),
    });
  });
});

describe("a gateway provider's model", () => {
  const opus = 'anthropic/claude-opus-5-5';

  /** The parts of a provider request body these tests read. */
  type CapturedBody = {
    model?: string;
    stream?: boolean;
    max_tokens?: number;
    thinking?: { type: string };
    tool_choice?: { type: string } | string;
    reasoning?: { effort?: string; summary?: string };
  };

  /** One universal request the gateway binding received. */
  type GatewayCall = {
    gatewayId: string;
    request: { provider: string; endpoint: string; headers: Record<string, string>; query: CapturedBody };
  };

  /** A gateway binding that records each request and answers it with `answer`. */
  function gatewayBinding(answer: (request: GatewayCall['request']) => Response) {
    const calls: GatewayCall[] = [];
    const gateway = (gatewayId: string) => ({
      run: async (request: GatewayCall['request']) => {
        calls.push({ gatewayId, request: structuredClone(request) });
        return answer(request);
      },
    });
    // SAFETY: the gateway transport calls only `gateway(id).run(request, options)`, which this implements.
    return { calls, credentials: { binding: Object.assign({} as Ai, { gateway }) } };
  }

  function sse(events: readonly object[], { named = false, done = false } = {}): Response {
    const lines = events.map(
      (event) =>
        `${named && 'type' in event ? `event: ${String(event.type)}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
    );
    return new Response(lines.join('') + (done ? 'data: [DONE]\n\n' : ''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  function anthropicStream(text: string, model = 'claude-opus-5-5'): Response {
    return sse(
      [
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
      { named: true },
    );
  }

  function openaiResponsesStream(text: string, model: string): Response {
    const message = {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    const usage = {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
    return sse(
      [
        { type: 'response.created', response: { id: 'resp_1', model, status: 'in_progress', output: [] } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...message, status: 'in_progress', content: [] },
        },
        {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          item_id: 'msg_1',
          part: { type: 'output_text', text: '', annotations: [] },
        },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: text },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_1', text },
        {
          type: 'response.content_part.done',
          output_index: 0,
          content_index: 0,
          item_id: 'msg_1',
          part: message.content[0],
        },
        { type: 'response.output_item.done', output_index: 0, item: message },
        {
          type: 'response.completed',
          response: { id: 'resp_1', model, status: 'completed', output: [message], usage },
        },
      ],
      { named: true },
    );
  }

  function chatCompletionsStream(text: string, model: string): Response {
    const chunk = (delta: { role?: 'assistant'; content?: string }, finish: 'stop' | null) => ({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const last = { ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    return sse([chunk({ role: 'assistant', content: text }, null), last], { done: true });
  }

  async function streamOnce(
    credentials: WorkersAiAccountCredentials,
    modelId: BuilderModelId,
    settings: { gatewayLogging?: WorkersAiGatewayLogging; gatewayKeyRevision?: string } = {},
    { reasoning, messages }: { reasoning?: 'high'; messages?: Message[] } = {},
  ) {
    const handle = getPiModel(credentials, modelId, { gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED, ...settings });
    const context = normalizeContext({
      systemPrompt: 'You are a builder.',
      tools: [READ_FILE_TOOL],
      messages: messages ?? [{ role: 'user', content: 'Build a todo app.', timestamp: 1 }],
    });
    return (await handle.stream(handle.model, context, { toolChoice: 'auto', reasoning })).result();
  }

  function headerNames(call: GatewayCall | undefined): string[] {
    return Object.keys(call?.request.headers ?? {}).map((name) => name.toLowerCase());
  }

  it("is described by Pi's catalog for its provider and spoken to over that provider's API", () => {
    const { credentials } = gatewayBinding(() => anthropicStream(''));
    expect(getPiModel(credentials, opus, { gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED }).model).toMatchObject({
      id: 'claude-opus-5-5',
      api: 'anthropic-messages',
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: { forceAdaptiveThinking: true },
    });
    expect(
      getPiModel(credentials, 'openai/gpt-5', { gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED }).model,
    ).toMatchObject({ id: 'gpt-5', api: 'openai-responses' });
    expect(
      getPiModel(credentials, 'grok/grok-4.3', { gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED }).model,
    ).toMatchObject({ id: 'grok-4.3', api: 'openai-responses' });
    expect(
      getPiModel(credentials, 'openrouter/openai/gpt-5', { gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED }).model,
    ).toMatchObject({
      id: 'openai/gpt-5',
      api: 'openai-completions',
    });
    expect(
      getPiModel(credentials, 'openrouter/anthropic/claude-fable-5', { gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED })
        .model,
    ).toMatchObject({
      id: 'anthropic/claude-fable-5',
      api: 'anthropic-messages',
    });
  });

  it("goes to the account's default gateway as an Anthropic request, carrying no key of its own", async () => {
    const { calls, credentials } = gatewayBinding(() => anthropicStream('Hello'));

    const message = await streamOnce(credentials, opus, {
      gatewayLogging: workersAiGatewayLogging(true, { chat: 'chat-1', user: 'ada' }),
    });

    expect(message.stopReason).toBe('stop');
    expect(message.content).toEqual([expect.objectContaining({ type: 'text', text: 'Hello' })]);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toMatchObject({ gatewayId: 'default', request: { provider: 'anthropic', endpoint: 'v1/messages' } });
    // The gateway adds the account's stored key only when the request carries none.
    expect(headerNames(call)).not.toContain('x-api-key');
    expect(headerNames(call)).not.toContain('authorization');
    expect(headerNames(call)).not.toContain('cf-aig-authorization');
    // The gateway uses the provider's key named default; it ignores any other on binding requests.
    expect(headerNames(call)).not.toContain('cf-aig-byok-alias');
    expect(call?.request.headers).toMatchObject({
      'anthropic-version': expect.any(String),
      'cf-aig-collect-log': 'true',
      'cf-aig-skip-cache': 'true',
      'cf-aig-metadata': JSON.stringify({ chat: 'chat-1', user: 'ada' }),
    });
    expect(call?.request.query).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      thinking: { type: 'adaptive' },
    });
    // A forced or even explicit tool choice is never sent alongside thinking.
    expect(call?.request.query).not.toHaveProperty('tool_choice');
    expect(Number(call?.request.query.max_tokens)).toBeLessThanOrEqual(128_000);
  });

  it.each([
    {
      modelId: 'openai/gpt-5' as const,
      provider: 'openai',
      endpoint: 'responses',
      model: 'gpt-5',
      answer: () => openaiResponsesStream('Hello', 'gpt-5'),
    },
    {
      modelId: 'grok/grok-4.3' as const,
      provider: 'grok',
      endpoint: 'v1/responses',
      model: 'grok-4.3',
      answer: () => openaiResponsesStream('Hello', 'grok-4.3'),
    },
    {
      modelId: 'openrouter/openai/gpt-5' as const,
      provider: 'openrouter',
      endpoint: 'v1/chat/completions',
      model: 'openai/gpt-5',
      answer: () => chatCompletionsStream('Hello', 'openai/gpt-5'),
    },
    {
      modelId: 'openrouter/anthropic/claude-fable-5' as const,
      provider: 'openrouter',
      endpoint: 'v1/messages',
      model: 'anthropic/claude-fable-5',
      answer: () => anthropicStream('Hello', 'anthropic/claude-fable-5'),
    },
  ])(
    'sends $modelId to the gateway as a $provider request at $endpoint, for the account key to be added',
    async ({ modelId, provider, endpoint, model, answer }) => {
      const { calls, credentials } = gatewayBinding(answer);

      const message = await streamOnce(credentials, modelId, { gatewayLogging: workersAiGatewayLogging(false) });

      expect(message.stopReason).toBe('stop');
      expect(message.content).toEqual([expect.objectContaining({ type: 'text', text: 'Hello' })]);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call).toMatchObject({ gatewayId: 'default', request: { provider, endpoint } });
      expect(call?.request.query).toMatchObject({ model, stream: true });
      expect(call?.request.headers).toMatchObject({ 'cf-aig-collect-log': 'false' });
      for (const credential of ['authorization', 'x-api-key', 'cf-aig-authorization', 'api-key']) {
        expect(headerNames(call)).not.toContain(credential);
      }
      expect(JSON.stringify(call?.request)).not.toContain('sk-ai-gateway-byok');
    },
  );

  it('is not logged when the person turned logging off, and says nothing of who sent it', async () => {
    const { calls, credentials } = gatewayBinding(() => anthropicStream('Hello'));

    await streamOnce(credentials, opus, {
      gatewayLogging: workersAiGatewayLogging(false, { chat: 'chat-1', user: 'ada' }),
    });
    await streamOnce(credentials, opus);

    expect(calls.map(({ request }) => request.headers['cf-aig-collect-log'])).toEqual(['false', 'false']);
    expect(calls.map(({ request }) => request.headers['cf-aig-metadata'])).toEqual([undefined, undefined]);
  });

  const unverified = () =>
    Response.json(
      {
        error: {
          message:
            'Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.',
          type: 'invalid_request_error',
          param: 'reasoning.summary',
          code: 'unsupported_value',
        },
      },
      { status: 400 },
    );

  it("asks an unverified OpenAI organization's key for reasoning summaries once, then never again", async () => {
    const { calls, credentials } = gatewayBinding((request) =>
      request.query.reasoning?.summary === undefined ? openaiResponsesStream('Hello', 'gpt-5') : unverified(),
    );

    const first = await streamOnce(credentials, 'openai/gpt-5', { gatewayKeyRevision: 'key-1' });

    expect(first.stopReason).toBe('stop');
    expect(calls.map(({ request }) => request.query.reasoning?.summary)).toEqual(['auto', undefined]);
    // The rest of the request is unchanged.
    expect(calls[1]?.request.query).toEqual({ ...calls[0]?.request.query, reasoning: undefined });

    await streamOnce(credentials, 'openai/gpt-5', { gatewayKeyRevision: 'key-1' });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.request.query.reasoning?.summary).toBeUndefined();

    // Another key on the same account is asked afresh.
    await streamOnce(credentials, 'openai/gpt-5', { gatewayKeyRevision: 'key-2' });
    expect(calls.slice(3).map(({ request }) => request.query.reasoning?.summary)).toEqual(['auto', undefined]);
  });

  it('asks a key that refused reasoning summaries for none even when the person chose an effort', async () => {
    const { calls, credentials } = gatewayBinding((request) =>
      request.query.reasoning?.summary === undefined ? openaiResponsesStream('Hello', 'gpt-5') : unverified(),
    );
    await streamOnce(credentials, 'openai/gpt-5', { gatewayKeyRevision: 'key-1' });
    expect(calls).toHaveLength(2);

    const chosen = await streamOnce(
      credentials,
      'openai/gpt-5',
      { gatewayKeyRevision: 'key-1' },
      { reasoning: 'high' },
    );

    expect(chosen.stopReason).toBe('stop');
    // Pi writes a summary itself beside a chosen effort; it never goes out, and only one request does.
    expect(calls).toHaveLength(3);
    expect(calls[2]?.request.query.reasoning).toEqual({ effort: 'high' });
  });

  it('asks a different key put in its place for reasoning summaries afresh', async () => {
    const { calls, credentials } = gatewayBinding((request) =>
      request.query.reasoning?.summary === undefined ? openaiResponsesStream('Hello', 'gpt-5') : unverified(),
    );
    const key = (gatewayKeyRevision: string) => ({ gatewayKeyRevision });

    await streamOnce(credentials, 'openai/gpt-5', key('key-1@2026-10-01'));
    await streamOnce(credentials, 'openai/gpt-5', key('key-1@2026-10-01'));
    await streamOnce(credentials, 'openai/gpt-5', key('key-2@2026-10-21'));

    expect(calls.map(({ request }) => request.query.reasoning?.summary)).toEqual([
      'auto',
      undefined,
      undefined,
      'auto',
      undefined,
    ]);
  });

  it('keeps reasoning summaries for a verified organization, and retries no other refusal', async () => {
    const verified = gatewayBinding(() => openaiResponsesStream('Hello', 'gpt-5'));
    await streamOnce(verified.credentials, 'openai/gpt-5');
    expect(verified.calls.map(({ request }) => request.query.reasoning?.summary)).toEqual(['auto']);

    const other = gatewayBinding(() =>
      Response.json(
        { error: { message: 'Invalid value for reasoning.summary', param: 'reasoning.summary' } },
        { status: 400 },
      ),
    );
    const refused = await streamOnce(other.credentials, 'openai/gpt-5');
    expect(refused.stopReason).toBe('error');
    expect(other.calls).toHaveLength(1);
  });

  describe("Claude's thinking replayed from the transcript", () => {
    const step = 'step-1';
    // The model as Pi names it on the messages it streams, which is what the transcript records.
    const claude = { provider: 'cloudflare-ai-gateway', api: 'anthropic-messages', model: 'claude-opus-5-5' };
    /** A turn whose one model response thought (once readably, once redacted), said why, and read two files. */
    const transcript: CloudChefMessage[] = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Build a todo app.' }] },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'Read both files first.',
            providerMetadata: signedThinkingMetadata(step, claude, 'sig-1'),
          },
          { type: 'reasoning', text: '', providerMetadata: redactedThinkingMetadata(step, claude, 'opaque-1') },
          { type: 'text', text: 'Reading the app.\n' },
          ...['a', 'b'].map((name) => ({
            type: 'dynamic-tool',
            toolName: 'read_file',
            toolCallId: `toolu_${name}`,
            state: 'output-available',
            input: { path: `/${name}.ts` },
            output: `${name} contents`,
            callProviderMetadata: toolStepMetadata(step),
          })),
        ],
      },
    ];

    /** The assistant and tool-result turns a request sent after the user's message. */
    function replayedTurns(call: GatewayCall | undefined): unknown[] {
      return z
        .object({ messages: z.array(z.unknown()) })
        .parse(call?.request.query)
        .messages.slice(1);
    }

    /** The replayed turns as a model that cannot read the thinking receives them: text and tool calls only. */
    const withoutThinking = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the app.\n' },
          expect.objectContaining({ type: 'tool_use', id: 'toolu_a' }),
          expect.objectContaining({ type: 'tool_use', id: 'toolu_b' }),
        ],
      },
      expect.objectContaining({ role: 'user' }),
    ];

    it('sends them back unchanged, with their signature, in the turn of the tool calls they preceded', async () => {
      const { calls, credentials } = gatewayBinding(() => anthropicStream('Both read.'));

      await streamOnce(credentials, opus, {}, { messages: transcriptToPiMessages(transcript) });

      expect(replayedTurns(calls[0])).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Read both files first.', signature: 'sig-1' },
            { type: 'redacted_thinking', data: 'opaque-1' },
            { type: 'text', text: 'Reading the app.\n' },
            { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: '/a.ts' } },
            { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: '/b.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_a' }),
            expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_b' }),
          ],
        },
      ]);
    });

    it('leaves them out for any other model, which cannot read them', async () => {
      const sonnet = gatewayBinding(() => anthropicStream('Both read.', 'claude-sonnet-4-6'));
      const gpt = gatewayBinding(() => chatCompletionsStream('Both read.', 'openai/gpt-5'));

      await streamOnce(
        sonnet.credentials,
        'anthropic/claude-sonnet-4-6',
        {},
        { messages: transcriptToPiMessages(transcript) },
      );
      await streamOnce(
        gpt.credentials,
        'openrouter/openai/gpt-5',
        {},
        { messages: transcriptToPiMessages(transcript) },
      );

      expect(replayedTurns(sonnet.calls[0])).toEqual(withoutThinking);
      for (const call of [sonnet.calls[0], gpt.calls[0]]) {
        const body = JSON.stringify(call?.request.query);
        expect(body).not.toContain('sig-1');
        expect(body).not.toContain('opaque-1');
        expect(body).toContain('toolu_b');
      }
    });

    it('sends the conversation once more without them when Claude refuses their signature', async () => {
      const { calls, credentials } = gatewayBinding((request) =>
        JSON.stringify(request.query).includes('sig-1')
          ? Response.json(
              {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message:
                    'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
                },
              },
              { status: 400 },
            )
          : anthropicStream('Both read.'),
      );

      const message = await streamOnce(credentials, opus, {}, { messages: transcriptToPiMessages(transcript) });

      expect(message.stopReason).toBe('stop');
      expect(calls).toHaveLength(2);
      expect(replayedTurns(calls[1])).toEqual(withoutThinking);
    });

    it('retries no other refusal, and none for a request without thinking', async () => {
      const refusal = (message: string) => () =>
        Response.json({ type: 'error', error: { type: 'invalid_request_error', message } }, { status: 400 });
      const other = gatewayBinding(refusal('max_tokens: too large'));
      const bare = gatewayBinding(refusal('Invalid `signature` in `thinking` block'));

      await streamOnce(other.credentials, opus, {}, { messages: transcriptToPiMessages(transcript) });
      await streamOnce(bare.credentials, opus);

      expect(other.calls).toHaveLength(1);
      expect(bare.calls).toHaveLength(1);
    });
  });

  it('sends a refused key’s request once, and reports the refusal', async () => {
    const { calls, credentials } = gatewayBinding(() =>
      Response.json({ type: 'error', error: { type: 'authentication_error', message: 'no key' } }, { status: 401 }),
    );
    const refused = await streamOnce(credentials, opus);
    expect(refused.errorMessage).toContain(gatewayKeyRejectedMessage('anthropic'));
    expect(calls).toHaveLength(1);
  });

  it('reports a missing or rejected key as one the account must fix in Settings, naming the provider', async () => {
    const refused = () =>
      Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        { status: 401 },
      );
    const { credentials } = gatewayBinding(refused);

    const claude = await streamOnce(credentials, opus);
    const gpt = await streamOnce(credentials, 'openai/gpt-5');

    expect(claude.stopReason).toBe('error');
    expect(claude.errorMessage).toContain(gatewayKeyRejectedMessage('anthropic'));
    expect(gpt.stopReason).toBe('error');
    expect(gpt.errorMessage).toContain(gatewayKeyRejectedMessage('openai'));
  });
});

describe('the gateway options a model request is sent with', () => {
  /** The gateway options the binding receives for one title request made with `gatewayLogging`. */
  async function gatewayOf(gatewayLogging: WorkersAiGatewayLogging): Promise<WorkersAiGatewayOptions | undefined> {
    const received: (WorkersAiGatewayOptions | undefined)[] = [];
    const binding = {
      run: async (_model: string, _inputs: Record<string, string>, options: { gateway?: WorkersAiGatewayOptions }) => {
        received.push(options.gateway);
        return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    };
    // SAFETY: the binding adapter calls only `run`, with the raw-response options this stand-in reads.
    const handle = getPiModel({ binding: binding as Ai }, CLOUDFLARE_PROJECT_TITLE_MODEL, {
      gatewayLogging,
    });
    await completeText(handle, { prompt: 'Name this', temperature: 0 }).catch(() => '');
    expect(received).toHaveLength(1);
    return received[0];
  }

  it("carries the person's choice to the binding, and logs nothing the person didn't allow", async () => {
    expect(await gatewayOf(workersAiGatewayLogging(true, { chat: 'chat-1' }))).toEqual({
      id: 'default',
      collectLog: true,
      skipCache: true,
      metadata: { chat: 'chat-1' },
    });
    expect(await gatewayOf(workersAiGatewayLogging(false, { chat: 'chat-1' }))).toEqual({
      id: 'default',
      collectLog: false,
      skipCache: true,
    });
  });
});

describe('the output budget a Workers AI request asks for', () => {
  async function maxCompletionTokens(maxTokens?: number): Promise<number | undefined> {
    const sent: Array<{ max_completion_tokens?: number }> = [];
    const run = async (_model: string, inputs: { max_completion_tokens?: number }) => {
      sent.push(inputs);
      return Response.json({ errors: [{ message: 'stop here' }] }, { status: 400 });
    };
    // SAFETY: the binding fetch calls only the raw-response `run`, which this implements.
    const handle = getPiModel({ binding: Object.assign({} as Ai, { run }) }, CLOUDFLARE_PROJECT_TITLE_MODEL, {
      gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED,
    });
    const context = normalizeContext({ messages: [{ role: 'user', content: 'Name this', timestamp: 1 }] });
    await handle.stream(handle.model, context, maxTokens === undefined ? {} : { maxTokens }).result();
    return sent[0]?.max_completion_tokens;
  }

  it('keeps a small budget the caller chose, and lifts only an unstated one to the floor', async () => {
    expect(await maxCompletionTokens(64)).toBe(64);
    expect(await maxCompletionTokens()).toBeGreaterThanOrEqual(4_096);
  });

  it('lets go of a refused response it corrects and sends again', async () => {
    let cancelled = 0;
    /** A refusal whose clone is read and whose own body is only ever cancelled. */
    class Refusal extends Response {
      constructor(private readonly message: string) {
        super(
          new ReadableStream({
            cancel: () => {
              cancelled += 1;
            },
          }),
          { status: 400 },
        );
      }

      override clone(): Response {
        return new Response(this.message, { status: 400 });
      }
    }
    const sent: Array<{ max_completion_tokens?: number }> = [];
    const run = async (_model: string, inputs: { max_completion_tokens?: number }) => {
      sent.push(inputs);
      return sent.length === 1
        ? new Refusal('This model supports at most 64 completion tokens.')
        : Response.json({ errors: [{ message: 'stop here' }] }, { status: 400 });
    };
    // SAFETY: the binding fetch calls only the raw-response `run`, which this implements.
    const handle = getPiModel({ binding: Object.assign({} as Ai, { run }) }, CLOUDFLARE_PROJECT_TITLE_MODEL, {
      gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED,
    });
    const context = normalizeContext({ messages: [{ role: 'user', content: 'Name this', timestamp: 1 }] });

    await handle.stream(handle.model, context, {}).result();

    expect(sent.map((inputs) => inputs.max_completion_tokens).at(-1)).toBe(64);
    expect(cancelled).toBe(1);
  });
});

describe('a Workers AI request body CloudChef cannot read', () => {
  it('goes to the binding as written, without its model, as a gateway request would', async () => {
    const sent: Array<{ model: string; inputs: ProviderRequestBody }> = [];
    const run = async (model: string, inputs: ProviderRequestBody) => {
      sent.push({ model, inputs });
      return Response.json({ errors: [{ message: 'stop here' }] }, { status: 400 });
    };
    // SAFETY: the binding fetch calls only the raw-response `run`, which this implements.
    const handle = getPiModel({ binding: Object.assign({} as Ai, { run }) }, CLOUDFLARE_PROJECT_TITLE_MODEL, {
      gatewayLogging: WORKERS_AI_GATEWAY_UNLOGGED,
    });
    const context = normalizeContext({ messages: [{ role: 'user', content: 'Name this', timestamp: 1 }] });

    // `thinking` as a number is no shape Pi writes, so the body can't be read as one.
    const message = await handle
      .stream(handle.model, context, {
        onPayload: (payload) => Object.assign(z.looseObject({}).parse(payload), { thinking: 7 }),
      })
      .result();

    expect(message.stopReason).toBe('error');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.model).toBe(CLOUDFLARE_PROJECT_TITLE_MODEL);
    expect(sent[0]?.inputs).toMatchObject({ thinking: 7, stream: true });
    expect(Object.keys(sent[0]?.inputs ?? {})).not.toContain('model');
  });
});
