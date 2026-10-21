import { describe, expect, it } from 'vitest';
import { normalizeContext, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { z } from 'zod';
import { GATEWAY_PROVIDER_SLUGS, isWorkersAiModelId, type BuilderModelId } from '~/lib/workers-ai-model';
import { getPiModel, type ModelStreamOptions } from './pi-ai-models';
import { gatewayBuilderModels, piGatewayModel } from './pi-model-catalog';
import {
  providerRequestBodySchema,
  withProviderDefaultReasoning,
  type ProviderRequestBody,
} from './provider-default-reasoning';

const READ_FILE_TOOL = {
  name: 'read_file',
  description: 'Read a file.',
  parameters: z.toJSONSchema(z.object({ path: z.string() })),
};

/** One universal request the gateway binding received, its body read as the transport reads it. */
type GatewayRequest = {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: ProviderRequestBody;
};

/** A binding whose gateway records each universal request and answers it with `answer`. */
function gatewayBinding(answer: (request: GatewayRequest) => Response) {
  const requests: GatewayRequest[] = [];
  const gateway = () => ({
    run: async (request: GatewayRequest) => {
      const recorded = { ...structuredClone(request), query: providerRequestBodySchema.parse(request.query) };
      requests.push(recorded);
      return answer(recorded);
    },
  });
  // SAFETY: the gateway transport calls only `gateway(id).run(request, options)`, which this implements.
  return { requests, credentials: { binding: Object.assign({} as Ai, { gateway }) } };
}

/** A binding whose Workers AI `run` records each request body, refusing it so the stream ends. */
function workersAiBinding() {
  const bodies: ProviderRequestBody[] = [];
  const run = async (_model: string, inputs: ProviderRequestBody) => {
    bodies.push(providerRequestBodySchema.parse(structuredClone(inputs)));
    return Response.json({ errors: [{ message: 'stop here' }] }, { status: 400 });
  };
  // SAFETY: the binding fetch calls only the raw-response `run`, which this implements.
  return { bodies, credentials: { binding: Object.assign({} as Ai, { run }) } };
}

const refused = () =>
  Response.json({ error: { type: 'invalid_request_error', message: 'stop here' } }, { status: 400 });

function sse<Event extends { type: string }>(events: readonly Event[]): Response {
  const lines = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function userContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: 'You are a builder.',
    tools: [READ_FILE_TOOL],
    messages: [{ role: 'user', content: 'Build a todo app.', timestamp: 1 }],
  });
}

async function streamOnce(
  credentials: { binding: Ai },
  modelId: BuilderModelId,
  context: TranscriptContext = userContext(),
  options: ModelStreamOptions = {},
  settings: { sessionAffinity?: string } = {},
): Promise<AssistantMessage> {
  const handle = getPiModel(credentials, modelId, settings);
  return handle.stream(handle.model, context, { toolChoice: 'auto', ...options }).result();
}

const OFF = new Set(['none', 'off']);

/** Every place a body could tell a model to stop reasoning, as `field=value` strings. */
function reasoningOffDirectives(body: ProviderRequestBody): string[] {
  const found: string[] = [];
  if (body.reasoning?.effort !== undefined && OFF.has(body.reasoning.effort)) {
    found.push(`reasoning.effort=${body.reasoning.effort}`);
  }
  if (body.reasoning?.enabled === false) {
    found.push('reasoning.enabled=false');
  }
  if (body.reasoning_effort !== undefined && OFF.has(body.reasoning_effort)) {
    found.push(`reasoning_effort=${body.reasoning_effort}`);
  }
  const thinkingObject = z.looseObject({ type: z.string() }).safeParse(body.thinking);
  if (thinkingObject.success && thinkingObject.data.type === 'disabled') {
    found.push('thinking.type=disabled');
  }
  const thinkingString = z.string().safeParse(body.thinking);
  if (thinkingString.success && OFF.has(thinkingString.data)) {
    found.push(`thinking=${thinkingString.data}`);
  }
  if (body.enable_thinking === false) {
    found.push('enable_thinking=false');
  }
  for (const field of ['chat_template_kwargs', 'chat_template_args'] as const) {
    if (body[field]?.enable_thinking === false) {
      found.push(`${field}.enable_thinking=false`);
    }
  }
  return found;
}

describe('a reasoning model asked for no level', () => {
  const gatewayReasoningModels = gatewayBuilderModels(GATEWAY_PROVIDER_SLUGS).filter((model) => model.reasoning);

  it('covers every API the gateway carries', () => {
    const apis = new Set(gatewayReasoningModels.map((model) => piGatewayModel(model.id)?.api));
    expect([...apis].sort()).toEqual(['anthropic-messages', 'openai-completions', 'openai-responses']);
  });

  it('is never told to stop reasoning, on any gateway provider', async () => {
    const { requests, credentials } = gatewayBinding(refused);
    const offenders: string[] = [];
    for (const model of gatewayReasoningModels) {
      requests.length = 0;
      await streamOnce(credentials, model.id);
      expect(requests, model.id).toHaveLength(1);
      const [request] = requests;
      const directives = reasoningOffDirectives(request!.query);
      if (directives.length > 0) {
        offenders.push(`${model.id}: ${directives.join(', ')}`);
      }
      const api = piGatewayModel(model.id)?.api;
      if (api === 'openai-responses') {
        // `store: false` means replayed reasoning needs its encrypted content, on every request.
        expect(request!.query.include, model.id).toContain('reasoning.encrypted_content');
      }
      const piModel = piGatewayModel(model.id)?.model;
      if (piModel?.api === 'anthropic-messages') {
        const thinking = z
          .looseObject({ type: z.string(), budget_tokens: z.number().optional() })
          .parse(request!.query.thinking);
        const compat = piModel.compat;
        if (compat !== undefined && 'forceAdaptiveThinking' in compat && compat.forceAdaptiveThinking === true) {
          expect(thinking, model.id).toMatchObject({ type: 'adaptive' });
          expect(thinking, model.id).not.toHaveProperty('budget_tokens');
        } else {
          // Anthropic has no default budget, so no level thinks at the "High" one, under the ceiling.
          const maxTokens = z.number().parse(request!.query.max_tokens);
          expect(thinking, model.id).toMatchObject({
            type: 'enabled',
            budget_tokens: Math.min(16_384, maxTokens - 1_024),
          });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is never told to stop reasoning on Workers AI', async () => {
    const reasoningModels = Object.values(CLOUDFLARE_WORKERS_AI_MODELS).filter(
      (model) => model.reasoning && isWorkersAiModelId(model.id),
    );
    expect(reasoningModels.length).toBeGreaterThan(0);
    const { bodies, credentials } = workersAiBinding();
    const offenders: string[] = [];
    for (const model of reasoningModels) {
      bodies.length = 0;
      await streamOnce(credentials, model.id);
      expect(bodies.length, model.id).toBeGreaterThan(0);
      const directives = reasoningOffDirectives(bodies[0]!);
      if (directives.length > 0) {
        offenders.push(`${model.id}: ${directives.join(', ')}`);
      }
      // No level means no effort at all: the model reasons at its own default.
      expect(bodies[0], model.id).not.toHaveProperty('reasoning_effort');
    }
    expect(offenders).toEqual([]);
  });

  it('leaves the effort to OpenAI and asks it for reasoning summaries', async () => {
    const { requests, credentials } = gatewayBinding(refused);
    await streamOnce(credentials, 'openai/gpt-6-luna');
    expect(requests[0]?.query).toMatchObject({ store: false, reasoning: { summary: 'auto' } });
    expect(requests[0]?.query.reasoning).not.toHaveProperty('effort');
  });

  it('gives a budget-thinking Claude the "High" budget, and an adaptive one no budget', async () => {
    const { requests, credentials } = gatewayBinding(refused);
    await streamOnce(credentials, 'anthropic/claude-sonnet-4-5');
    await streamOnce(credentials, 'anthropic/claude-opus-5-5');
    expect(requests[0]?.query).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 16_384 } });
    expect(requests[1]?.query.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('sends grok-4.3 and an OpenRouter reasoning model no effort at all', async () => {
    const { requests, credentials } = gatewayBinding(refused);
    await streamOnce(credentials, 'grok/grok-4.3');
    await streamOnce(credentials, 'openrouter/openai/gpt-5.1');
    expect(requests[0]?.query).not.toHaveProperty('reasoning');
    expect(requests[0]?.query.include).toContain('reasoning.encrypted_content');
    expect(requests[1]?.query).not.toHaveProperty('reasoning');
    expect(requests[1]?.query).not.toHaveProperty('reasoning_effort');
  });
});

describe('a reasoning model asked for a level', () => {
  it('carries that level to the provider in its own vocabulary', async () => {
    const { requests, credentials } = gatewayBinding(refused);
    await streamOnce(credentials, 'openai/gpt-6-luna', userContext(), { reasoning: 'high' });
    await streamOnce(credentials, 'openrouter/openai/gpt-5.1', userContext(), { reasoning: 'medium' });
    await streamOnce(credentials, 'anthropic/claude-opus-5-5', userContext(), { reasoning: 'xhigh' });

    expect(requests[0]?.query).toMatchObject({ reasoning: { effort: 'high' } });
    expect(requests[0]?.query.include).toContain('reasoning.encrypted_content');
    expect(requests[1]?.query).toMatchObject({ reasoning: { effort: 'medium' } });
    expect(requests[2]?.query).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } });
  });

  it('gives a budget-thinking Claude a budget for that level', async () => {
    const { requests, credentials } = gatewayBinding(refused);
    await streamOnce(credentials, 'anthropic/claude-sonnet-4-5', userContext(), { reasoning: 'medium' });
    expect(requests[0]?.query).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 8_192 } });
  });

  it('carries a Workers AI level as written', async () => {
    const { bodies, credentials } = workersAiBinding();
    await streamOnce(credentials, '@cf/openai/gpt-oss-120b', userContext(), { reasoning: 'medium' });
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'medium' });
  });
});

describe('a two-step tool turn on OpenAI Responses', () => {
  const ENCRYPTED = 'gAAAA-encrypted-reasoning';

  /** A first step that reasons, then calls `read_file`; Pi keeps the reasoning item as the signature. */
  function reasoningThenToolCall(model: string): Response {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Read the manifest first.' }],
      encrypted_content: ENCRYPTED,
    };
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"package.json"}',
      status: 'completed',
    };
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 3 },
    };
    return sse([
      { type: 'response.created', response: { id: 'resp_1', model, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: call.arguments },
      { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_1', arguments: call.arguments },
      { type: 'response.output_item.done', output_index: 1, item: call },
      {
        type: 'response.completed',
        response: { id: 'resp_1', model, status: 'completed', output: [reasoning, call], usage },
      },
    ]);
  }

  it.each(['openai/gpt-5.5', 'openai/gpt-6-luna'] as const)(
    '%s replays the first step with its encrypted reasoning',
    async (modelId) => {
      const { requests, credentials } = gatewayBinding((request) =>
        requests.length === 1 ? reasoningThenToolCall(String(request.query.model)) : refused(),
      );
      const context = userContext();
      const first = await streamOnce(credentials, modelId, context);
      expect(first.stopReason).toBe('toolUse');

      const second: TranscriptContext = {
        ...context,
        messages: [
          ...context.messages,
          first,
          {
            role: 'toolResult',
            toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
            toolName: 'read_file',
            content: [{ type: 'text', text: '{"name":"demo"}' }],
            isError: false,
            timestamp: 3,
          },
        ],
      };
      await streamOnce(credentials, modelId, second);

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.query).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
        expect(reasoningOffDirectives(request.query)).toEqual([]);
      }
      const input = requests[1]!.query.input ?? [];
      expect(input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', id: 'rs_1', encrypted_content: ENCRYPTED }),
          expect.objectContaining({ type: 'function_call', id: 'fc_1', call_id: 'call_1' }),
          expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
        ]),
      );
      const reasoningAt = input.findIndex((item) => item.type === 'reasoning');
      expect(input[reasoningAt + 1]).toMatchObject({ type: 'function_call', id: 'fc_1' });
    },
  );

  it("keys a chat's requests to its cached prefix", async () => {
    const { requests, credentials } = gatewayBinding(refused);
    await streamOnce(credentials, 'openai/gpt-5.5', userContext(), {}, { sessionAffinity: 'chat-affinity-1' });
    expect(requests[0]?.query).toMatchObject({ prompt_cache_key: 'chat-affinity-1' });
  });
});

describe('withProviderDefaultReasoning', () => {
  const responsesModel = piGatewayModel('openai/gpt-6-luna')!.model;
  const completionsModel = piGatewayModel('openrouter/openai/gpt-5.1')!.model;

  it('drops replayed reasoning it cannot replay, and unpairs the tool calls that followed it', () => {
    const body = withProviderDefaultReasoning(
      responsesModel,
      {
        input: [
          { role: 'user', content: 'go' },
          { type: 'reasoning', id: 'rs_lost', summary: [] },
          { type: 'function_call', id: 'fc_a', call_id: 'a', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'a', output: 'ok' },
          { type: 'reasoning', id: 'rs_kept', summary: [], encrypted_content: 'x' },
          { type: 'function_call', id: 'fc_b', call_id: 'b', name: 'read_file', arguments: '{}' },
        ],
      },
      { requested: false },
    );
    expect(body.input).toEqual([
      { role: 'user', content: 'go' },
      { type: 'function_call', call_id: 'a', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'ok' },
      { type: 'reasoning', id: 'rs_kept', summary: [], encrypted_content: 'x' },
      { type: 'function_call', id: 'fc_b', call_id: 'b', name: 'read_file', arguments: '{}' },
    ]);
  });

  it("unpairs the assistant's message from reasoning it cannot replay, and only that", () => {
    const message = (id: string) => ({
      type: 'message',
      role: 'assistant',
      id,
      status: 'completed',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
    });
    const body = withProviderDefaultReasoning(
      responsesModel,
      {
        input: [
          { role: 'user', content: 'go' },
          { type: 'reasoning', id: 'rs_lost', summary: [] },
          message('msg_lost'),
          { role: 'user', content: 'again' },
          { type: 'reasoning', id: 'rs_kept', summary: [], encrypted_content: 'x' },
          message('msg_kept'),
          { role: 'user', content: 'and again' },
          message('msg_alone'),
        ],
      },
      { requested: false },
    );
    // An output message's id is required, so it gets a made-up one, the same every time it's replayed.
    const unpaired = body.input?.[1]?.id;
    expect(unpaired).toMatch(/^msg_cc_[0-9a-f]{8}$/);
    expect(
      withProviderDefaultReasoning(
        responsesModel,
        { input: [{ type: 'reasoning', id: 'rs_lost', summary: [] }, message('msg_lost')] },
        { requested: false },
      ).input?.[0]?.id,
    ).toBe(unpaired);
    expect(body.input).toEqual([
      { role: 'user', content: 'go' },
      message(unpaired ?? ''),
      { role: 'user', content: 'again' },
      { type: 'reasoning', id: 'rs_kept', summary: [], encrypted_content: 'x' },
      message('msg_kept'),
      { role: 'user', content: 'and again' },
      message('msg_alone'),
    ]);
  });

  it('asks for no reasoning summary, even one Pi wrote beside a chosen effort, once the key refused them', () => {
    expect(
      withProviderDefaultReasoning(
        responsesModel,
        { reasoning: { effort: 'high', summary: 'auto' } },
        { requested: true, summaries: 'refused' },
      ).reasoning,
    ).toEqual({ effort: 'high' });
    expect(
      withProviderDefaultReasoning(
        responsesModel,
        { reasoning: { summary: 'auto' } },
        { requested: true, summaries: 'refused' },
      ),
    ).not.toHaveProperty('reasoning');
    expect(
      withProviderDefaultReasoning(
        responsesModel,
        { reasoning: { effort: 'high', summary: 'auto' } },
        { requested: true, summaries: false },
      ).reasoning,
    ).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('never strips a level the caller asked for', () => {
    expect(
      withProviderDefaultReasoning(responsesModel, { reasoning: { effort: 'none' } }, { requested: true }).reasoning,
    ).toEqual({ effort: 'none' });
    expect(
      withProviderDefaultReasoning(completionsModel, { reasoning: { effort: 'none' } }, { requested: true }).reasoning,
    ).toEqual({ effort: 'none' });
  });

  it('removes only what means off, keeping the rest of a directive', () => {
    expect(
      withProviderDefaultReasoning(
        completionsModel,
        { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true }, reasoning_effort: 'low' },
        { requested: false },
      ),
    ).toEqual({ chat_template_kwargs: { preserve_thinking: true }, reasoning_effort: 'low' });
  });

  it('leaves a non-reasoning model alone', () => {
    const plain = { ...completionsModel, reasoning: false };
    expect(withProviderDefaultReasoning(plain, { reasoning_effort: 'none' }, { requested: false })).toEqual({
      reasoning_effort: 'none',
    });
  });
});
