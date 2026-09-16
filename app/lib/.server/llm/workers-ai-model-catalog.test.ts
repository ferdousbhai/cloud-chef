import { describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL, DEFAULT_WORKERS_AI_MODEL, type WorkersAiModel } from '~/lib/workers-ai-model';
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

/** A reasoning model Ghostbuild does know how to drive, so failover ranking is what is under test. */
const eligibleModel: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/qwen/qwen3-coder-480b',
  label: 'Qwen3 Coder 480B',
  contextTokens: 131_072,
  vision: false,
};

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
        model('@cf/openai/gpt-oss-120b'),
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
    expect(models.map(({ id }) => id)).toEqual(['@cf/zai-org/glm-5.3-flash', '@cf/openai/gpt-oss-120b']);
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
        model('@cf/openai/gpt-oss-120b', { createdAt: '2026-08-26 00:00:00.000' }),
        model('@cf/example/undated'),
        model('@cf/example/bad-date', { createdAt: 'sometime last week' }),
      ]),
    };

    const models = await readWorkersAiBuilderModelCatalog(binding);

    expect(models[0]?.createdAt).toBe(new Date('2026-08-26 00:00:00.000').toISOString());
    expect(models[1]).not.toHaveProperty('createdAt');
    expect(models[2]).not.toHaveProperty('createdAt');
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
      models: [discoveredDefault, otherModel],
    });
  });

  it('fails over to the best eligible model when Cloudflare retires the pin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const small = { ...eligibleModel, id: '@cf/qwen/small' as const, vision: true, contextTokens: 131_072 };
    const large = { ...eligibleModel, id: '@cf/qwen/large' as const, vision: true, contextTokens: 262_144 };

    expect(workersAiModelCatalogPayload([eligibleModel, small, large])).toEqual({
      // Vision outranks the window, and the window outranks catalog order.
      defaultModelId: large.id,
      models: [large, eligibleModel, small],
    });
    expect(warn).toHaveBeenCalledWith({
      event: 'workers_ai_default_model_retired',
      pinned: CLOUDFLARE_WORKERS_AI_MODEL,
      replacement: large.id,
      rule: 'ranked_preference',
    });
    warn.mockRestore();
  });

  it('prefers the newer of two equal candidates, and ranks an undated one last', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const undated = { ...eligibleModel, id: '@cf/qwen/undated' as const };
    const older = { ...eligibleModel, id: '@cf/qwen/older' as const, createdAt: '2026-01-05T00:00:00.000Z' };
    const newer = { ...eligibleModel, id: '@cf/qwen/newer' as const, createdAt: '2026-08-26T00:00:00.000Z' };

    expect(resolveBuilderDefaultModel([undated, older, newer])).toBe(newer);
    expect(resolveBuilderDefaultModel([undated, older])).toBe(older);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('never fails over to a reasoning model whose thinking Ghostbuild cannot direct', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Bigger, newer, and reasoning — but no known thinking format, so it would reason unboundedly
    // and return empty content instead of building anything.
    const undirectable = {
      ...eligibleModel,
      id: '@cf/mistralai/undirectable' as const,
      contextTokens: 1_048_576,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const plain = { ...eligibleModel, id: '@cf/openai/gpt-oss-120b' as const, reasoning: false };

    expect(resolveBuilderDefaultModel([undirectable, plain])).toBe(plain);
    expect(warn).toHaveBeenCalledWith({
      event: 'workers_ai_default_model_retired',
      pinned: CLOUDFLARE_WORKERS_AI_MODEL,
      replacement: plain.id,
      rule: 'ranked_preference',
    });
    warn.mockRestore();
  });

  /**
   * The owner's stated second choice, and the reason it sits ahead of the ranking: the heuristic
   * scores on catalog properties, and on today's live catalog its vision-first rule picks
   * `@cf/qwen/qwen3.8-27b` — measured against production, the one model that rejects the
   * `reasoning_effort: high` every builder request carries. DeepSeek v4 answers the builder's exact
   * request shape with a 200 and real reasoning, so a verified family beats a scored guess.
   */
  it('fails over to the newest DeepSeek ahead of what the ranking would score highest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Exactly what the heuristic would promote today: vision, newest, widest window.
    const qwen = {
      ...eligibleModel,
      id: '@cf/qwen/qwen3.8-27b' as const,
      vision: true,
      contextTokens: 262_144,
      createdAt: '2026-08-17T00:00:00.000Z',
    };
    const olderDeepSeek = {
      ...eligibleModel,
      id: '@cf/deepseek-ai/deepseek-v4-flash-0731' as const,
      createdAt: '2026-07-31T00:00:00.000Z',
    };
    const newerDeepSeek = {
      ...eligibleModel,
      id: '@cf/deepseek-ai/deepseek-v4-pro-0813' as const,
      createdAt: '2026-08-13T00:00:00.000Z',
    };

    // Newest by date within the family, not the widest or the most capable on paper.
    expect(resolveBuilderDefaultModel([qwen, olderDeepSeek, newerDeepSeek])).toBe(newerDeepSeek);
    expect(warn).toHaveBeenCalledWith({
      event: 'workers_ai_default_model_retired',
      pinned: CLOUDFLARE_WORKERS_AI_MODEL,
      replacement: newerDeepSeek.id,
      rule: 'newest_preferred_family',
    });
    warn.mockRestore();
  });

  it('falls back to the ranking when the account offers no DeepSeek at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const qwen = { ...eligibleModel, id: '@cf/qwen/qwen3.8-27b' as const, vision: true };

    expect(resolveBuilderDefaultModel([eligibleModel, qwen])).toBe(qwen);
    expect(warn).toHaveBeenCalledWith({
      event: 'workers_ai_default_model_retired',
      pinned: CLOUDFLARE_WORKERS_AI_MODEL,
      replacement: qwen.id,
      rule: 'ranked_preference',
    });
    warn.mockRestore();
  });

  it('keeps the reviewed literal when nothing discovered is eligible to replace the pin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const undirectable = { ...eligibleModel, id: '@cf/mistralai/undirectable' as const };

    expect(resolveBuilderDefaultModel([undirectable])).toBe(DEFAULT_WORKERS_AI_MODEL);
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
    const binding = {
      models: vi.fn(async () => [
        model('@cf/openai/gpt-oss-120b', {
          properties: [...eligibleProperties, { property_id: 'reasoning', value: 'false' }],
        }),
      ]),
    };

    await expect(requireWorkersAiBuilderModel(binding, CLOUDFLARE_WORKERS_AI_MODEL)).resolves.toMatchObject({
      id: '@cf/openai/gpt-oss-120b',
    });
    warn.mockRestore();
  });

  it('validates non-default selections against the current account catalog', async () => {
    const selected = model('@cf/openai/gpt-oss-120b');
    const binding = { models: vi.fn(async () => [selected]) };

    await expect(requireWorkersAiBuilderModel(binding, '@cf/openai/gpt-oss-120b')).resolves.toMatchObject({
      id: '@cf/openai/gpt-oss-120b',
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
