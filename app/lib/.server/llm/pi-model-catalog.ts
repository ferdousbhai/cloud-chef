import type { Api, Model } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { CLOUDFLARE_AI_GATEWAY_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models';
import {
  GATEWAY_PROVIDERS,
  GATEWAY_PROVIDER_SLUGS,
  isBuilderModelId,
  isWorkersAiModelId,
  MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS,
  type BuilderModel,
  type BuilderReasoningLevel,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';

/**
 * Pi's catalogs are the source of truth for which models CloudChef offers and how each one is
 * spoken to: a model Pi does not list is not offered, because CloudChef would otherwise have to
 * guess its request shape. Workers AI models come from Pi's `cloudflare-workers-ai` catalog (and
 * must also be in the account's live catalog). Every other provider's models come from Pi's catalog
 * for it, and are served through the account's default AI Gateway with the account's own key for
 * that provider, offered only while the gateway holds one.
 */

type PiCatalogModel = Model<Api>;

/** The Pi APIs CloudChef can carry through the AI Gateway binding: each has a transport in `pi-ai-models.ts`. */
export const GATEWAY_APIS = ['anthropic-messages', 'openai-responses', 'openai-completions'] as const;
export type GatewayApi = (typeof GATEWAY_APIS)[number];

/** Pi's gateway catalog writes its models' base URLs against this, with the account and gateway left as placeholders. */
const PI_GATEWAY_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}';

/**
 * Where a provider's models are in Pi, and the upstream URL its AI Gateway slug stands for: a
 * request's gateway endpoint is its URL after that base (`v1/messages`, `v1/chat/completions`).
 * Only models whose base URL is under it are this provider's.
 */
type GatewayModelSource = { models: Readonly<Record<string, PiCatalogModel>>; upstreamBaseUrl: string };

const GATEWAY_MODEL_SOURCES = {
  anthropic: [{ models: CLOUDFLARE_AI_GATEWAY_MODELS, upstreamBaseUrl: `${PI_GATEWAY_BASE_URL}/anthropic` }],
  openai: [{ models: CLOUDFLARE_AI_GATEWAY_MODELS, upstreamBaseUrl: `${PI_GATEWAY_BASE_URL}/openai` }],
  grok: [{ models: XAI_MODELS, upstreamBaseUrl: 'https://api.x.ai' }],
  openrouter: [{ models: OPENROUTER_MODELS, upstreamBaseUrl: 'https://openrouter.ai/api' }],
} satisfies Record<GatewayProviderSlug, readonly GatewayModelSource[]>;

/**
 * Never fetched: a gateway model's SDK builds its URLs on this, and the gateway transport reads only
 * the path, which is the provider's own endpoint.
 */
export const GATEWAY_BINDING_ORIGIN = 'https://ai-gateway-binding.invalid';

/** A provider's model as the gateway transport speaks to it. */
type PiGatewayModel = {
  provider: GatewayProviderSlug;
  api: GatewayApi;
  /** Pi's model, with its base URL moved onto `GATEWAY_BINDING_ORIGIN`. */
  model: PiCatalogModel;
  builderModel: BuilderModel;
};

/**
 * The efforts a person may choose for a model: the levels Pi's catalog says the model supports, in
 * Pi's order, without "off" — CloudChef never offers turning reasoning off — and without "minimal"
 * unless the model maps it to a value of its own (on the rest Pi folds it into "low", so it would only
 * repeat that row). Undefined for a model that does not reason.
 */
function builderReasoningLevels(model: Model<Api>): BuilderReasoningLevel[] | undefined {
  if (!model.reasoning) {
    return undefined;
  }
  const levels = getSupportedThinkingLevels(model).filter(
    (level): level is BuilderReasoningLevel =>
      level !== 'off' && (level !== 'minimal' || (model.thinkingLevelMap?.minimal ?? null) !== null),
  );
  return levels.length > 0 ? levels : undefined;
}

function chatModels(catalog: Readonly<Record<string, PiCatalogModel>>, api: Api): Map<string, PiCatalogModel> {
  return new Map(Object.values(catalog).flatMap((model) => (model.api === api ? [[model.id, model] as const] : [])));
}

const WORKERS_AI_CATALOG = chatModels(CLOUDFLARE_WORKERS_AI_MODELS, 'openai-completions');

/**
 * Entries Pi lists as chat models that cannot drive a build, by what their ids say they are. Pi's
 * catalog records input modalities but not output ones, and nothing about routing or batch-only
 * serving, so these are matched on the id — each row a kind of model, never a single model, so a new
 * entry of the same kind is excluded without an edit here.
 */
const NON_BUILDER_MODEL_KINDS: readonly { kind: string; id: RegExp }[] = [
  // Served only through OpenRouter's asynchronous batch API: a streamed builder request never completes.
  { kind: 'batch-only variant', id: /:batch$/ },
  // OpenRouter's routers choose a different model per request, so no window, tool protocol, or
  // reasoning setting holds from one step of a turn to the next.
  { kind: 'model router', id: /^openrouter\// },
  // Their output is speech or pictures, not the text and tool calls a build is made of.
  { kind: 'audio or image model', id: /(^|[/-])(audio|image|tts|realtime)(-|$)/ },
  { kind: 'search-only model', id: /(^|[/-])search(-|$)/ },
  { kind: 'safety classifier', id: /safeguard/ },
];

/** Whether Pi's entry is a model a builder can be driven with, by its kind. */
function isBuilderCapableKind(piModelId: string): boolean {
  return !NON_BUILDER_MODEL_KINDS.some(({ id }) => id.test(piModelId));
}

function gatewayApi(api: Api): GatewayApi | null {
  return GATEWAY_APIS.find((candidate) => candidate === api) ?? null;
}

/**
 * Every model Pi lists for a gateway provider that can drive the builder: one CloudChef has a
 * transport for, with a window large enough for the prompt, tools, and a working transcript. Pi's
 * chat catalogs list models that call tools.
 */
function gatewayCatalog(): Map<string, PiGatewayModel> {
  const catalog = new Map<string, PiGatewayModel>();
  for (const provider of GATEWAY_PROVIDER_SLUGS) {
    const { label: providerLabel } = GATEWAY_PROVIDERS[provider];
    for (const { models, upstreamBaseUrl } of GATEWAY_MODEL_SOURCES[provider]) {
      for (const piModel of Object.values(models)) {
        const api = gatewayApi(piModel.api);
        const id = `${provider}/${piModel.id}`;
        if (
          api === null ||
          !piModel.baseUrl.startsWith(upstreamBaseUrl) ||
          piModel.contextWindow < MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS ||
          !isBuilderCapableKind(piModel.id) ||
          !isBuilderModelId(id) ||
          catalog.has(id)
        ) {
          continue;
        }
        const label = piModel.name.replace(/\s*\(latest\)\s*$/i, '');
        catalog.set(id, {
          provider,
          api,
          model: { ...piModel, baseUrl: `${GATEWAY_BINDING_ORIGIN}${piModel.baseUrl.slice(upstreamBaseUrl.length)}` },
          builderModel: {
            id,
            label,
            description: `${label} from ${providerLabel}, through this account's AI Gateway with its own ${providerLabel} key.`,
            contextTokens: piModel.contextWindow,
            requiresPaid: false,
            reasoning: piModel.reasoning,
            vision: piModel.input.includes('image'),
            ...withReasoningLevels(piModel),
          },
        });
      }
    }
  }
  return catalog;
}

/** The `reasoningLevels` field for a builder model, present only when there are levels to offer. */
export function withReasoningLevels(model: Model<Api>): Pick<BuilderModel, 'reasoningLevels'> {
  const reasoningLevels = builderReasoningLevels(model);
  return reasoningLevels ? { reasoningLevels } : {};
}

const GATEWAY_CATALOG = gatewayCatalog();

/** Pi's entry for a Workers AI model, spoken to over the OpenAI Completions protocol. */
export function piWorkersAiModel(modelId: string): PiCatalogModel | undefined {
  return isWorkersAiModelId(modelId) ? WORKERS_AI_CATALOG.get(modelId) : undefined;
}

/** A gateway provider's model by its builder id (`anthropic/claude-opus-5-5`), if Pi lists it. */
export function piGatewayModel(modelId: string): PiGatewayModel | undefined {
  return GATEWAY_CATALOG.get(modelId);
}

/** The builder models of the given gateway providers, in Pi's order. */
export function gatewayBuilderModels(providers: readonly GatewayProviderSlug[]): BuilderModel[] {
  const offered = new Set(providers);
  return [...GATEWAY_CATALOG.values()].flatMap(({ provider, builderModel }) =>
    offered.has(provider) ? [builderModel] : [],
  );
}
