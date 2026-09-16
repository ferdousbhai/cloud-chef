import { describe, expect, it, vi } from 'vitest';
import { Type, type Message } from '@earendil-works/pi-ai';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import {
  CLOUDFLARE_CONTEXT_SUMMARY_MODEL,
  CLOUDFLARE_PROJECT_TITLE_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  workersAiThinkingFormat,
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
 * Reasoning models whose serialization format nobody has characterised: Pi's catalog supplies no
 * `compat.thinkingFormat` for them and `workersAiThinkingFormat` matches none of their prefixes.
 * Ghostbuild therefore cannot direct their thinking, and must never auto-select one —
 * `isEligibleBuilderDefault` already refuses exactly this set, so the list is about awareness
 * rather than safety. A user hand-picking one from the catalog is still making a visible, undoable
 * choice, which is why membership stays broader than eligibility.
 *
 * Every id here is a deliberate acknowledgement, not an oversight. The point of pinning them is the
 * inverse case: when a Pi upgrade or a catalog change introduces a reasoning family nobody has
 * characterised, the assertion below turns `validate` red and forces a decision, instead of
 * silently widening the set of models Ghostbuild does not understand. Cloudflare's own catalog
 * cannot close this gap — it publishes a `reasoning` flag but nothing describing how a model
 * serializes reasoning — so the knowledge has to be stated somewhere, and this is where its absence
 * is stated.
 */
const UNCHARACTERISED_REASONING_MODELS: readonly string[] = [
  '@cf/google/gemma-4-26b-a4b-it',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/nvidia/nemotron-3-120b-a12b',
  '@cf/openai/gpt-oss-120b',
  '@cf/openai/gpt-oss-20b',
];

describe('reasoning models Ghostbuild knows how to direct', () => {
  const reasoningEntries = Object.entries(CLOUDFLARE_WORKERS_AI_MODELS).filter(([, model]) => model.reasoning);

  it('characterises every reasoning model Pi ships, or names it as an acknowledged unknown', () => {
    expect(reasoningEntries.length).toBeGreaterThan(0);

    const uncharacterised = reasoningEntries
      .filter(([modelId, model]) => model.compat?.thinkingFormat === undefined && !workersAiThinkingFormat(modelId))
      .map(([modelId]) => modelId);

    expect(uncharacterised).toEqual([...UNCHARACTERISED_REASONING_MODELS]);
  });

  /**
   * Keeps the acknowledgement list from outliving the gap it documents: an id that has since gained
   * a format, or left the catalog, must be removed rather than left standing as a stale claim that
   * Ghostbuild still cannot drive it.
   */
  it('keeps no stale acknowledgements', () => {
    const catalogIds = new Set(reasoningEntries.map(([modelId]) => modelId));

    expect(UNCHARACTERISED_REASONING_MODELS.filter((modelId) => !catalogIds.has(modelId))).toEqual([]);
  });
});

describe('Pi Workers AI model binding', () => {
  /**
   * The merge that decides a model's thinking format, pinned from both sides. Pi lists these three
   * and characterises none of them, so the format can only come from Ghostbuild's family map — and
   * it has to survive the spread of Pi's own `compat`, which sits in front of it. A future Pi entry
   * that writes `thinkingFormat: undefined` explicitly would erase the value under a plain
   * spread-ordering scheme; this asserts it does not.
   */
  it.each(['@cf/zai-org/glm-4.7-flash', '@cf/zai-org/glm-5.2', '@cf/qwen/qwen3-30b-a3b-fp8'] as const)(
    'keeps its own thinking format for %s, which Pi lists but does not characterise',
    (modelId) => {
      const { binding } = recordingBinding(modelId);

      expect(CLOUDFLARE_WORKERS_AI_MODELS[modelId].compat?.thinkingFormat).toBeUndefined();
      expect(getPiModel(binding, modelId).model.compat).toMatchObject({
        thinkingFormat: workersAiThinkingFormat(modelId),
        sendSessionAffinityHeaders: true,
      });
    },
  );

  /**
   * The other half of the merge: an acknowledged unknown must stay unknown. Pi sets no format for
   * gpt-oss and neither does the family map, so `thinkingFormat` has to be absent outright rather
   * than present-and-undefined — Pi reads the key, not its value.
   */
  it('leaves a model Ghostbuild has not characterised without an invented format', () => {
    const modelId = '@cf/openai/gpt-oss-120b';
    const { binding } = recordingBinding(modelId);

    expect(UNCHARACTERISED_REASONING_MODELS).toContain(modelId);
    expect(getPiModel(binding, modelId).model.compat).not.toHaveProperty('thinkingFormat');
  });

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
   */
  it('sends the thinking directive the builder asked for rather than a disabled one', async () => {
    const model: WorkersAiModel = { ...DEFAULT_WORKERS_AI_MODEL, reasoning: true };
    const { binding, run } = recordingBinding(model.id);
    const handle = getPiModel(binding, model.id, { model });

    await handle
      .stream(handle.model, { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] }, { reasoning: 'high' })
      .result();

    // The exact shape probed against production Workers AI for glm-5.3-flash.
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high',
    });
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
