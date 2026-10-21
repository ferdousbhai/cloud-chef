import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { normalizeContext } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { CLOUDFLARE_PROJECT_TITLE_MODEL, type BuilderModelId } from '~/lib/workers-ai-model';
import { gatewayKeyRejectedMessage, getPiModel, type WorkersAiAccountCredentials } from './pi-ai-models';
import { completeText } from './pi-ai-invoke';
import {
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
    const handle = getPiModel(credentials, v4Flash);
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
  };

  /** One universal request the gateway binding received. */
  type GatewayCall = {
    gatewayId: string;
    request: { provider: string; endpoint: string; headers: Record<string, string>; query: CapturedBody };
  };

  /** A gateway binding that records each request and answers it with `answer`. */
  function gatewayBinding(answer: () => Response) {
    const calls: GatewayCall[] = [];
    const gateway = (gatewayId: string) => ({
      run: async (request: GatewayCall['request']) => {
        calls.push({ gatewayId, request });
        return answer();
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
    settings: { gatewayLogging?: WorkersAiGatewayLogging; gatewayKeyAlias?: string } = {},
  ) {
    const handle = getPiModel(credentials, modelId, settings);
    const context = normalizeContext({
      systemPrompt: 'You are a builder.',
      tools: [READ_FILE_TOOL],
      messages: [{ role: 'user', content: 'Build a todo app.', timestamp: 1 }],
    });
    return (await handle.stream(handle.model, context, { toolChoice: 'auto' })).result();
  }

  function headerNames(call: GatewayCall | undefined): string[] {
    return Object.keys(call?.request.headers ?? {}).map((name) => name.toLowerCase());
  }

  it("is described by Pi's catalog for its provider and spoken to over that provider's API", () => {
    const { credentials } = gatewayBinding(() => anthropicStream(''));
    expect(getPiModel(credentials, opus).model).toMatchObject({
      id: 'claude-opus-5-5',
      api: 'anthropic-messages',
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      compat: { forceAdaptiveThinking: true },
    });
    expect(getPiModel(credentials, 'openai/gpt-5').model).toMatchObject({ id: 'gpt-5', api: 'openai-responses' });
    expect(getPiModel(credentials, 'grok/grok-4.3').model).toMatchObject({ id: 'grok-4.3', api: 'openai-responses' });
    expect(getPiModel(credentials, 'openrouter/openai/gpt-5').model).toMatchObject({
      id: 'openai/gpt-5',
      api: 'openai-completions',
    });
    expect(getPiModel(credentials, 'openrouter/anthropic/claude-fable-5').model).toMatchObject({
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
    // The provider's default key needs no alias.
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
    'sends $modelId to the gateway as a $provider request at $endpoint, under the account key alias it was given',
    async ({ modelId, provider, endpoint, model, answer }) => {
      const { calls, credentials } = gatewayBinding(answer);

      const message = await streamOnce(credentials, modelId, {
        gatewayLogging: workersAiGatewayLogging(false),
        gatewayKeyAlias: 'team-key',
      });

      expect(message.stopReason).toBe('stop');
      expect(message.content).toEqual([expect.objectContaining({ type: 'text', text: 'Hello' })]);
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call).toMatchObject({ gatewayId: 'default', request: { provider, endpoint } });
      expect(call?.request.query).toMatchObject({ model, stream: true });
      expect(call?.request.headers).toMatchObject({ 'cf-aig-byok-alias': 'team-key', 'cf-aig-collect-log': 'false' });
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
  async function gatewayOf(gatewayLogging?: WorkersAiGatewayLogging): Promise<WorkersAiGatewayOptions | undefined> {
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
    await completeText(handle, { prompt: 'Name this' }).catch(() => '');
    expect(received).toHaveLength(1);
    return received[0];
  }

  it("carries the person's choice to the binding, and logs nothing a caller didn't say it may", async () => {
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
    expect(await gatewayOf()).toEqual({ id: 'default', collectLog: false, skipCache: true });
  });
});

describe('the output budget a Workers AI request asks for', () => {
  async function maxCompletionTokens(maxTokens?: number): Promise<unknown> {
    const sent: Array<Record<string, unknown>> = [];
    const run = async (_model: string, inputs: Record<string, unknown>) => {
      sent.push(inputs);
      return Response.json({ errors: [{ message: 'stop here' }] }, { status: 400 });
    };
    // SAFETY: the binding fetch calls only the raw-response `run`, which this implements.
    const handle = getPiModel({ binding: Object.assign({} as Ai, { run }) }, CLOUDFLARE_PROJECT_TITLE_MODEL);
    const context = normalizeContext({ messages: [{ role: 'user', content: 'Name this', timestamp: 1 }] });
    await handle.stream(handle.model, context, maxTokens === undefined ? {} : { maxTokens }).result();
    return sent[0]?.max_completion_tokens;
  }

  it('keeps a small budget the caller chose, and lifts only an unstated one to the floor', async () => {
    expect(await maxCompletionTokens(64)).toBe(64);
    expect(await maxCompletionTokens()).toBeGreaterThanOrEqual(4_096);
  });
});
