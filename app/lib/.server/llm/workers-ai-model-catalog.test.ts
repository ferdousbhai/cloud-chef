import { describe, expect, it, vi } from 'vitest';
import {
  builderModelCatalogPayloadSchema,
  CLOUDFLARE_WORKERS_AI_MODEL,
  compatibleBuilderModelsPayloadSchema,
  DEFAULT_WORKERS_AI_MODEL,
  GATEWAY_PROVIDER_SLUGS,
  gatewayModelProvider,
  NO_ACCOUNT_MODEL_SETTINGS,
  validateBuilderModelCatalogPayload,
  type AccountModelSettings,
  type GatewayKey,
} from '~/lib/workers-ai-model';
import {
  builderModelCatalogPayload,
  builderModelCatalogResponse,
  compatibleBuilderModels,
  NoAllowedBuilderModelError,
  readWorkersAiBuilderModelCatalog,
  requireBuilderModel,
  requireBuilderReasoningLevel,
  requireWorkersAiBuilderModel,
  resolveBuilderDefaultModel,
  WorkersAiModelCatalogUnavailableError,
} from './workers-ai-model-catalog';
import { piWorkersAiModel, withReasoningLevels } from './pi-model-catalog';

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
      // Pi's catalog maps GLM 5.3 Flash's efforts to low, high, and max; there is no medium.
      reasoningLevels: ['low', 'high', 'max'],
    });
  });

  it('carries the catalog publication date through, and omits an unusable one', async () => {
    const binding = {
      models: vi.fn(async () => [
        model('@cf/deepseek-ai/deepseek-v4-pro-0813', { createdAt: '2026-08-26 00:00:00.000' }),
        model(CLOUDFLARE_WORKERS_AI_MODEL, { createdAt: 'sometime last week' }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding, Date.parse('2026-10-26T00:00:00Z'));

    expect(models[0]?.createdAt).toBe(new Date('2026-08-26 00:00:00.000').toISOString());
    expect(models[1]).not.toHaveProperty('createdAt');
  });

  it('leaves out models Cloudflare added more than six months ago, but never its own default', async () => {
    const binding = {
      models: vi.fn(async () => [
        model('@cf/deepseek-ai/deepseek-v4-pro-0813', { createdAt: '2026-08-13 17:15:08.489' }),
        model('@cf/openai/gpt-oss-120b', { createdAt: '2025-08-05 10:27:29.131' }),
        model('@cf/moonshotai/kimi-k2.6', {
          createdAt: '2026-04-20 01:40:35.001',
          properties: [...eligibleProperties, { property_id: 'context_window', value: '262144' }],
        }),
        model(CLOUDFLARE_WORKERS_AI_MODEL, { createdAt: '2025-01-01 00:00:00.000' }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding, Date.parse('2026-10-26T00:00:00Z'));

    expect(models.map(({ id }) => id)).toEqual(['@cf/deepseek-ai/deepseek-v4-pro-0813', CLOUDFLARE_WORKERS_AI_MODEL]);
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
    expect(resolveBuilderDefaultModel([])).toMatchObject({
      ...DEFAULT_WORKERS_AI_MODEL,
      reasoningLevels: expect.any(Array),
    });
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

    const model = await requireWorkersAiBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL);
    expect(model).toMatchObject(DEFAULT_WORKERS_AI_MODEL);
    await expect(readWorkersAiBuilderModelCatalog(binding)).rejects.toBeInstanceOf(
      WorkersAiModelCatalogUnavailableError,
    );
    // With the efforts Pi lists for it, as the live catalog offers them: a chosen effort still runs.
    const piModel = piWorkersAiModel(CLOUDFLARE_WORKERS_AI_MODEL);
    const levels = (piModel && withReasoningLevels(piModel).reasoningLevels) ?? [];
    expect(levels.length).toBeGreaterThan(0);
    expect(model.reasoningLevels).toEqual(levels);
    for (const level of levels) {
      expect(requireBuilderReasoningLevel(model, level)).toBe(level);
    }
  });
});

describe('the builder catalog an account is offered', () => {
  const pro = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' as const, label: 'Pro' };

  it("adds each gateway provider's Pi models exactly while the account's gateway holds a key for it", () => {
    const without = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], NO_ACCOUNT_MODEL_SETTINGS);
    // The aliases are whatever the account stored its keys under; they never change what is offered.
    const keys: GatewayKey[] = [
      { provider: 'anthropic', alias: 'team-key', revision: 'key@1' },
      { provider: 'grok', alias: 'default', revision: 'key@1' },
    ];
    const linked = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      defaultModelId: null,
      gatewayKeys: keys,
    });

    expect(without.models.map(({ id }) => id)).toEqual([CLOUDFLARE_WORKERS_AI_MODEL, pro.id]);
    const ids = linked.models.map(({ id }) => id);
    expect(ids).toEqual(
      expect.arrayContaining(['anthropic/claude-opus-5-5', 'anthropic/claude-haiku-5-5', 'grok/grok-4.3']),
    );
    // Only the providers the account has a key for.
    expect(new Set(ids.map((id) => gatewayModelProvider(id)))).toEqual(new Set([null, 'anthropic', 'grok']));
    expect(linked.models.find(({ id }) => id === 'anthropic/claude-opus-5-5')).toMatchObject({
      label: 'Claude Opus 5.5',
      // The provider tab says whose model it is and how it is reached, so there is no description.
      description: '',
      contextTokens: 1_000_000,
      reasoning: true,
      vision: true,
    });
    expect(linked.models.every(({ contextTokens }) => contextTokens >= 32_768)).toBe(true);
    // Every offered model validates as a catalog the browser accepts.
    const parsed = builderModelCatalogPayloadSchema.parse(linked);
    expect(validateBuilderModelCatalogPayload(parsed)).toEqual(linked);
  });

  it('offers every provider at once in a catalog the browser accepts', () => {
    const everyKey = GATEWAY_PROVIDER_SLUGS.map((provider) => ({ provider, alias: 'default', revision: 'key@1' }));
    const all = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      gatewayKeys: everyKey,
    });

    expect(new Set(all.models.map(({ id }) => gatewayModelProvider(id)))).toEqual(
      new Set([null, ...GATEWAY_PROVIDER_SLUGS]),
    );
    expect(all.models.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['openai/gpt-5', 'openrouter/openai/gpt-5', 'openrouter/anthropic/claude-fable-5']),
    );
    expect(validateBuilderModelCatalogPayload(builderModelCatalogPayloadSchema.parse(all))).toEqual(all);
  });

  it('offers no batch-only variant, model router, audio or image model, search-only model, or classifier', () => {
    const everyKey = GATEWAY_PROVIDER_SLUGS.map((provider) => ({ provider, alias: 'default', revision: 'key@1' }));
    const ids = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      defaultModelId: null,
      gatewayKeys: everyKey,
    }).models.map(({ id }) => id);

    for (const excluded of [
      'openrouter/openai/gpt-5:batch',
      'openrouter/openrouter/auto',
      'openrouter/openrouter/auto-beta',
      'openrouter/openrouter/free',
      'openrouter/openai/gpt-audio',
      'openrouter/google/gemini-3-pro-image',
      'openrouter/relace/relace-search',
      'openrouter/openai/gpt-oss-safeguard-20b',
    ]) {
      expect(ids).not.toContain(excluded);
    }
    expect(ids.filter((id) => id.endsWith(':batch') || id.startsWith('openrouter/openrouter/'))).toEqual([]);
    // The same models stay offered in every form that can build.
    expect(ids).toEqual(expect.arrayContaining(['openrouter/openai/gpt-5', 'openrouter/google/gemma-4-31b-it:free']));
  });

  it("offers each reasoning model the efforts Pi lists for it, never off, and none to a model that doesn't reason", () => {
    const everyKey = GATEWAY_PROVIDER_SLUGS.map((provider) => ({ provider, alias: 'default', revision: 'key@1' }));
    const { models } = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      defaultModelId: null,
      gatewayKeys: everyKey,
    });
    const levelsOf = (id: string) => models.find((model) => model.id === id)?.reasoningLevels;

    expect(levelsOf('anthropic/claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(levelsOf('anthropic/claude-sonnet-4-5')).toEqual(['low', 'medium', 'high']);
    expect(levelsOf('openai/gpt-5')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(levelsOf('openai/gpt-6-luna')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(levelsOf('grok/grok-4.3')).toEqual(['low', 'medium', 'high']);
    for (const model of models) {
      if (!model.reasoning) {
        expect(model.reasoningLevels, model.id).toBeUndefined();
      }
      expect(model.reasoningLevels ?? [], model.id).not.toContain('off');
    }
  });

  it('runs a turn at an effort only when its model offers it', () => {
    const opus = { ...DEFAULT_WORKERS_AI_MODEL, label: 'Opus', reasoningLevels: ['low', 'high', 'max'] as const };
    const model = { ...opus, reasoningLevels: [...opus.reasoningLevels] };
    expect(requireBuilderReasoningLevel(model, undefined)).toBeUndefined();
    expect(requireBuilderReasoningLevel(model, 'max')).toBe('max');
    expect(() => requireBuilderReasoningLevel(model, 'xhigh')).toThrow(expect.objectContaining({ status: 400 }));
    const { reasoningLevels: _none, ...plain } = model;
    expect(() => requireBuilderReasoningLevel(plain, 'low')).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("defaults to the model the account's admin chose while it is offered, and to the pin otherwise", () => {
    const chosen = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      defaultModelId: pro.id,
      gatewayKeys: [],
    });
    expect(chosen.defaultModelId).toBe(pro.id);
    expect(chosen.models[0]?.id).toBe(pro.id);

    const claudeChosen = {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      defaultModelId: 'anthropic/claude-opus-5-5',
      gatewayKeys: [{ provider: 'anthropic' as const, alias: 'default', revision: 'key@1' }],
    };
    expect(builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], claudeChosen).defaultModelId).toBe(
      'anthropic/claude-opus-5-5',
    );
    // The key was removed since: the chosen model is no longer offered, so the pin is the default.
    expect(builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], { ...claudeChosen, gatewayKeys: [] })).toMatchObject({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
    });
    expect(
      builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], {
        ...NO_ACCOUNT_MODEL_SETTINGS,
        defaultModelId: '@cf/example/gone',
      }).defaultModelId,
    ).toBe(CLOUDFLARE_WORKERS_AI_MODEL);
  });

  it("runs a provider's turn only on a model Pi lists, only while its key is there, with that key's alias", async () => {
    const binding = { models: vi.fn(async () => [model(CLOUDFLARE_WORKERS_AI_MODEL)]) };
    const linked = vi.fn(async (): Promise<AccountModelSettings> => ({
      ...NO_ACCOUNT_MODEL_SETTINGS,
      gatewayKeys: [
        { provider: 'openai', alias: 'default', revision: 'key@1' },
        { provider: 'anthropic', alias: 'sg', revision: 'config-sg@2026-10-01' },
      ],
    }));

    await expect(requireBuilderModel(binding, 'anthropic/claude-opus-5-5', linked)).resolves.toEqual({
      model: expect.objectContaining({ id: 'anthropic/claude-opus-5-5' }),
      gatewayKeyAlias: 'sg',
      gatewayKeyRevision: 'config-sg@2026-10-01',
    });
    await expect(requireBuilderModel(binding, 'openai/gpt-5', linked)).resolves.toMatchObject({
      gatewayKeyAlias: 'default',
    });
    // No key for OpenRouter on the gateway.
    await expect(requireBuilderModel(binding, 'openrouter/openai/gpt-5', linked)).rejects.toMatchObject({
      status: 409,
    });
    await expect(requireBuilderModel(binding, 'anthropic/claude-imaginary-9', linked)).rejects.toMatchObject({
      status: 400,
    });
    await expect(requireBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL, linked)).resolves.toEqual({
      model: expect.objectContaining({ id: CLOUDFLARE_WORKERS_AI_MODEL }),
    });
  });

  it('runs no turn, on any model, while what the account allows cannot be learned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = { models: vi.fn(async () => [model(CLOUDFLARE_WORKERS_AI_MODEL)]) };
    // Unlearnable (the control plane unreachable or refusing), or a lookup that threw: a check that
    // could not be made — retryable — and no request sent.
    for (const unknown of [async () => null, async () => Promise.reject(new Error('unreachable'))]) {
      for (const modelId of [CLOUDFLARE_WORKERS_AI_MODEL, 'anthropic/claude-opus-5-5'] as const) {
        const unchecked = requireBuilderModel(binding, modelId, unknown);
        await expect(unchecked).rejects.toMatchObject({ status: 503 });
        await expect(unchecked.catch((response: Response) => response.text())).resolves.toContain('could not check');
      }
    }
    expect(binding.models).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses a turn on a model the account's admin doesn't allow, naming it, before asking Cloudflare", async () => {
    const binding = {
      models: vi.fn(async () => [model(CLOUDFLARE_WORKERS_AI_MODEL), model('@cf/deepseek-ai/deepseek-v4-pro-0813')]),
    };
    const settings = async (): Promise<AccountModelSettings> => ({
      ...NO_ACCOUNT_MODEL_SETTINGS,
      gatewayKeys: [{ provider: 'anthropic', alias: 'default', revision: 'key@1' }],
      allowedModelIds: [CLOUDFLARE_WORKERS_AI_MODEL, 'anthropic/claude-opus-5-5'],
    });

    await expect(requireBuilderModel(binding, 'anthropic/claude-opus-5-5', settings)).resolves.toMatchObject({
      model: { id: 'anthropic/claude-opus-5-5' },
    });
    await expect(requireBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL, settings)).resolves.toMatchObject({
      model: { id: CLOUDFLARE_WORKERS_AI_MODEL },
    });
    binding.models.mockClear();
    // Compatible, and its key is there, but left out by the admin: refused, not swapped for another.
    const fable = requireBuilderModel(binding, 'anthropic/claude-fable-5', settings);
    await expect(fable).rejects.toMatchObject({ status: 403 });
    await expect(fable.catch((response: Response) => response.text())).resolves.toMatch(
      /^Claude Fable 5 isn't allowed in this account\. Choose another model in the model picker/,
    );
    const pro = requireBuilderModel(binding, '@cf/deepseek-ai/deepseek-v4-pro-0813', settings);
    await expect(pro).rejects.toMatchObject({ status: 403 });
    await expect(pro.catch((response: Response) => response.text())).resolves.toContain('DeepSeek V4 Pro 0813');
    expect(binding.models).not.toHaveBeenCalled();
    // An empty list allows nothing, the pinned model included.
    await expect(
      requireBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL, async () => ({
        ...NO_ACCOUNT_MODEL_SETTINGS,
        allowedModelIds: [],
      })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('replaces a retired pin only with a model the admin allows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = {
      models: vi.fn(async () => [model('@cf/openai/gpt-oss-120b'), model('@cf/deepseek-ai/deepseek-v4-pro-0813')]),
    };
    const allowing = (allowedModelIds: string[]) => async () => ({ ...NO_ACCOUNT_MODEL_SETTINGS, allowedModelIds });

    await expect(
      requireBuilderModel(
        binding,
        CLOUDFLARE_WORKERS_AI_MODEL,
        allowing([CLOUDFLARE_WORKERS_AI_MODEL, '@cf/deepseek-ai/deepseek-v4-pro-0813']),
      ),
    ).resolves.toMatchObject({ model: { id: '@cf/deepseek-ai/deepseek-v4-pro-0813' } });
    await expect(
      requireBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL, allowing([CLOUDFLARE_WORKERS_AI_MODEL])),
    ).rejects.toMatchObject({ status: 409 });
    warn.mockRestore();
  });
});

describe("the models an account's admin allows", () => {
  const pro = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' as const, label: 'Pro' };
  const oss = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/openai/gpt-oss-120b' as const, label: 'GPT OSS' };
  const anthropicKey: GatewayKey[] = [{ provider: 'anthropic', alias: 'default', revision: 'key@1' }];

  it('offers every compatible model while the admin has chosen none', () => {
    const settings = { ...NO_ACCOUNT_MODEL_SETTINGS, gatewayKeys: anthropicKey };
    const { models } = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro, oss], settings);
    expect(models.map(({ id }) => id)).toEqual(
      compatibleBuilderModels([DEFAULT_WORKERS_AI_MODEL, pro, oss], anthropicKey).map(({ id }) => id),
    );
    expect(models.map(({ id }) => id)).toContain('anthropic/claude-fable-5');
  });

  it('lists only the allowed models, so one added later is not offered until allowed', () => {
    const settings = {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      gatewayKeys: anthropicKey,
      allowedModelIds: [CLOUDFLARE_WORKERS_AI_MODEL, 'anthropic/claude-opus-5-5', '@cf/example/retired'],
    };
    const before = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], settings);
    expect(before).toEqual({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, expect.objectContaining({ id: 'anthropic/claude-opus-5-5' })],
    });
    // Cloudflare publishes another model: still not offered.
    const after = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro, oss], settings);
    expect(after.models.map(({ id }) => id)).toEqual([CLOUDFLARE_WORKERS_AI_MODEL, 'anthropic/claude-opus-5-5']);
    expect(validateBuilderModelCatalogPayload(builderModelCatalogPayloadSchema.parse(after))).toEqual(after);
  });

  it("keeps the admin's default first, and otherwise falls to an allowed model", () => {
    const chosen = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      gatewayKeys: anthropicKey,
      defaultModelId: 'anthropic/claude-opus-5-5',
      allowedModelIds: ['anthropic/claude-opus-5-5', pro.id],
    });
    expect(chosen.defaultModelId).toBe('anthropic/claude-opus-5-5');
    expect(chosen.models.map(({ id }) => id)).toEqual(['anthropic/claude-opus-5-5', pro.id]);

    // The default's key was removed since, and the pin isn't allowed: the first allowed model leads.
    const keyRemoved = builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL, pro], {
      ...NO_ACCOUNT_MODEL_SETTINGS,
      defaultModelId: 'anthropic/claude-opus-5-5',
      allowedModelIds: ['anthropic/claude-opus-5-5', pro.id],
    });
    expect(keyRemoved).toEqual({ defaultModelId: pro.id, models: [pro] });
  });

  it('offers nothing, saying why, when no allowed model can run in the account', () => {
    const settings = { ...NO_ACCOUNT_MODEL_SETTINGS, allowedModelIds: ['anthropic/claude-opus-5-5'] };
    expect(() => builderModelCatalogPayload([DEFAULT_WORKERS_AI_MODEL], settings)).toThrow(NoAllowedBuilderModelError);
  });

  it("serves the picker's catalog and Settings' full list, failing closed while the settings are unknown", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = { models: vi.fn(async () => [model(CLOUDFLARE_WORKERS_AI_MODEL), model(pro.id)]) };
    const settings = async (): Promise<AccountModelSettings> => ({
      ...NO_ACCOUNT_MODEL_SETTINGS,
      allowedModelIds: [CLOUDFLARE_WORKERS_AI_MODEL],
    });

    const picker = await builderModelCatalogResponse(binding, settings);
    expect(picker.status).toBe(200);
    expect(builderModelCatalogPayloadSchema.parse(await picker.json()).models.map(({ id }) => id)).toEqual([
      CLOUDFLARE_WORKERS_AI_MODEL,
    ]);
    const everything = await builderModelCatalogResponse(binding, settings, { compatible: true });
    expect(compatibleBuilderModelsPayloadSchema.parse(await everything.json()).models.map(({ id }) => id)).toEqual([
      CLOUDFLARE_WORKERS_AI_MODEL,
      pro.id,
    ]);

    for (const compatible of [false, true]) {
      const unknown = await builderModelCatalogResponse(binding, async () => null, { compatible });
      expect(unknown.status).toBe(503);
      expect(await unknown.json()).toEqual({ error: expect.stringContaining('could not check') });
    }
    const none = await builderModelCatalogResponse(binding, async () => ({
      ...NO_ACCOUNT_MODEL_SETTINGS,
      allowedModelIds: [],
    }));
    expect(none.status).toBe(409);
    const down = await builderModelCatalogResponse({ models: async () => Promise.reject(new Error('down')) }, settings);
    expect(down.status).toBe(503);
    warn.mockRestore();
  });
});
