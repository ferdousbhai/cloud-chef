import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';

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
