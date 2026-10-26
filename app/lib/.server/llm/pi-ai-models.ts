import type {
  Api,
  AssistantMessageEventStream,
  Model,
  ModelCost,
  OpenAICompletionsCompat,
  FetchFunction,
  SimpleStreamOptions,
  StreamFunction,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  stream as openaiCompletionsStream,
  streamSimple as openaiCompletionsStreamSimple,
  type OpenAICompletionsOptions,
} from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as openaiResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import {
  stream as anthropicMessagesStream,
  type AnthropicEffort,
  type AnthropicOptions,
} from '@earendil-works/pi-ai/api/anthropic-messages';
import { MIN_ANSWER_TOKENS, thinkingBudgetForLevel } from '@earendil-works/pi-ai/api/simple-options';
import { modelTokenEstimateSafetyTokens } from 'cloudchef-agent/context-limits';
import { z } from 'zod';
import {
  GATEWAY_PROVIDERS,
  gatewayModelProvider,
  type BuilderModel,
  type BuilderModelId,
  type GatewayProviderSlug,
} from '~/lib/workers-ai-model';
import { GATEWAY_BINDING_ORIGIN, piGatewayModel, piWorkersAiModel, type GatewayApi } from './pi-model-catalog';
import { recordPiStage } from './workers-ai-telemetry';
import {
  providerRequestBodySchema,
  withProviderDefaultReasoning,
  type ProviderRequestBody,
} from './provider-default-reasoning';
import {
  workersAiGatewayHeaders,
  workersAiGatewayOptions,
  type WorkersAiGatewayHeaders,
  type WorkersAiGatewayLogging,
  type WorkersAiGatewayOptions,
} from './workers-ai-gateway';

// Keep the runtime to the API implementations it uses (OpenAI Completions for Workers AI and
// OpenRouter, Anthropic Messages, OpenAI Responses), imported directly; Pi's provider index would
// pull in unrelated provider SDKs with Node-only code.

export type WorkersAiAccountCredentials = { binding: Ai };

export type ModelStreamOptions = Omit<SimpleStreamOptions, 'toolChoice'> & {
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
};

export type ModelHandle = {
  model: Model<Api>;
  stream: (model: Model<Api>, context: TranscriptContext, options?: ModelStreamOptions) => AssistantMessageEventStream;
};

type WorkersAiStreamOptions = OpenAICompletionsOptions & Omit<SimpleStreamOptions, 'toolChoice'>;

// SAFETY: `getPiModel` streams through this only the Workers AI model it built, whose `api` is
// `openai-completions`, so every model it receives matches the signature that adapter declares. The
// options type is that adapter's own, not the generic `SimpleStreamOptions`, because this calls the
// adapter's api-level entry point directly (see `builderReasoningEffort`).
const WORKERS_AI_STREAM = openaiCompletionsStream as StreamFunction<Api, WorkersAiStreamOptions>;

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What `getPiModel` reads from a Workers AI catalog entry. */
type PiCatalogEntry = Pick<Model<Api>, 'name' | 'reasoning' | 'input' | 'cost' | 'contextWindow'> & {
  compat?: OpenAICompletionsCompat;
};

/**
 * CloudChef states only what the binding path requires, and Pi's own catalog entry supplies the
 * rest — `compat.thinkingFormat` included, which Pi sets only for the DeepSeek v4 entries. With no
 * dialect named, Pi resolves the format from its provider detection, which for a Cloudflare base URL
 * is a bare `reasoning_effort`, sent only for a level the person chose (`provider-default-reasoning.ts`).
 */
function workersAiCompat(catalog: PiCatalogEntry | undefined): OpenAICompletionsCompat {
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
 * Everything this one request puts in front of the model: every transcript message — the system
 * messages carry the prompt and the tool declarations, and a reasoning model's replayed
 * chain-of-thought is real input. Serialized rather than walked, so JSON framing is counted too —
 * the estimate must lean high, since the budget built on it is what keeps the provider from
 * rejecting the request outright.
 */
function estimateRequestInputTokens(context: TranscriptContext): number {
  let characters = 0;
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
 */
function availableOutputTokens(model: Model<Api>, context: TranscriptContext): number {
  const reserved = estimateRequestInputTokens(context) + modelTokenEstimateSafetyTokens(model.contextWindow);
  return Math.max(0, model.contextWindow - reserved);
}

/**
 * A caller that asked for nothing gets everything left, lifted to `MINIMUM_OUTPUT_TOKENS`. A caller
 * that asked for a specific output size (the context summarizer, a title) keeps
 * it, clamped to what physically fits — but the floor never raises a small request above what the
 * caller asked for, so a 64-token title stays a 64-token title. Neither is ever omitted or zero.
 */
function requestOutputTokens(model: Model<Api>, context: TranscriptContext, requested: number | undefined): number {
  const available = Math.max(MINIMUM_OUTPUT_TOKENS, availableOutputTokens(model, context));
  return requested === undefined ? available : Math.max(1, Math.min(requested, available));
}

export function getPiModel(
  accountCredentials: WorkersAiAccountCredentials,
  modelId: BuilderModelId,
  settings: {
    model?: BuilderModel;
    sessionAffinity?: string;
    gatewayLogging: WorkersAiGatewayLogging;
    /** For a gateway provider's model: which of the account's keys for the provider it is, as Cloudflare last changed it. */
    gatewayKeyRevision?: string;
  },
): ModelHandle {
  if (gatewayModelProvider(modelId) !== null) {
    return getGatewayPiModel(accountCredentials, modelId, {
      gatewayLogging: settings.gatewayLogging,
      keyRevision: settings.gatewayKeyRevision,
      sessionAffinity: settings.sessionAffinity,
    });
  }
  // Pi's entry for the model; a model Pi does not list is never offered (`readWorkersAiBuilderModelCatalog`).
  const catalog: PiCatalogEntry | undefined = piWorkersAiModel(modelId);
  const model: Model<Api> = {
    id: modelId,
    name: catalog?.name ?? modelId,
    api: 'openai-completions',
    provider: 'cloudflare-workers-ai',
    baseUrl: 'https://workers-ai-binding.invalid/v1',
    reasoning: settings.model?.reasoning ?? catalog?.reasoning ?? false,
    input: settings.model?.vision ? ['text', 'image'] : (catalog?.input ?? ['text']),
    cost: catalog?.cost ?? ZERO_COST,
    contextWindow: settings.model?.contextTokens ?? catalog?.contextWindow ?? 128_000,
    // Metadata only: the physical ceiling, never an artificial cap. Pi's catalog numbers are not
    // real provider limits (it lists 16,384 for gpt-oss-120b, which accepted 131,072 in
    // production), and the request's actual ceiling is computed per request in its `stream`.
    maxTokens: settings.model?.contextTokens ?? catalog?.contextWindow ?? 128_000,
    compat: workersAiCompat(catalog),
  };
  return {
    model,
    stream: (streamModel, context, options = {}) => {
      recordPiStage('stream_created', streamModel.id);
      const merged: WorkersAiStreamOptions = {
        ...options,
        maxTokens: requestOutputTokens(streamModel, context, options.maxTokens),
        sessionId: options.sessionId ?? settings.sessionAffinity,
        // Pi's OpenAI-compatible serializer requires a non-empty key before calling custom fetch.
        // The binding adapter forwards only the reviewed session-affinity header.
        apiKey: 'workers-ai-binding',
        fetch: createWorkersAiBindingFetch(accountCredentials.binding, model, {
          gatewayLogging: settings.gatewayLogging,
          reasoningRequested: options.reasoning !== undefined,
        }),
      };
      // Pi's two entry points read the thinking directive from different fields: `streamSimple`
      // accepts `reasoning` and hands the adapter `reasoningEffort`, while the api-level `stream`
      // this calls reads only `reasoningEffort`. Every caller here speaks the `reasoning` spelling —
      // `builderThinkingLevel` in `pi-agent-runner.ts`, and the agent loop that forwards it — so
      // without this one assignment a level the person chose would be silently dropped. The mapping
      // is done here rather than by switching to `streamSimple`, because that entry point re-clamps
      // `maxTokens` with Pi's own estimator and would quietly undo `requestOutputTokens` — including
      // the `MINIMUM_OUTPUT_TOKENS` floor that exists to keep Workers AI's 256-token default from
      // truncating a full-window request.
      //
      // Forwarded verbatim rather than through `clampThinkingLevel`: that clamp reads a
      // `thinkingLevelMap` no Workers AI model here has, so it can only ever downgrade, and a
      // model's real vocabulary is settled by the provider's own rejection in
      // `retryWithinSupportedReasoningEffort` — which needs to see what was actually asked for.
      if (options.reasoning !== undefined) {
        merged.reasoningEffort = options.reasoning;
      }
      return WORKERS_AI_STREAM(streamModel, context, merged);
    },
  };
}

/** The account's own gateway, the one every CloudChef model request goes through. */
const GATEWAY_ID = 'default';
/**
 * Pi's clients require a credential before they send; this placeholder satisfies them, and the
 * gateway transport forwards no credential header at all. It starts `sk-` because Pi's OpenAI
 * Responses client reads any other key sent to OpenAI as a ChatGPT sign-in.
 */
const GATEWAY_PLACEHOLDER_KEY = 'sk-ai-gateway-byok';

type GatewayStreamArgs = {
  model: Model<Api>;
  context: TranscriptContext;
  options: ModelStreamOptions;
  fetch: FetchFunction;
  maxTokens: number;
};

/** How CloudChef speaks one of Pi's APIs through the gateway; every provider on that API shares it. */
type GatewayTransport = {
  /** The path the API's SDK appends to a model's base URL for the one request the builder makes. */
  endpoint: string;
  /** Request headers the provider's API reads; everything else the SDK sets, its credential included, stays here. */
  forwardedHeaders: readonly string[];
  stream: (args: GatewayStreamArgs) => AssistantMessageEventStream;
};

// SAFETY: each transport below is used only for models whose `api` is that transport's own (see
// `piGatewayModel`), so every model a stream receives speaks the protocol its adapter declares.
const ANTHROPIC_MESSAGES_STREAM = anthropicMessagesStream as StreamFunction<Api, AnthropicOptions>;
// SAFETY: as above, for `openai-responses` models.
const OPENAI_RESPONSES_STREAM = openaiResponsesStreamSimple as StreamFunction<Api, SimpleStreamOptions>;
// SAFETY: as above, for `openai-completions` models.
const OPENAI_COMPLETIONS_STREAM = openaiCompletionsStreamSimple as StreamFunction<Api, SimpleStreamOptions>;

/** Pi's simple options, with only the tool choices every OpenAI-shaped API takes as they are. */
function simpleGatewayOptions({ options, fetch, maxTokens }: GatewayStreamArgs): SimpleStreamOptions {
  const { toolChoice, ...rest } = options;
  const simple: SimpleStreamOptions = { ...rest, apiKey: GATEWAY_PLACEHOLDER_KEY, fetch, maxTokens };
  if (toolChoice === 'auto' || toolChoice === 'none') {
    simple.toolChoice = toolChoice;
  }
  return simple;
}

const GATEWAY_TRANSPORTS = {
  'anthropic-messages': {
    endpoint: 'v1/messages',
    forwardedHeaders: ['anthropic-version', 'anthropic-beta'],
    stream: ({ model, context, options, fetch, maxTokens }) => {
      // A forced tool choice is not offered: with thinking on, Anthropic accepts only `auto`, which is
      // also its default, so the field is never sent.
      const { toolChoice: _toolChoice, reasoning, ...rest } = options;
      const merged: AnthropicOptions = {
        ...rest,
        apiKey: GATEWAY_PLACEHOLDER_KEY,
        fetch,
        maxTokens,
        // Thinking is always on for a reasoning model. Pi turns this into adaptive thinking for the
        // models Anthropic manages it on, at the model's own default effort unless the person chose
        // one, and a thinking budget for older ones.
        thinkingEnabled: model.reasoning,
      };
      if (model.reasoning) {
        if (
          model.compat !== undefined &&
          'forceAdaptiveThinking' in model.compat &&
          model.compat.forceAdaptiveThinking
        ) {
          if (reasoning !== undefined) {
            merged.effort = anthropicEffort(model, reasoning);
          }
        } else {
          // Anthropic has no default budget, and Pi's fallback is its minimum, below "Low", so with
          // no level chosen it thinks at the "High" budget. The budget stays under the response ceiling, as
          // Anthropic requires, with Pi's room left for the answer.
          merged.thinkingBudgetTokens = Math.min(
            thinkingBudgetForLevel(reasoning ?? 'high'),
            Math.max(1_024, maxTokens - MIN_ANSWER_TOKENS),
          );
        }
      }
      return ANTHROPIC_MESSAGES_STREAM(model, context, merged);
    },
  },
  'openai-responses': {
    endpoint: 'responses',
    forwardedHeaders: [],
    stream: (args) => OPENAI_RESPONSES_STREAM(args.model, args.context, simpleGatewayOptions(args)),
  },
  'openai-completions': {
    endpoint: 'chat/completions',
    // OpenRouter's sticky routing reads the session id Pi sends here, which keeps a chat on the
    // provider that holds its cached prefix.
    forwardedHeaders: ['x-session-id'],
    stream: (args) => OPENAI_COMPLETIONS_STREAM(args.model, args.context, simpleGatewayOptions(args)),
  },
} satisfies Record<GatewayApi, GatewayTransport>;

/**
 * Anthropic's effort for a level the person chose, in the model's own vocabulary where Pi's
 * catalog maps it (`xhigh`, `max`), and Pi's reading of the generic levels otherwise.
 */
function anthropicEffort(model: Model<Api>, level: NonNullable<ModelStreamOptions['reasoning']>): AnthropicEffort {
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === 'low' || mapped === 'medium' || mapped === 'high' || mapped === 'xhigh' || mapped === 'max') {
    return mapped;
  }
  return level === 'minimal' ? 'low' : level === 'xhigh' || level === 'max' ? 'high' : level;
}

/** What a request sent with a key the provider refused, or with none on the gateway, reports. */
export function gatewayKeyRejectedMessage(provider: GatewayProviderSlug): string {
  const { label } = GATEWAY_PROVIDERS[provider];
  return `${label} refused this account's ${label} key, or the account's AI Gateway has none. An admin can link a working key in Settings, under Models.`;
}

/**
 * A gateway provider's model runs through Pi's own implementation of the provider's API (the
 * provider's official SDK underneath), with Pi's catalog entry for the model: its window, output
 * ceiling, and thinking compatibility, exactly as Pi describes it. Only the transport is CloudChef's:
 * the SDK's request is handed to the account's own `default` AI Gateway through the Workers AI
 * binding, which the gateway accepts as the account itself, so no gateway token exists. The gateway
 * adds the account's stored key for the provider (BYOK) because the request carries none: the SDK's
 * own credential header never leaves this Worker.
 */
function getGatewayPiModel(
  accountCredentials: WorkersAiAccountCredentials,
  modelId: BuilderModelId,
  {
    gatewayLogging,
    keyRevision,
    sessionAffinity,
  }: { gatewayLogging: WorkersAiGatewayLogging; keyRevision?: string; sessionAffinity?: string },
): ModelHandle {
  const entry = piGatewayModel(modelId);
  if (!entry) {
    throw new Error(`Pi does not list the model "${modelId}".`);
  }
  const transport = GATEWAY_TRANSPORTS[entry.api];
  const route = {
    provider: entry.provider,
    endpoint: `${new URL(entry.model.baseUrl).pathname}/${transport.endpoint}`.replace(/^\/+/, ''),
    forwardedHeaders: transport.forwardedHeaders,
    gatewayLogging,
    keyRevision,
  };
  const handle: ModelHandle = {
    model: entry.model,
    stream: (streamModel, context, options = {}) => {
      recordPiStage('stream_created', streamModel.id);
      return transport.stream({
        model: streamModel,
        context,
        fetch: createGatewayFetch(accountCredentials.binding, {
          ...route,
          reasoning: {
            model: streamModel,
            requested: options.reasoning !== undefined,
            // Only OpenAI's own Responses API is known to stream reasoning summaries on request.
            summaries: entry.provider === 'openai',
          },
        }),
        maxTokens: Math.min(streamModel.maxTokens, requestOutputTokens(streamModel, context, options.maxTokens)),
        options: {
          // The chat's affinity key: OpenAI Responses sends it as `prompt_cache_key`, OpenRouter as
          // its session id, so a chat's requests keep reusing its cached prefix.
          ...options,
          sessionId: options.sessionId ?? sessionAffinity,
        },
      });
    },
  };
  return handle;
}

/** Everything a gateway request carries: no provider credential of any kind. */
type GatewayRequestHeaders = WorkersAiGatewayHeaders & Record<string, string> & { 'content-type': 'application/json' };

/**
 * Sends the SDK's request through `env.AI.gateway('default')` as a universal request to the model's
 * provider, at the one endpoint the builder uses. The body goes as the SDK wrote it; the headers are
 * the provider API's own (its version and betas), plus the gateway's: whether to log the request,
 * filed under the chat and person when logged, as the person chose in Settings, and never cached. The
 * gateway adds the account's `default` key for the provider, the only one it uses on binding requests.
 *
 * One refusal is answered once by a corrected request: OpenAI refuses reasoning summaries to an
 * organization it hasn't verified, so that request goes again without one, and requests with that key
 * ask for none from then on.
 */
function createGatewayFetch(
  binding: Ai,
  route: {
    provider: GatewayProviderSlug;
    endpoint: string;
    forwardedHeaders: readonly string[];
    gatewayLogging: WorkersAiGatewayLogging;
    /** Which of the account's keys for the provider the turn looked up. */
    keyRevision?: string;
    /** The model this request is for, and whether it asked for a reasoning level. */
    reasoning: { model: Model<Api>; requested: boolean; summaries: boolean };
  },
): FetchFunction {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const endpoint = url.pathname.replace(/^\/+/, '');
    if (url.origin !== GATEWAY_BINDING_ORIGIN || endpoint !== route.endpoint) {
      throw new Error(`CloudChef sends this model only ${route.endpoint} requests.`);
    }
    const forwarded: Record<string, string> = {};
    for (const name of route.forwardedHeaders) {
      const value = request.headers.get(name);
      if (value) {
        forwarded[name] = value;
      }
    }
    const send = (query: ProviderRequestBody | WrittenBody) => {
      const headers: GatewayRequestHeaders = {
        'content-type': 'application/json',
        ...workersAiGatewayHeaders(route.gatewayLogging),
        ...forwarded,
      };
      return binding
        .gateway(GATEWAY_ID)
        .run({ provider: route.provider, endpoint, headers, query }, { signal: request.signal });
    };
    // Which key a refusal of reasoning summaries is remembered against, so a key put in its place since
    // starts afresh.
    const refusalKey = `${route.provider}:${route.keyRevision ?? ''}`;
    const summariesRefused = refusedSummaryKeys(binding);
    // A body whose reasoning fields are not shaped as Pi writes them goes exactly as written.
    const body = await request.json();
    const parsed = providerRequestBodySchema.safeParse(body);
    const query = parsed.success
      ? withProviderDefaultReasoning(route.reasoning.model, parsed.data, {
          requested: route.reasoning.requested,
          summaries: summariesRefused.has(refusalKey) ? 'refused' : route.reasoning.summaries,
        })
      : writtenBodySchema.parse(body);
    let response = await send(query);
    if (
      response.status === 400 &&
      parsed.success &&
      parsed.data.reasoning?.summary !== undefined &&
      refusesReasoningSummaries(await readText(response.clone()))
    ) {
      summariesRefused.add(refusalKey);
      delete parsed.data.reasoning.summary;
      if (Object.keys(parsed.data.reasoning).length === 0) {
        delete parsed.data.reasoning;
      }
      await response.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();
      recordPiStage('gateway_corrected_retry', route.reasoning.model.id);
      response = await send(query);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      // `error.message` is where both Anthropic's and OpenAI's SDKs read a refusal, so each reports
      // this message rather than a bare status.
      const message = gatewayKeyRejectedMessage(route.provider);
      const error = { type: 'authentication_error', message };
      return Response.json(
        { type: 'error', message, error },
        { status: response.status, headers: { 'content-type': 'application/json' } },
      );
    }
    return response;
  };
}

/**
 * The keys (`provider:revision`) each account's AI binding found refused reasoning summaries, so later
 * requests with them ask for none. Held as long as the binding is, in this isolate.
 */
const SUMMARIES_REFUSED = new WeakMap<Ai, Set<string>>();

function refusedSummaryKeys(binding: Ai): Set<string> {
  let refused = SUMMARIES_REFUSED.get(binding);
  if (!refused) {
    refused = new Set();
    SUMMARIES_REFUSED.set(binding, refused);
  }
  return refused;
}

/**
 * OpenAI's refusal of a reasoning summary to an organization it hasn't verified: "Your organization
 * must be verified to generate reasoning summaries", on the `reasoning.summary` parameter. Both
 * halves are required, so no other 400 is retried.
 */
function refusesReasoningSummaries(body: string): boolean {
  return /reasoning[ ._]summar/i.test(body) && /verif/i.test(body);
}

async function readText(response: Response): Promise<string> {
  return response.text().catch(() => '');
}

/** The OpenAI-compatible body Pi serialises, forwarded to the binding verbatim apart from `model`. */
type WorkersAiBindingInputs = ProviderRequestBody;

/** Any JSON object body, sent as written: it is read for nothing. */
const writtenBodySchema = z.looseObject({});
type WrittenBody = z.infer<typeof writtenBodySchema>;

type WorkersAiRawRunOptions = {
  returnRawResponse: true;
  signal: AbortSignal;
  extraHeaders?: Record<string, string>;
  gateway?: WorkersAiGatewayOptions;
};

type WorkersAiRawBinding = {
  run(model: string, inputs: WorkersAiBindingInputs | WrittenBody, options: WorkersAiRawRunOptions): Promise<Response>;
};

function createWorkersAiBindingFetch(
  binding: Ai,
  model: Model<Api>,
  { gatewayLogging, reasoningRequested }: { gatewayLogging: WorkersAiGatewayLogging; reasoningRequested: boolean },
): FetchFunction {
  const modelId = model.id;
  return async (input, init) => {
    recordPiStage('binding_fetch_enter', modelId);
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    // SAFETY: `Ai.run` is generic over the generated `AiModelList`, which does not enumerate every
    // Workers AI model CloudChef can be pointed at. The binding itself accepts any model id, so the
    // raw-response entry point is reached through the non-generic contract it actually implements.
    const rawBinding = binding as WorkersAiRawBinding;
    const sessionAffinity = request.headers.get('x-session-affinity');
    const options: WorkersAiRawRunOptions = {
      returnRawResponse: true,
      signal: request.signal,
      gateway: workersAiGatewayOptions(gatewayLogging),
    };
    if (sessionAffinity) {
      options.extraHeaders = { 'x-session-affinity': sessionAffinity };
    }
    const body = await request.json();
    const parsed = providerRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      // As on the gateway: a body whose reasoning fields are not shaped as Pi writes them goes exactly
      // as written (bar `model`), with none of the corrections below, which read those fields.
      const { model: _model, ...written } = writtenBodySchema.parse(body);
      recordPiStage('binding_run_start', modelId);
      const response = await rawBinding.run(modelId, written, options);
      recordPiStage('binding_run_response', modelId, response.status);
      return response;
    }
    let payload = withProviderDefaultReasoning(model, parsed.data, { requested: reasoningRequested });
    // The model is the first binding argument; keeping it out of inputs matches env.AI.run().
    delete payload.model;
    recordPiStage('binding_run_start', modelId);
    let response = await rawBinding.run(modelId, payload, options);
    recordPiStage('binding_run_response', modelId, response.status);
    // A completion-cap rejection can reveal a second, smaller total-context limit. Allow both
    // corrections, but never loop indefinitely or replay an unchanged request.
    for (let attempt = 0; attempt < 2 && response.status === 400; attempt += 1) {
      const body = await response
        .clone()
        .text()
        .catch(() => '');
      const corrected =
        withinProviderContextLimit(model, payload, body) ??
        withinProviderOutputCap(modelId, payload, body) ??
        withinSupportedReasoningEffort(modelId, payload, body);
      if (!corrected) {
        break;
      }
      // The refusal was read from its clone; its own body is never read, so it is let go.
      await response.body?.cancel().catch(() => undefined);
      request.signal.throwIfAborted();
      payload = corrected;
      response = await rawBinding.run(modelId, payload, options);
      recordPiStage('binding_run_response', modelId, response.status);
    }
    return response;
  };
}

/**
 * Cloudflare's catalog window is not always the provider's completion cap: glm-5.3-flash advertises
 * a 1,310,720-token window and rejects any `max_completion_tokens` above 1,048,576, so the budget
 * computed from the window fails every request for that model. The rejection names the real cap, so
 * the request is replayed once at that number. The caller bounds recovery attempts and
 * can also correct a total-context rejection from that replay.
 */
const PROVIDER_OUTPUT_CAP_PATTERN = /supports at most (\d+) completion tokens/;

function withinProviderOutputCap(
  modelId: string,
  payload: WorkersAiBindingInputs,
  body: string,
): WorkersAiBindingInputs | undefined {
  const requested = payload.max_completion_tokens;
  if (requested === undefined) {
    return undefined;
  }
  const cap = Number(PROVIDER_OUTPUT_CAP_PATTERN.exec(body)?.[1]);
  if (!Number.isFinite(cap) || cap <= 0 || cap >= requested) {
    return undefined;
  }
  recordPiStage('binding_output_cap_retry', modelId);
  return { ...payload, max_completion_tokens: cap };
}

/** Use the provider's actual input count, including its tool/message framing, not our estimate. */
const PROVIDER_CONTEXT_LIMIT_PATTERN = /maximum context length of (\d+) tokens/i;
const PROVIDER_INPUT_TOKENS_PATTERN = /(\d+) tokens from the input messages/i;

function withinProviderContextLimit(
  model: Model<Api>,
  payload: WorkersAiBindingInputs,
  body: string,
): WorkersAiBindingInputs | undefined {
  const limit = Number(PROVIDER_CONTEXT_LIMIT_PATTERN.exec(body)?.[1]);
  const input = Number(PROVIDER_INPUT_TOKENS_PATTERN.exec(body)?.[1]);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(input) || input < 0) {
    return undefined;
  }
  // Keep the corrected window on this turn's handle so later tool steps budget against it too.
  model.contextWindow = Math.min(model.contextWindow, limit);
  const available = limit - input - modelTokenEstimateSafetyTokens(limit);
  const requested = payload.max_completion_tokens;
  // A genuinely full input needs compaction; do not silently request a truncated answer.
  if (requested === undefined || available < MINIMUM_OUTPUT_TOKENS || available >= requested) {
    return undefined;
  }
  recordPiStage('binding_context_limit_retry', model.id);
  return { ...payload, max_completion_tokens: available };
}

/**
 * The same shape as the output-cap replay, for the other request field Workers AI validates per
 * model. This is the single place that records what Workers AI does with a reasoning effort; the
 * other sites that care point here rather than repeating the provider's wording.
 *
 * Pi only translates a directive into a model's own vocabulary when its static catalog carries a
 * `thinkingLevelMap` for it, which pi-ai does not carry for most of the Workers AI catalog, so the
 * value goes out as written; `@cf/qwen/qwen3.8-27b`, for one, rejects `high` with `Unexpected
 * reasoning effort high. Supported types are xhigh (default), medium, and low.` The picker offers
 * only the levels Pi's catalog lists, so this is reached only when Pi's catalog and the provider
 * disagree.
 *
 * The rejection names the supported set verbatim, so it is read rather than guessed, and the
 * strongest offered value wins: a downgrade below what the model can do is a real loss for a builder.
 */
const REASONING_EFFORT_MENTION_PATTERN = /reasoning[ _]effort/i;
const SUPPORTED_REASONING_EFFORT_PATTERN = /supported types are ([^.]+)/i;
/** Strongest first, which is the order the replacement is chosen in. */
const REASONING_EFFORT_PREFERENCE = ['xhigh', 'high', 'medium', 'low'] as const;

function withinSupportedReasoningEffort(
  modelId: string,
  payload: WorkersAiBindingInputs,
  body: string,
): WorkersAiBindingInputs | undefined {
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
  return { ...payload, reasoning_effort: supported };
}

/**
 * Word-bounded so the list `xhigh (default), medium, and low` is not read as offering `high`: the
 * two are different values to the provider, and the substring match would replay the same rejected
 * effort under a different name.
 */
function namesReasoningEffort(offered: string, effort: string): boolean {
  return new RegExp(`\\b${effort}\\b`, 'i').test(offered);
}
