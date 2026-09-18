import { describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import {
  readWorkersAiBuilderModelCatalog,
  requireWorkersAiBuilderModel,
  resolveBuilderDefaultModel,
  WorkersAiModelCatalogUnavailableError,
  workersAiModelCatalogPayload,
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
  it('returns native builder-compatible models with normalized metadata', async () => {
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
        model('@cf/deepseek-ai/deepseek-v4-flash-0731'),
        model('@hf/example/partner'),
        model('@cf/example/no-tools', {
          properties: [{ property_id: 'context_window', value: '131072' }],
        }),
        model('@cf/example/small', {
          properties: [
            // Below MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS: too small to hold the builder's own
            // system prompt and tool schemas alongside a working transcript.
            { property_id: 'context_window', value: '16384' },
            { property_id: 'function_calling', value: 'true' },
          ],
        }),
        model('@cf/example/wrong-source', { source: 2 }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding);

    expect(binding.models).toHaveBeenCalledWith({
      task: 'Text Generation',
      hide_experimental: true,
      page: 1,
      per_page: 100,
    });
    expect(models.map(({ id }) => id)).toEqual(['@cf/zai-org/glm-5.3-flash', '@cf/deepseek-ai/deepseek-v4-flash-0731']);
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
        model('@cf/deepseek-ai/deepseek-v4-flash-0731', { createdAt: '2026-08-26 00:00:00.000' }),
        model(CLOUDFLARE_WORKERS_AI_MODEL, { createdAt: 'sometime last week' }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding);

    expect(models[0]?.createdAt).toBe(new Date('2026-08-26 00:00:00.000').toISOString());
    expect(models[1]).not.toHaveProperty('createdAt');
  });

  it('takes the pinned default from discovery rather than the reviewed literal', () => {
    const discoveredDefault = {
      ...DEFAULT_WORKERS_AI_MODEL,
      label: 'GLM 5.3 Flash Turbo',
      contextTokens: 524_288,
      vision: false,
      createdAt: '2026-08-26T00:00:00.000Z',
    };
    const otherModel = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/example/other' as const, label: 'Other' };

    expect(workersAiModelCatalogPayload([otherModel, discoveredDefault])).toEqual({
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      // The default stays first so the picker's top row does not move.
      models: [discoveredDefault],
    });
  });

  it('promotes only the selected Flash alternative, never a newer Pro or unrelated model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const flash = { ...DEFAULT_WORKERS_AI_MODEL, id: '@cf/deepseek-ai/deepseek-v4-flash-0731' as const };
    const pro = { ...flash, id: '@cf/deepseek-ai/deepseek-v4-pro-0813' as const };
    const other = { ...flash, id: '@cf/openai/gpt-oss-120b' as const };
    expect(resolveBuilderDefaultModel([pro, other, flash])).toBe(flash);
    expect(resolveBuilderDefaultModel([pro, other])).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(workersAiModelCatalogPayload([pro, other, flash]).models).toEqual([flash]);
    warn.mockRestore();
  });

  it('rejects otherwise compatible models outside the two selected choices', async () => {
    const binding = {
      models: vi.fn(async () => [model('@cf/deepseek-ai/deepseek-v4-pro-0813'), model('@cf/openai/gpt-oss-120b')]),
    };
    expect(await readWorkersAiBuilderModelCatalog(binding)).toEqual([]);
    await expect(requireWorkersAiBuilderModel(binding, '@cf/deepseek-ai/deepseek-v4-pro-0813')).rejects.toMatchObject({
      status: 400,
    });
    await expect(requireWorkersAiBuilderModel(binding, '@cf/openai/gpt-oss-120b')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('still checks capabilities of the selected models', async () => {
    const binding = {
      models: vi.fn(async () => [
        model(CLOUDFLARE_WORKERS_AI_MODEL, { properties: [{ property_id: 'context_window', value: '1310720' }] }),
        model('@cf/deepseek-ai/deepseek-v4-flash-0731', { source: 2 }),
      ]),
    };
    expect(await readWorkersAiBuilderModelCatalog(binding)).toEqual([]);
  });

  it('keeps the reviewed literal when discovery offers nothing to replace the pin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(resolveBuilderDefaultModel([])).toBe(DEFAULT_WORKERS_AI_MODEL);
    expect(warn).toHaveBeenCalledWith({
      event: 'workers_ai_default_model_retired',
      pinned: CLOUDFLARE_WORKERS_AI_MODEL,
      replacement: DEFAULT_WORKERS_AI_MODEL.id,
      rule: 'reviewed_literal',
    });
    warn.mockRestore();
  });

  it('fails the builder over to a replacement when the pin is absent from a successful read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const binding = { models: vi.fn(async () => [model('@cf/deepseek-ai/deepseek-v4-flash-0731')]) };

    await expect(requireWorkersAiBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL)).resolves.toMatchObject({
      id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
    });
    warn.mockRestore();
  });

  it('validates non-default selections against the current account catalog', async () => {
    const selected = model('@cf/deepseek-ai/deepseek-v4-flash-0731');
    const binding = { models: vi.fn(async () => [selected]) };

    await expect(
      requireWorkersAiBuilderModel(binding, '@cf/deepseek-ai/deepseek-v4-flash-0731'),
    ).resolves.toMatchObject({
      id: '@cf/deepseek-ai/deepseek-v4-flash-0731',
    });
    await expect(requireWorkersAiBuilderModel(binding, '@cf/example/missing')).rejects.toMatchObject({ status: 400 });
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
