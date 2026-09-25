import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_PROJECT_TITLE_MODEL,
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  getWorkersAiModel,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  validateWorkersAiModelCatalogPayload,
  workersAiModelCatalogPayloadSchema,
  type WorkersAiModel,
} from './workers-ai-model';

const alternativeModel: WorkersAiModel = {
  ...DEFAULT_WORKERS_AI_MODEL,
  id: '@cf/openai/gpt-oss-120b',
  label: 'GPT OSS 120B',
  contextTokens: 128_000,
  requiresPaid: false,
  vision: false,
};

describe('Workers AI model catalog', () => {
  it('pins the owner-selected GLM 5.3 Flash as the safe startup default', () => {
    expect(CLOUDFLARE_WORKERS_AI_MODEL).toBe('@cf/zai-org/glm-5.3-flash');
    expect(DEFAULT_WORKERS_AI_MODEL.contextTokens).toBeGreaterThanOrEqual(MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS);
    expect(DEFAULT_WORKERS_AI_MODEL.contextTokens).toBe(1_310_720);
    expect(DEFAULT_WORKERS_AI_MODEL).toMatchObject({ label: 'GLM 5.3 Flash', reasoning: true, vision: true });
    expect(getWorkersAiModel(CLOUDFLARE_WORKERS_AI_MODEL, [DEFAULT_WORKERS_AI_MODEL])).toBe(DEFAULT_WORKERS_AI_MODEL);
  });

  it('accepts a catalog entry with or without the publication date', () => {
    const dated = { ...alternativeModel, createdAt: '2026-08-26T00:00:00.000Z' };

    expect(workersAiModelCatalogPayloadSchema.parse({ defaultModelId: dated.id, models: [dated] }).models[0]).toEqual(
      dated,
    );
    expect(
      workersAiModelCatalogPayloadSchema.safeParse({ defaultModelId: alternativeModel.id, models: [alternativeModel] })
        .success,
    ).toBe(true);
  });

  it('pins the auxiliary models to backends that speak the OpenAI completions response shape', () => {
    // A native `{ response, usage }` model (any `@cf/meta/llama-3.2-*-instruct`, for one) parses as
    // empty text through the Pi openai-completions adapter, so titles silently never generate.
    expect(CLOUDFLARE_PROJECT_TITLE_MODEL).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(CLOUDFLARE_PROJECT_TITLE_MODEL).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('accepts Cloudflare-native model slugs without pretending they are catalog membership', () => {
    expect(isWorkersAiModelId('@cf/zai-org/glm-5.3-flash')).toBe(true);
    expect(isWorkersAiModelId('@cf/openai/gpt-oss-120b')).toBe(true);
    expect(isWorkersAiModelId('deepseek/deepseek-v4-pro')).toBe(false);
    expect(isWorkersAiModelId('@cf/example')).toBe(false);
    expect(isWorkersAiModelId(undefined)).toBe(false);
  });

  it('parses a unique catalog whose declared default is present', () => {
    const payload = {
      defaultModelId: CLOUDFLARE_WORKERS_AI_MODEL,
      models: [DEFAULT_WORKERS_AI_MODEL, alternativeModel],
    };

    const parsed = workersAiModelCatalogPayloadSchema.safeParse(payload);
    expect(parsed.success && validateWorkersAiModelCatalogPayload(parsed.data)).toEqual(payload);
    expect(getWorkersAiModel(alternativeModel.id, payload.models)).toEqual(alternativeModel);
    const missingDefault = workersAiModelCatalogPayloadSchema.parse({
      ...payload,
      defaultModelId: '@cf/example/missing',
    });
    expect(validateWorkersAiModelCatalogPayload(missingDefault)).toBeNull();
    const duplicate = workersAiModelCatalogPayloadSchema.parse({
      ...payload,
      models: [alternativeModel, alternativeModel],
    });
    expect(validateWorkersAiModelCatalogPayload(duplicate)).toBeNull();
  });
});
