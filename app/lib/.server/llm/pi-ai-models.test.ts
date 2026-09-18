import { describe, expect, it, vi } from 'vitest';
import { Type, type Message } from '@earendil-works/pi-ai';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import {
  CLOUDFLARE_CONTEXT_SUMMARY_MODEL,
  CLOUDFLARE_PROJECT_TITLE_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  type WorkersAiModel,
} from '~/lib/workers-ai-model';
import { getPiModel, type ModelStreamOptions } from './pi-ai-models';

/** The OpenAI-compatible body and binding options the adapter forwards, as this test reads them. */
type BindingInputs = {
  model?: string;
  messages?: unknown[];
  tools?: unknown[];
  stream?: boolean;
  tool_choice?: unknown;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  thinking?: unknown;
};
type BindingOptions = {
  returnRawResponse?: boolean;
  signal?: AbortSignal;
  extraHeaders?: { 'x-session-affinity'?: string };
  gateway?: { id: string; collectLog: boolean; skipCache: boolean };
};

/**
 * The title and summary call sites deliberately pass no `WorkersAiModel`, because pi-ai's own
 * static catalog already describes llama-4-scout correctly. That is an assumption about a
 * dependency, not about this repository: if an upgrade drops the entry or shrinks its window,
 * `getPiModel` silently substitutes its 128k non-reasoning defaults and the summarizer quietly
 * loses window instead of failing. This makes that upgrade turn `validate` red.
 */
describe('pinned title and summary models in the pi-ai catalog', () => {
  const piCatalog = new Map<string, { api: string; contextWindow: number }>(
    Object.entries(CLOUDFLARE_WORKERS_AI_MODELS),
  );

  it.each([CLOUDFLARE_PROJECT_TITLE_MODEL, CLOUDFLARE_CONTEXT_SUMMARY_MODEL])('describes %s', (modelId) => {
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
 * Today that spread carries nothing: Pi ships these entries with a compat block that omits the key
 * entirely, reasoning models included. That is an assumption about a dependency rather than about
 * this repository, and it is the assumption the deletion of CloudChef's own prefix map rests on.
 * If a Pi upgrade starts characterising a Workers AI model, every request for it silently changes
 * shape — a `thinking` block, an `enable_thinking` flag, a `chat_template_kwargs` — without anyone
 * deciding to send one. This turns that upgrade into a red `validate` and a decision.
 */
describe('Pi Workers AI catalog thinking formats', () => {
  const entries = Object.entries(CLOUDFLARE_WORKERS_AI_MODELS);

  it('leaves the thinking format to Pi, which characterises none of its Workers AI entries', () => {
    expect(entries.filter(([, model]) => model.reasoning).length).toBeGreaterThan(0);

    expect(
      entries.filter(([, model]) => model.compat?.thinkingFormat !== undefined).map(([modelId]) => modelId),
    ).toEqual([]);
  });
});

describe('Pi Workers AI model binding', () => {
  /**
   * No model gets a thinking format CloudChef invented — not one Pi lists (`glm-4.7-flash`), not
   * the pinned default, which Pi's catalog does not list at all. The key has to be absent outright
   * rather than present-and-undefined, because Pi's `getCompat` reads `model.compat.thinkingFormat`
   * before falling back to its own detection, and the shape of every request depends on which
   * branch that lands in.
   */
  it.each(['@cf/zai-org/glm-4.7-flash', '@cf/qwen/qwen3-30b-a3b-fp8', '@cf/zai-org/glm-5.3-flash'] as const)(
    'sends no thinking format of its own for %s',
    (modelId) => {
      const { binding } = recordingBinding(modelId);

      expect(getPiModel(binding, modelId).model.compat).not.toHaveProperty('thinkingFormat');
      expect(getPiModel(binding, modelId).model.compat).toMatchObject({ sendSessionAffinityHeaders: true });
    },
  );

  it.each(['@cf/zai-org/glm-5.3-flash', '@cf/openai/gpt-oss-120b'] as const)(
    'routes %s directly through the user-owned AI binding',
    async (modelId) => {
      const { binding, run } = recordingBinding(modelId);
      const selectedModel: WorkersAiModel = {
        ...DEFAULT_WORKERS_AI_MODEL,
        id: modelId,
        label: modelId,
        requiresPaid: modelId === DEFAULT_WORKERS_AI_MODEL.id,
      };
      const handle = getPiModel(binding, modelId, { model: selectedModel, sessionAffinity: 'opaque-session' });
      const messages: Message[] = [{ role: 'user', content: 'Hi', timestamp: 1 }];

      const result = await handle
        .stream(
          handle.model,
          {
            messages,
            tools: [
              {
                name: 'write',
                description: 'Write a project file.',
                parameters: Type.Object({ path: Type.String(), content: Type.String() }),
              },
            ],
          },
          { toolChoice: 'required' } as ModelStreamOptions & { toolChoice: 'required' },
        )
        .result();

      expect(result.content).toContainEqual({ type: 'text', text: 'Hello' });
      expect(run).toHaveBeenCalledWith(
        modelId,
        expect.objectContaining({
          messages: expect.any(Array),
          stream: true,
          tool_choice: 'required',
          tools: expect.any(Array),
        }),
        expect.objectContaining({
          returnRawResponse: true,
          signal: expect.any(AbortSignal),
          extraHeaders: { 'x-session-affinity': 'opaque-session' },
        }),
      );
      if (selectedModel.requiresPaid) {
        expect(run.mock.calls[0]?.[2]).toEqual(
          expect.objectContaining({ gateway: { id: 'default', collectLog: false, skipCache: true } }),
        );
      } else {
        expect(run.mock.calls[0]?.[2]).not.toHaveProperty('gateway');
      }
      expect(handle.model).toMatchObject({
        id: modelId,
        contextWindow: selectedModel.contextTokens,
        maxTokens: selectedModel.contextTokens,
        reasoning: selectedModel.reasoning,
        input: selectedModel.vision ? ['text', 'image'] : ['text'],
      });
    },
  );

  it('asks for every output token the window has left, not a fixed cap', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_048_576 };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle.stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }).result();

    const requested = run.mock.calls[0]?.[1].max_completion_tokens ?? 0;
    // Everything the window physically has left once the estimator's safety margin is removed —
    // far beyond any static ceiling, and always inside the window itself.
    expect(requested).toBeGreaterThan(900_000);
    expect(requested).toBeLessThan(model.contextTokens);
  });

  it('leaves the request room inside the window when the context is already large', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 128_000 };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, {
        systemPrompt: 'You build software.',
        messages: [{ role: 'user', content: 'x'.repeat(160_000), timestamp: 1 }],
      })
      .result();

    const requested = run.mock.calls[0]?.[1].max_completion_tokens ?? 0;
    // The provider rejects input + output beyond the window, so ~40k input tokens has to leave the
    // requested output strictly below the remainder.
    expect(requested).toBeGreaterThan(0);
    expect(requested + 40_000).toBeLessThan(model.contextTokens);
  });

  it('still asks for a real output budget when the window is already full', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 128_000 };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'x'.repeat(1_000_000), timestamp: 1 }] })
      .result();

    // Omitting the field would hand the request Workers AI's own 256-token default and truncate it
    // silently; asking for the floor makes an impossible request fail loudly instead.
    const inputs = run.mock.calls[0]?.[1];
    expect(inputs).toHaveProperty('max_completion_tokens');
    expect(inputs?.max_completion_tokens).toBe(4_096);
  });

  it('lifts a caller budget below the floor rather than shipping a truncating one', async () => {
    const { binding, run } = recordingBinding(DEFAULT_WORKERS_AI_MODEL.id);
    const handle = getPiModel(binding, DEFAULT_WORKERS_AI_MODEL.id, { model: DEFAULT_WORKERS_AI_MODEL });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { maxTokens: 512 })
      .result();

    expect(run.mock.calls[0]?.[1].max_completion_tokens).toBe(4_096);
  });

  it('keeps a caller-declared output budget for non-builder requests', async () => {
    const { binding, run } = recordingBinding(DEFAULT_WORKERS_AI_MODEL.id);
    const handle = getPiModel(binding, DEFAULT_WORKERS_AI_MODEL.id, { model: DEFAULT_WORKERS_AI_MODEL });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Summarize', timestamp: 1 }] }, { maxTokens: 16_000 })
      .result();

    expect(run.mock.calls[0]?.[1].max_completion_tokens).toBe(16_000);
  });

  it('replays the request at the completion cap the provider names in its rejection', async () => {
    // The catalog window Cloudflare reports for glm-5.3-flash, which the provider does not honour.
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_310_720 };
    const { binding, run } = cappingBinding(model.id, OUTPUT_CAP_REJECTION, 1);
    const handle = getPiModel(binding, model.id, { model });

    const result = await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] })
      .result();

    expect(result.content).toContainEqual({ type: 'text', text: 'Hello' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1].max_completion_tokens ?? 0).toBeGreaterThan(1_048_576);
    expect(run.mock.calls[1]?.[1].max_completion_tokens).toBe(1_048_576);
  });

  it('recovers from the production output-cap then total-context rejection and remembers the window', async () => {
    const model = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_310_720 };
    const run = vi.fn(async (_model: string, _inputs: BindingInputs, _options: BindingOptions) =>
      completionResponse(model.id),
    );
    run.mockResolvedValueOnce(new Response(OUTPUT_CAP_REJECTION, { status: 400 }));
    run.mockResolvedValueOnce(new Response(CONTEXT_LIMIT_REJECTION, { status: 400 }));
    const handle = getPiModel(bindingFor(run), model.id, { model });
    const context = { messages: [{ role: 'user' as const, content: 'Hi', timestamp: 1 }] };

    const result = await handle.stream(handle.model, context).result();

    expect(result.content).toContainEqual({ type: 'text', text: 'Hello' });
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2]?.[1].max_completion_tokens).toBe(1_048_576 - 16 - 104_858);
    expect(handle.model.contextWindow).toBe(1_048_576);
    await handle.stream(handle.model, context).result();
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[3]?.[1].max_completion_tokens).toBeLessThan(1_048_576 - 104_858);
  });

  it.each([
    "Requested token count exceeds the model's maximum context length of 1048576 tokens.",
    "Requested token count exceeds the model's maximum context length of 1048576 tokens. 1040000 tokens from the input messages",
  ])('does not retry a context rejection with missing counts or no usable output budget: %s', async (body) => {
    const { binding, run } = cappingBinding(DEFAULT_WORKERS_AI_MODEL.id, body, 1);
    const handle = getPiModel(binding, DEFAULT_WORKERS_AI_MODEL.id, { model: DEFAULT_WORKERS_AI_MODEL });
    await handle.stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }).result();
    expect(run).toHaveBeenCalledOnce();
  });

  it('leaves a rejection that names no completion cap alone', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_310_720 };
    const { binding, run } = cappingBinding(model.id, '{"error":"messages: field required"}', 1);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] })
      .result()
      .catch(() => undefined);

    expect(run).toHaveBeenCalledOnce();
  });

  it('does not replay a request the provider rejects a second time', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, contextTokens: 1_310_720 };
    const { binding, run } = cappingBinding(model.id, OUTPUT_CAP_REJECTION, 2);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] })
      .result()
      .catch(() => undefined);

    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * Pi's api-level `stream` reads the thinking directive from `reasoningEffort`, while every caller
   * in this repository writes `reasoning` — the spelling `streamSimple` accepts. Nothing fails
   * loudly when the two are not bridged: the request simply goes out with thinking disabled, which
   * is the configuration that makes GLM reason until `length` and return empty content. This asserts
   * the body the binding actually receives, since that is the only place the difference is visible.
   *
   * It goes out as a plain `reasoning_effort` and nothing else. With no thinking dialect named, Pi
   * resolves the Cloudflare base URL to its `"openai"` default, which is the documented shape for
   * the three models measured answering it with a 200 and bounded reasoning — gpt-oss-120b,
   * kimi-k2.7-code and nemotron-3-120b. The vendor-native `thinking` block that used to ride along
   * is gone because Cloudflare ignored it.
   */
  it('sends the thinking directive the builder asked for rather than a disabled one', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, reasoning: true };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { reasoning: 'high' })
      .result();

    expect(run.mock.calls[0]?.[1]).toMatchObject({ reasoning_effort: 'high' });
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty('thinking');
  });

  /**
   * The builder asks every reasoning model for `high`, and qwen3.8-27b — user-selectable today, and
   * the model the ranked heuristic would have promoted on a GLM retirement — refuses that word. Pi
   * has no `thinkingLevelMap` for it, so nothing upstream translates the request; without this
   * replay the model 400s on every turn it is ever chosen for.
   */
  it('replays the request at the strongest reasoning effort the provider offers', async () => {
    const { binding, run } = cappingBinding(EFFORT_MODEL.id, REASONING_EFFORT_REJECTION, 1);
    const handle = getPiModel(binding, EFFORT_MODEL.id, { model: EFFORT_MODEL });

    const result = await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { reasoning: 'high' })
      .result();

    expect(result.content).toContainEqual({ type: 'text', text: 'Hello' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1].reasoning_effort).toBe('high');
    // `xhigh` outranks `medium` and `low` in the same sentence, and word boundaries keep the
    // rejected `high` from being read back out of `xhigh`.
    expect(run.mock.calls[1]?.[1].reasoning_effort).toBe('xhigh');
  });

  it('leaves a rejection whose wording it cannot read alone', async () => {
    // The provider still refused the effort, but names no supported set — so there is nothing to
    // choose from, and inventing a value would only spend a second request on the same 400.
    const { binding, run } = cappingBinding(EFFORT_MODEL.id, 'Unexpected reasoning effort high.', 1);
    const handle = getPiModel(binding, EFFORT_MODEL.id, { model: EFFORT_MODEL });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { reasoning: 'high' })
      .result()
      .catch(() => undefined);

    expect(run).toHaveBeenCalledOnce();
  });

  it('does not replay a reasoning effort the provider rejects a second time', async () => {
    const { binding, run } = cappingBinding(EFFORT_MODEL.id, REASONING_EFFORT_REJECTION, 2);
    const handle = getPiModel(binding, EFFORT_MODEL.id, { model: EFFORT_MODEL });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { reasoning: 'high' })
      .result()
      .catch(() => undefined);

    expect(run).toHaveBeenCalledTimes(2);
  });
});

/** Verbatim from a production @cf/qwen/qwen3.8-27b rejection of the effort the builder sends. */
const REASONING_EFFORT_REJECTION =
  'Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.';

/** The model that produced the rejection above: reasoning, and a family Pi does not characterise. */
const EFFORT_MODEL: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/qwen/qwen3.8-27b',
  label: 'Qwen3.8 27B',
  contextTokens: 262_144,
  reasoning: true,
  vision: true,
};

/** Verbatim from a production glm-5.3-flash rejection. */
const OUTPUT_CAP_REJECTION =
  'max_completion_tokens is too large: 1200000.This model supports at most 1048576 completion tokens.';

const CONTEXT_LIMIT_REJECTION =
  "Requested token count exceeds the model's maximum context length of 1048576 tokens. You requested a total of 1048592 tokens: 16 tokens from the input messages and 1048576 tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.";

function recordingBinding(modelId: string) {
  const run = vi.fn(async (_model: string, _inputs: BindingInputs, _options: BindingOptions) =>
    completionResponse(modelId),
  );
  return { binding: bindingFor(run), run };
}

/** Answers the first `rejections` requests with the provider's own output-cap 400. */
function cappingBinding(modelId: string, rejectionBody: string, rejections: number) {
  let remaining = rejections;
  const run = vi.fn(async (_model: string, _inputs: BindingInputs, _options: BindingOptions) => {
    if (remaining > 0) {
      remaining -= 1;
      return new Response(rejectionBody, { status: 400 });
    }
    return completionResponse(modelId);
  });
  return { binding: bindingFor(run), run };
}

function bindingFor(run: (model: string, inputs: BindingInputs, options: BindingOptions) => Promise<Response>) {
  // SAFETY: `Ai` declares far more than the raw-run entry point the adapter reaches; this stub
  // implements exactly the `run` overload it calls, which is all the code under test can observe.
  return { binding: { run } as unknown as Ai };
}

function completionResponse(modelId: string): Response {
  return new Response(
    [
      `data: ${JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        id: 'completion-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
