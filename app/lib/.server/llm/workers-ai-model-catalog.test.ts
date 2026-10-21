import { describe, expect, it, vi } from 'vitest';
import {
  builderModelCatalogPayloadSchema,
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  validateBuilderModelCatalogPayload,
} from '~/lib/workers-ai-model';
import {
  builderModelCatalogPayload,
  readWorkersAiBuilderModelCatalog,
  requireBuilderModel,
  requireWorkersAiBuilderModel,
  resolveBuilderDefaultModel,
  WorkersAiModelCatalogUnavailableError,
} from './workers-ai-model-catalog';

const eligibleProperties = [
  { property_id: 'context_window', value: '131072' },
  { property_id: 'function_calling', value: 'true' },
  { property_id: 'require_workers_paid', value: 'false' },
  { property_id: 'reasoning', value: 'true' },
  { property_id: 'vision', value: 'false' },
];

type ModelOverrides = {
  source?: number;
  properties?: AiModelsSearchObject['properties'];
  taskName?: string;
  createdAt?: string;
};

function model(name: string, overrides: ModelOverrides = {}): AiModelsSearchObject {
  const entry = {
    id: name,
    source: overrides.source ?? 1,
    name,
    description: `Description for ${name}`,
    task: { id: 'text-generation', name: overrides.taskName ?? 'Text Generation', description: 'Text generation' },
    tags: [],
    properties: overrides.properties ?? eligibleProperties,
  };
  // Cloudflare dates every catalog entry; the generated binding type simply does not declare it.
  return overrides.createdAt === undefined ? entry : Object.assign(entry, { created_at: overrides.createdAt });
}

describe('Workers AI live model catalog', () => {
  it('returns native builder-compatible models Pi lists, with normalized metadata', async () => {
    const binding = {
      models: vi.fn(async () => [
        model('@cf/zai-org/glm-5.3-flash', {
          properties: [
            ...eligibleProperties,
            { property_id: 'context_window', value: '1048576' },
            { property_id: 'require_workers_paid', value: 'true' },
            { property_id: 'vision', value: 'true' },
          ],
        }),
        model('@cf/deepseek-ai/deepseek-v4-pro-0813'),
        model('@cf/openai/gpt-oss-120b'),
        // Compatible on Cloudflare's word, but Pi does not list it, so its request shape would be a guess.
        model('@cf/deepseek-ai/deepseek-v4.1-flash-1017'),
        model('@hf/example/partner'),
        model('@cf/moonshotai/kimi-k2.6', {
          properties: [{ property_id: 'context_window', value: '262144' }],
        }),
        model('@cf/qwen/qwen3-30b-a3b-fp8', {
          properties: [
            // Below MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS: too small to hold the builder's own
            // system prompt and tool schemas alongside a working transcript.
            { property_id: 'context_window', value: '16384' },
            { property_id: 'function_calling', value: 'true' },
          ],
        }),
        model('@cf/zai-org/glm-5.2', { source: 2 }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding);

    expect(binding.models).toHaveBeenCalledWith({
      task: 'Text Generation',
      hide_experimental: true,
      page: 1,
      per_page: 100,
    });
    expect(models.map(({ id }) => id)).toEqual([
      '@cf/zai-org/glm-5.3-flash',
      '@cf/deepseek-ai/deepseek-v4-pro-0813',
      '@cf/openai/gpt-oss-120b',
    ]);
    expect(models[0]).toMatchObject({
      label: 'GLM 5.3 Flash',
      contextTokens: 1_048_576,
      requiresPaid: true,
      reasoning: true,
      vision: true,
    });
  });

  it('carries the catalog publication date through, and omits an unusable one', async () => {
    const binding = {
      models: vi.fn(async () => [
        model('@cf/deepseek-ai/deepseek-v4-pro-0813', { createdAt: '2026-08-26 00:00:00.000' }),
        model(CLOUDFLARE_WORKERS_AI_MODEL, { createdAt: 'sometime last week' }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding);

    expect(models[0]?.createdAt).toBe(new Date('2026-08-26 00:00:00.000').toISOString());
    expect(models[1]).not.toHaveProperty('createdAt');
  });

  it('takes the pinned default from discovery rather than the reviewed literal, and offers the rest', () => {
    const discoveredDefault = {
      ...DEFAULT_WORKERS_AI_MODEL,
      label: 'GLM 5.3 Flash Turbo',
      contextTokens: 524_288,
      vision: false,
      createdAt: '2026-08-26T00:00:00.000Z',
    };
    const otherModel = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/openai/gpt-oss-120b' as const, label: 'Other' };

    expect(builderModelCatalogPayload([otherModel, discoveredDefault])).toEqual({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      // The default stays first so the picker's top row does not move.
      models: [discoveredDefault, otherModel],
    });
  });

  it('falls back to the first offered model once the pin is retired, and to the literal only with none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pro = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' as const };
    const other = { ...pro, id: '@cf/openai/gpt-oss-120b' as const };

    expect(resolveBuilderDefaultModel([pro, other])).toBe(pro);
    expect(resolveBuilderDefaultModel([])).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(warn).toHaveBeenLastCalledWith({
      event: 'workers_ai_default_model_retired',
      pinned: CLOUDFLARE_WORKERS_AI_MODEL,
      replacement: DEFAULT_WORKERS_AI_MODEL.id,
      rule: 'reviewed_literal',
    });
    warn.mockRestore();
  });

  it('fails the builder over to a replacement when the pin is absent from a successful read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = { models: vi.fn(async () => [model('@cf/deepseek-ai/deepseek-v4-pro-0813')]) };

    await expect(requireWorkersAiBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL)).resolves.toMatchObject({
      id: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    });
    warn.mockRestore();
  });

  it('validates non-default selections against the current account catalog', async () => {
    const binding = { models: vi.fn(async () => [model('@cf/deepseek-ai/deepseek-v4-pro-0813')]) };

    await expect(requireWorkersAiBuilderModel(binding, '@cf/deepseek-ai/deepseek-v4-pro-0813')).resolves.toMatchObject({
      id: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    });
    await expect(requireWorkersAiBuilderModel(binding, '@cf/openai/gpt-oss-120b')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('keeps the pinned default available when catalog discovery is down', async () => {
    const binding = { models: vi.fn(async () => Promise.reject(new Error('down'))) };

    await expect(requireWorkersAiBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL)).resolves.toBe(
      DEFAULT_WORKERS_AI_MODEL,
    );
    await expect(readWorkersAiBuilderModelCatalog(binding)).rejects.toBeInstanceOf(
      WorkersAiModelCatalogUnavailableError,
    );
  });
});

describe('the builder catalog an account is offered', () => {
  const pro = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' as const, label: 'Pro' };

  it("adds Pi's Claude models only while the account's gateway holds an Anthropic key", () => {
    const without = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], {
      defaultModelId: null,
      claude: false,
    });
    const linked = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], { defaultModelId: null, claude: true });

    expect(without.models.map(({ id }) => id)).toEqual([CLOUDFLARE_WORKERS_AI_MODEL, pro.id]);
    const claudeIds = linked.models.map(({ id }) => id).filter((id) => id.startsWith('claude-'));
    expect(claudeIds).toEqual(expect.arrayContaining(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']));
    expect(linked.models.find(({ id }) => id === 'claude-opus-5-5')).toMatchObject({
      label: 'Claude Opus 5.5',
      contextTokens: 1_000_000,
      reasoning: true,
      vision: true,
    });
    expect(linked.models.every(({ contextTokens }) => contextTokens >= 32_768)).toBe(true);
    // Every offered model validates as a catalog the browser accepts.
    const parsed = builderModelCatalogPayloadSchema.parse(linked);
    expect(validateBuilderModelCatalogPayload(parsed)).toEqual(linked);
  });

  it("defaults to the model the account's admin chose while it is offered, and to the pin otherwise", () => {
    const chosen = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], {
      defaultModelId: pro.id,
      claude: false,
    });
    expect(chosen.defaultModelId).toBe(pro.id);
    expect(chosen.models[0]?.id).toBe(pro.id);

    const claudeChosen = { defaultModelId: 'claude-opus-5-5', claude: true };
    expect(builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], claudeChosen).defaultModelId).toBe('claude-opus-5-5');
    // The key was unlinked since: the chosen Claude model is no longer offered, so the pin is the default.
    expect(builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], { ...claudeChosen, claude: false })).toMatchObject({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
    });
    expect(
      builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], { defaultModelId: '@cf/example/gone', claude: false })
        .defaultModelId,
    ).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it('runs a Claude turn only on a Claude model Pi lists, and only while the key is linked', async () => {
    const binding = { models: vi.fn(async () => [model(CLOUDFLARE_WORKERS_AI_MODEL)]) };
    const linked = vi.fn(async () => true);

    await expect(requireBuilderModel(binding, 'claude-opus-5-5', linked)).resolves.toMatchObject({
      id: 'claude-opus-5-5',
    });
    await expect(requireBuilderModel(binding, 'claude-opus-5-5', async () => false)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      requireBuilderModel(binding, 'claude-opus-5-5', async () => Promise.reject(new Error('unreachable'))),
    ).rejects.toMatchObject({ status: 409 });
    await expect(requireBuilderModel(binding, 'claude-imaginary-9', linked)).rejects.toMatchObject({ status: 400 });
    // A Workers AI turn never asks about the key.
    linked.mockClear();
    await expect(requireBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL, linked)).resolves.toMatchObject({
      id: CLOUDFLARE_WORKERS_AI_MODEL,
    });
    expect(linked).not.toHaveBeenCalled();
  });
});
