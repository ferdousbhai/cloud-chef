import type { Api, Model } from '@earendil-works/pi-ai';
import { CLOUDFLARE_AI_GATEWAY_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import {
  isBuilderModelId,
  isClaudeModelId,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  type BuilderModel,
  type ClaudeModelId,
} from '~/lib/workers-ai-model';

/**
 * Pi's catalogs are the source of truth for which models CloudChef offers and how each one is
 * spoken to: a model Pi does not list is not offered, because CloudChef would otherwise have to
 * guess its request shape. Workers AI models come from Pi's `cloudflare-workers-ai` catalog (and
 * must also be in the account's live catalog); Claude models from Pi's `cloudflare-ai-gateway`
 * catalog, served through the account's AI Gateway with its own Anthropic key.
 */

type PiCatalogModel = Model<Api>;

function chatModels(catalog: Record<string, PiCatalogModel>, api: Api): Map<string, PiCatalogModel> {
  return new Map(Object.values(catalog).flatMap((model) => (model.api === api ? [[model.id, model] as const] : [])));
}

const WORKERS_AI_CATALOG = chatModels(CLOUDFLARE_WORKERS_AI_MODELS, 'openai-completions');
const CLAUDE_CATALOG = chatModels(CLOUDFLARE_AI_GATEWAY_MODELS, 'anthropic-messages');

/** Pi's entry for a Workers AI model, spoken to over the OpenAI Completions protocol. */
export function piWorkersAiModel(modelId: string): PiCatalogModel | undefined {
  return isWorkersAiModelId(modelId) ? WORKERS_AI_CATALOG.get(modelId) : undefined;
}

/** Pi's entry for a Claude model, spoken to over the Anthropic Messages protocol. */
export function piClaudeModel(modelId: string): PiCatalogModel | undefined {
  return isClaudeId(modelId) ? CLAUDE_CATALOG.get(modelId) : undefined;
}

/**
 * Every Claude model Pi lists that can drive the builder: a window large enough for the prompt,
 * tools, and a working transcript. Every Claude Messages model calls tools.
 */
export function claudeBuilderModels(): BuilderModel[] {
  return [...CLAUDE_CATALOG.values()].flatMap((model) => {
    const id = model.id;
    if (!isClaudeId(id) || model.contextWindow < MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS) {
      return [];
    }
    const label = model.name.replace(/\s*\(latest\)\s*$/i, '');
    return [
      {
        id,
        label,
        description: `Anthropic's ${label}, through this account's AI Gateway with its own Anthropic key.`,
        contextTokens: model.contextWindow,
        requiresPaid: false,
        reasoning: model.reasoning,
        vision: model.input.includes('image'),
      },
    ];
  });
}

function isClaudeId(id: string): id is ClaudeModelId {
  return isBuilderModelId(id) && isClaudeModelId(id);
}
