import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { normalizeContext } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { CLOUDFLARE_ALTERNATIVE_BUILDER_MODEL, CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';
import { getPiModel } from './pi-ai-models';
import { completeText } from './pi-ai-invoke';
import {
  workersAiGatewayLogging,
  type WorkersAiGatewayLogging,
  type WorkersAiGatewayOptions,
} from './workers-ai-gateway';

/**
 * The title call site deliberately pass no `WorkersAiModel`, because pi-ai's own
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
 *
 * The pin lists Pi's catalog, not what CloudChef serves: the builder's alternative model,
 * deepseek-v4.1-flash-1017, is not in Pi's catalog at all and borrows the v4-flash-0731 entry through
 * `PI_CATALOG_SIBLINGS`. That is deliberate and pinned separately below, so the day Pi lists v4.1
 * itself, both pins go red together and the borrowed entry is dropped rather than left to shadow
 * nothing.
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

describe('a builder model Pi does not list yet', () => {
  const v41Flash = CLOUDFLARE_ALTERNATIVE_BUILDER_MODEL;
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

  it('is absent from Pi, so the sibling mapping is still needed', () => {
    expect(v41Flash).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
    expect(Object.keys(CLOUDFLARE_WORKERS_AI_MODELS)).not.toContain(v41Flash);
    expect(Object.keys(CLOUDFLARE_WORKERS_AI_MODELS)).toContain(v4Flash);
  });

  it("takes its request shape from Pi's V4 Flash entry and its own published rates", () => {
    const { credentials } = captureBindingInputs();
    const sibling = getPiModel(credentials, v4Flash).model;
    const model = getPiModel(credentials, v41Flash).model;

    expect(model.compat).toEqual(sibling.compat);
    expect(model.compat).toMatchObject({
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(model).toMatchObject({
      id: v41Flash,
      name: v41Flash,
      reasoning: true,
      contextWindow: 1_048_576,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    });
  });

  it('sends a tool-calling transcript the way DeepSeek requires', async () => {
    const { calls, credentials } = captureBindingInputs();
    const handle = getPiModel(credentials, v41Flash);
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const context = normalizeContext({
      systemPrompt: 'You are a builder.',
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          parameters: z.toJSONSchema(z.object({ path: z.string() })),
        },
      ],
      messages: [
        { role: 'user', content: 'What is the project name?', timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_1', name: 'read_file', arguments: { path: 'package.json' } }],
          api: 'openai-completions',
          provider: 'cloudflare-workers-ai',
          model: v41Flash,
          usage,
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
    expect(call?.model).toBe(v41Flash);
    expect(call?.inputs).toMatchObject({
      thinking: { type: 'disabled' },
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', reasoning_content: '', tool_calls: expect.any(Array) }),
        expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
      ]),
    });
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
