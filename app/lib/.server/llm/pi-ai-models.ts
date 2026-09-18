import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelCost,
  OpenAICompletionsCompat,
  FetchFunction,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
} from '@earendil-works/pi-ai';
import {
  stream as openaiCompletionsStream,
  type OpenAICompletionsOptions,
} from '@earendil-works/pi-ai/api/openai-completions';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import { modelTokenEstimateSafetyTokens } from 'cloudchef-agent/context-limits';
import type { WorkersAiModel, WorkersAiRuntimeModelId } from '~/lib/workers-ai-model';
import { recordPiStage } from './pi-telemetry';

// Keep the runtime on the Workers-AI-only catalog; importing unrelated provider SDKs would
// add Node-only code to every user-owned runtime.

export type WorkersAiAccountCredentials = { binding: Ai };

export type ModelStreamOptions = SimpleStreamOptions & {
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
};

export type ModelHandle = {
  model: Model<Api>;
  stream: (model: Model<Api>, context: Context, options?: ModelStreamOptions) => AssistantMessageEventStream;
  lastResponse?: { status: number };
};

// SAFETY: `makeHandle` refuses any model whose `api` is not `openai-completions`, so every model this
// stream ever receives matches the narrower signature the OpenAI Completions adapter declares. The
// options type is that adapter's own, not the generic `SimpleStreamOptions`, because this calls the
// adapter's api-level entry point directly (see `builderReasoningEffort`).
const WORKERS_AI_STREAM = openaiCompletionsStream as StreamFunction<
  Api,
  OpenAICompletionsOptions & SimpleStreamOptions
>;

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type WorkersAiCatalogModel = (typeof CLOUDFLARE_WORKERS_AI_MODELS)[keyof typeof CLOUDFLARE_WORKERS_AI_MODELS];

const WORKERS_AI_CATALOG = new Map<string, WorkersAiCatalogModel>(Object.entries(CLOUDFLARE_WORKERS_AI_MODELS));

function catalogModel(modelId: string): WorkersAiCatalogModel | undefined {
  return WORKERS_AI_CATALOG.get(modelId);
}

/**
 * CloudChef states only what the binding path requires, and Pi's own catalog entry supplies the
 * rest — `compat.thinkingFormat` included, which today every Workers AI entry omits.
 *
 * CloudChef used to name a thinking dialect itself, by model-id prefix, for the families Pi does
 * not characterise. That is gone because it was measured to do nothing: Cloudflare ignores every
 * vendor-native thinking block those dialects produce. Toggling `thinking: { type: 'disabled' }`
 * moved the returned reasoning not at all — glm-5.3-flash 43ch against a 43ch baseline,
 * qwen3.8-27b 108 against 150, deepseek-v4-pro 103 against 97 — while only the documented
 * `chat_template_kwargs.enable_thinking = false` took all three to 0ch.
 *
 * With no dialect named, Pi resolves the format from its own provider detection, which for a
 * Cloudflare base URL is the `"openai"` default: a bare `reasoning_effort`, and not even that
 * unless a caller asks for an effort (`builderThinkingLevel` in `pi-agent-runner.ts` currently
 * sends none) or the model carries a `thinkingLevelMap.off` string, which the model built below
 * never does. So no thinking directive reaches the provider at all, which is what was already
 * happening in substance.
 */
function workersAiCompat(catalog: WorkersAiCatalogModel | undefined): OpenAICompletionsCompat {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsLongCacheRetention: false,
    ...catalog?.compat,
    sendSessionAffinityHeaders: true,
  };
}

const ESTIMATED_CHARACTERS_PER_TOKEN = 4;

/**
 * Everything this one request puts in front of the model: the system prompt, every message
 * (thinking blocks included, because a reasoning model's replayed chain-of-thought is real input),
 * and the tool schemas. Serialized rather than walked, so JSON framing is counted too — the
 * estimate must lean high, since the budget built on it is what keeps the provider from rejecting
 * the request outright.
 */
function estimateRequestInputTokens(context: Context): number {
  let characters = context.systemPrompt?.length ?? 0;
  for (const tool of context.tools ?? []) {
    characters += tool.name.length + tool.description.length + serializedLength(tool.parameters);
  }
  for (const message of context.messages) {
    characters += serializedLength(message);
  }
  return Math.ceil(characters / ESTIMATED_CHARACTERS_PER_TOKEN);
}

function serializedLength<T>(value: T): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The floor under every request, and the reason `max_completion_tokens` is never omitted: Pi drops
 * the field for a falsy value, and Workers AI's own default is 256 tokens — measured, gpt-oss-120b
 * with the field absent finished at `completion_tokens: 256` with `finish_reason: length`. That is
 * exactly the silent truncation this budget exists to remove, so a request whose input already
 * fills the window still asks for a real number. The provider then either answers or rejects with
 * its explicit "exceeds the model's maximum context length" error, which is visible and
 * actionable; a 256-token stub is neither.
 */
const MINIMUM_OUTPUT_TOKENS = 4_096;

/**
 * How much of the window this one request leaves free. The ceiling cannot be a constant, because
 * Workers AI rejects any request where input tokens + `max_completion_tokens` exceed the model's
 * context window. So the honest answer to "how much may this model write?" is "whatever the window
 * has left once this request's input is counted" — recomputed per request, never a fixed number.
 * A static cap (CloudChef previously asked for 24,576 tokens regardless) only ever truncated a
 * model that could physically have produced far more.
 */
function availableOutputTokens(model: Model<Api>, context: Context): number {
  const reserved = estimateRequestInputTokens(context) + modelTokenEstimateSafetyTokens(model.contextWindow);
  return Math.max(0, model.contextWindow - reserved);
}

/**
 * A caller that asked for a specific output size (the context summarizer, prompt refinement) keeps
 * it, clamped to what physically fits. A caller that asked for nothing gets everything left. Both
 * are then lifted to `MINIMUM_OUTPUT_TOKENS`, which is never omitted and never zero.
 */
function requestOutputTokens(model: Model<Api>, context: Context, requested: number | undefined): number {
  const available = availableOutputTokens(model, context);
  return Math.max(MINIMUM_OUTPUT_TOKENS, requested === undefined ? available : Math.min(requested, available));
}

type HandleArgs = {
  model: Model<Api>;
  apiKey?: string;
  fetch?: FetchFunction;
  sessionAffinity?: string;
};

function makeHandle(args: HandleArgs): ModelHandle {
  if (args.model.api !== 'openai-completions') {
    throw new Error(`Workers AI requires the OpenAI Completions protocol; received "${args.model.api}".`);
  }

  const handle: ModelHandle = {
    model: args.model,
    stream: (model, context, options = {}) => {
      recordPiStage('stream_created', model.id);
      handle.lastResponse = undefined;
      const streamOptions = { ...options };
      const headers: ProviderHeaders = { ...streamOptions.headers };
      const merged: OpenAICompletionsOptions & SimpleStreamOptions = {
        ...streamOptions,
        maxTokens: requestOutputTokens(model, context, streamOptions.maxTokens),
        sessionId: streamOptions.sessionId ?? args.sessionAffinity,
        onResponse: async (response, responseModel) => {
          handle.lastResponse = { status: response.status };
          await streamOptions.onResponse?.(response, responseModel);
        },
      };
      // Pi's two entry points read the thinking directive from different fields: `streamSimple`
      // accepts `reasoning` and hands the adapter `reasoningEffort`, while the api-level `stream`
      // this calls reads only `reasoningEffort`. Every caller here speaks the `reasoning` spelling —
      // `builderThinkingLevel` in `pi-agent-runner.ts`, and the agent loop that forwards it — so
      // without this one assignment the field is silently dropped and every request goes out with
      // `thinking: { type: 'disabled' }` and no effort at all. The mapping is done here rather than
      // by switching to `streamSimple`, because that entry point re-clamps `maxTokens` with Pi's own
      // estimator and would quietly undo `requestOutputTokens` — including the
      // `MINIMUM_OUTPUT_TOKENS` floor that exists to keep Workers AI's 256-token default from
      // truncating a full-window request.
      //
      // Forwarded verbatim rather than through `clampThinkingLevel`: that clamp reads a
      // `thinkingLevelMap` no Workers AI model here has, so it can only ever downgrade, and a
      // model's real vocabulary is settled by the provider's own rejection in
      // `retryWithinSupportedReasoningEffort` — which needs to see what was actually asked for.
      if (streamOptions.reasoning !== undefined) {
        merged.reasoningEffort = streamOptions.reasoning;
      }
      if (args.apiKey !== undefined) {
        merged.apiKey = args.apiKey;
      }
      if (args.fetch !== undefined) {
        merged.fetch = args.fetch;
      }
      if (Object.keys(headers).length > 0) {
        merged.headers = headers;
      }
      return WORKERS_AI_STREAM(model, context, merged);
    },
  };
  return handle;
}

export function getPiModel(
  accountCredentials: WorkersAiAccountCredentials,
  modelId: WorkersAiRuntimeModelId,
  settings?: { model?: WorkersAiModel; sessionAffinity?: string },
): ModelHandle {
  const catalog = catalogModel(modelId);
  const model: Model<Api> = {
    id: modelId,
    name: catalog?.name ?? modelId,
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    baseUrl: 'https://workers-ai-binding.invalid/v1',
    reasoning: settings?.model?.reasoning ?? catalog?.reasoning ?? false,
    input: settings?.model?.vision ? ['text', 'image'] : (catalog?.input ?? ['text']),
    cost: catalog?.cost ?? ZERO_COST,
    contextWindow: settings?.model?.contextTokens ?? catalog?.contextWindow ?? 128_000,
    // Metadata only: the physical ceiling, never an artificial cap. Pi's catalog numbers are not
    // real provider limits (it lists 16,384 for gpt-oss-120b, which accepted 131,072 in
    // production), and the request's actual ceiling is computed per request in `makeHandle`.
    maxTokens: settings?.model?.contextTokens ?? catalog?.contextWindow ?? 128_000,
    compat: workersAiCompat(catalog),
  };
  return makeHandle({
    model,
    // Pi's OpenAI-compatible serializer requires a non-empty key before calling custom fetch.
    // The binding adapter forwards only the reviewed session-affinity header.
    apiKey: 'workers-ai-binding',
    fetch: createWorkersAiBindingFetch(accountCredentials.binding, modelId, settings?.model?.requiresPaid === true),
    sessionAffinity: settings?.sessionAffinity,
  });
}

/** The OpenAI-compatible body Pi serialises, forwarded to the binding verbatim apart from `model`. */
type WorkersAiBindingInputs = Record<string, unknown> & {
  model?: string;
  max_completion_tokens?: number;
  reasoning_effort?: string;
};

type WorkersAiRawRunOptions = {
  returnRawResponse: true;
  signal: AbortSignal;
  extraHeaders?: Record<string, string>;
  gateway?: { id: string; collectLog?: boolean; skipCache?: boolean };
};

type WorkersAiRawBinding = {
  run(model: string, inputs: WorkersAiBindingInputs, options: WorkersAiRawRunOptions): Promise<Response>;
};

function createWorkersAiBindingFetch(
  binding: Ai,
  modelId: WorkersAiRuntimeModelId,
  routeThroughDefaultGateway: boolean,
): FetchFunction {
  return async (input, init) => {
    recordPiStage('binding_fetch_enter', modelId);
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const payload = await request.json<WorkersAiBindingInputs>();
    // The model is the first binding argument; keeping it out of inputs matches env.AI.run().
    delete payload.model;
    // SAFETY: `Ai.run` is generic over the generated `AiModelList`, which does not enumerate every
    // Workers AI model CloudChef can be pointed at. The binding itself accepts any model id, so the
    // raw-response entry point is reached through the non-generic contract it actually implements.
    const rawBinding = binding as WorkersAiRawBinding;
    recordPiStage('binding_run_start', modelId);
    const sessionAffinity = request.headers.get('x-session-affinity');
    const options: WorkersAiRawRunOptions = { returnRawResponse: true, signal: request.signal };
    if (routeThroughDefaultGateway) {
      options.gateway = { id: 'default', collectLog: false, skipCache: true };
    }
    if (sessionAffinity) {
      options.extraHeaders = { 'x-session-affinity': sessionAffinity };
    }
    const response = await rawBinding.run(modelId, payload, options);
    recordPiStage('binding_run_response', modelId, response.status);
    if (response.status !== 400) {
      return response;
    }
    // Both replays read the same rejection for a different provider string, so the body is consumed
    // once here and handed over as text. Each helper replays at most once and `??` stops at the
    // first one that fires, so a rejection that could be read two ways still costs exactly one
    // replay.
    const rejectionBody = await response
      .clone()
      .text()
      .catch(() => '');
    const retried =
      (await retryWithinProviderOutputCap(rawBinding, modelId, payload, options, rejectionBody)) ??
      (await retryWithinSupportedReasoningEffort(rawBinding, modelId, payload, options, rejectionBody));
    if (!retried) {
      return response;
    }
    recordPiStage('binding_run_response', modelId, retried.status);
    return retried;
  };
}

/**
 * Cloudflare's catalog window is not always the provider's completion cap: glm-5.3-flash advertises
 * a 1,310,720-token window and rejects any `max_completion_tokens` above 1,048,576, so the budget
 * computed from the window fails every request for that model. The rejection names the real cap, so
 * the request is replayed once at that number. The replay calls the binding directly, which is what
 * keeps a second rejection from looping.
 */
const PROVIDER_OUTPUT_CAP_PATTERN = /supports at most (\d+) completion tokens/;

async function retryWithinProviderOutputCap(
  binding: WorkersAiRawBinding,
  modelId: WorkersAiRuntimeModelId,
  payload: WorkersAiBindingInputs,
  options: WorkersAiRawRunOptions,
  body: string,
): Promise<Response | undefined> {
  const requested = payload.max_completion_tokens;
  if (requested === undefined) {
    return undefined;
  }
  const cap = Number(PROVIDER_OUTPUT_CAP_PATTERN.exec(body)?.[1]);
  if (!Number.isFinite(cap) || cap <= 0 || cap >= requested) {
    return undefined;
  }
  recordPiStage('binding_output_cap_retry', modelId);
  return binding.run(modelId, { ...payload, max_completion_tokens: cap }, options);
}

/**
 * The same shape as the output-cap replay, for the other request field Workers AI validates per
 * model. This is the single place that records what Workers AI does with a reasoning effort; the
 * other sites that care point here rather than repeating the provider's wording.
 *
 * Pi only translates a directive into a model's own vocabulary when its static catalog carries a
 * `thinkingLevelMap` for it, which pi-ai 0.83.0 does not for most of the Workers AI catalog, so the
 * value goes out as written. Measured against production, `@cf/qwen/qwen3.8-27b` rejects `high`
 * outright with `Unexpected reasoning effort high. Supported types are xhigh (default), medium, and
 * low.` Were `builderThinkingLevel` sending `high`, a user selecting that model would 400 on every
 * single request, and a GLM retirement that failed over to it would break every build at once.
 *
 * The lane is dormant as it stands: `BUILDER_THINKING_LEVEL` in `pi-agent-runner.ts` is `undefined`,
 * so no builder request carries `reasoning_effort` at all and nothing ever reaches this replay. It
 * stays because that is one constant away from changing, and the repair has to exist before the
 * directive comes back rather than after the first account-wide 400.
 *
 * The rejection names the supported set verbatim, so it is read rather than guessed, and the
 * strongest offered value wins: the builder writes software, which is the work reasoning is for, so
 * a downgrade below what the model can do is a real loss. Hard-coding a per-model table instead
 * would re-fail the day Cloudflare adds a family nobody has probed; reading the provider's own
 * answer keeps working for models this repository has never seen.
 */
const REASONING_EFFORT_MENTION_PATTERN = /reasoning[ _]effort/i;
const SUPPORTED_REASONING_EFFORT_PATTERN = /supported types are ([^.]+)/i;
/** Strongest first, which is the order the replacement is chosen in. */
const REASONING_EFFORT_PREFERENCE = ['xhigh', 'high', 'medium', 'low'] as const;

async function retryWithinSupportedReasoningEffort(
  binding: WorkersAiRawBinding,
  modelId: WorkersAiRuntimeModelId,
  payload: WorkersAiBindingInputs,
  options: WorkersAiRawRunOptions,
  body: string,
): Promise<Response | undefined> {
  const requested = payload.reasoning_effort;
  if (requested === undefined) {
    return undefined;
  }
  // Both halves are required before anything is replayed. The wording is a provider string that may
  // change, and a body this cannot read must fall through to the original rejection unchanged —
  // exactly as the output-cap replay does — rather than resend the request with an invented value.
  if (!REASONING_EFFORT_MENTION_PATTERN.test(body)) {
    return undefined;
  }
  const offered = SUPPORTED_REASONING_EFFORT_PATTERN.exec(body)?.[1];
  if (offered === undefined) {
    return undefined;
  }
  const supported = REASONING_EFFORT_PREFERENCE.find((effort) => namesReasoningEffort(offered, effort));
  // Replaying the value the provider just refused would only spend a second request on the same 400.
  if (supported === undefined || supported === requested) {
    return undefined;
  }
  recordPiStage('binding_reasoning_effort_retry', modelId);
  return binding.run(modelId, { ...payload, reasoning_effort: supported }, options);
}

/**
 * Word-bounded so the list `xhigh (default), medium, and low` is not read as offering `high`: the
 * two are different values to the provider, and the substring match would replay the same rejected
 * effort under a different name.
 */
function namesReasoningEffort(offered: string, effort: string): boolean {
  return new RegExp(`\\b${effort}\\b`, 'i').test(offered);
}
