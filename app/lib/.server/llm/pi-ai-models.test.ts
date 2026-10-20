import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';
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
