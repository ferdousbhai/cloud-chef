import type { Api, Model } from '@earendil-works/pi-ai';
import { z } from 'zod';

/**
 * CloudChef never turns a reasoning model's reasoning off. When the person has chosen no level,
 * the request carries no reasoning directive at all, so the provider applies its own default
 * effort — the one the model's maker tuned it for.
 *
 * Pi does not read "no level" that way. Asked for nothing, its adapters write the model's *off*
 * value instead: OpenAI Responses sends `reasoning: { effort: "none" }` (or the model's
 * `thinkingLevelMap.off`), its OpenRouter dialect sends `reasoning: { effort: "none" }`, and the
 * Chat Completions dialects send `reasoning_effort: "none"`, `thinking: { type: "disabled" }`, or
 * `enable_thinking: false`. Each of those disables reasoning on the models that accept it, so this
 * removes exactly those values — and only when no level was requested, so a level a person chose
 * reaches the provider unchanged.
 *
 * OpenAI Responses requests are sent with `store: false`, so a reasoning item replayed on the next
 * request of a tool turn is valid only with its `encrypted_content`. Pi asks for that content only
 * when a level is set; this asks for it on every reasoning model's request, and, as a safety net,
 * drops a replayed reasoning item that still lacks it (and the item ids paired with it), which the
 * provider would otherwise reject as an item it cannot find. On OpenAI's own models it also asks for
 * reasoning summaries, so a long silent think still streams progress the turn's inactivity watchdog
 * can see; the effort itself is left to the provider.
 */

/** A reasoning directive object as Pi's OpenAI-shaped adapters write it. */
const reasoningDirectiveSchema = z.looseObject({
  effort: z.string().optional(),
  enabled: z.boolean().optional(),
  summary: z.string().optional(),
});

const chatTemplateValuesSchema = z.looseObject({ enable_thinking: z.boolean().optional() });

const thinkingObjectSchema = z.looseObject({ type: z.string() });

/** One item of an OpenAI Responses `input`, read only for the fields this module acts on. */
const responsesInputItemSchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  id: z.string().optional(),
  encrypted_content: z.string().nullish(),
});

/**
 * The fields of an OpenAI-shaped request body that carry reasoning, typed as Pi writes them; every
 * other field passes through untouched. A body this cannot read is sent exactly as Pi wrote it.
 */
export const providerRequestBodySchema = z.looseObject({
  model: z.string().optional(),
  max_completion_tokens: z.number().optional(),
  reasoning: reasoningDirectiveSchema.optional(),
  reasoning_effort: z.string().optional(),
  thinking: z.union([thinkingObjectSchema, z.string()]).optional(),
  enable_thinking: z.boolean().optional(),
  chat_template_kwargs: chatTemplateValuesSchema.optional(),
  chat_template_args: chatTemplateValuesSchema.optional(),
  include: z.array(z.string()).optional(),
  input: z.array(responsesInputItemSchema).optional(),
});

export type ProviderRequestBody = z.infer<typeof providerRequestBodySchema>;

type ResponsesInputItem = z.infer<typeof responsesInputItemSchema>;

/** The values that mean "reasoning off" to a model: its own `off` mapping, and the generic `none`. */
function offValues(model: Model<Api>): ReadonlySet<string> {
  const off = z.string().safeParse(model.thinkingLevelMap?.off);
  return new Set(off.success ? [off.data, 'none'] : ['none']);
}

function withoutCompletionsOff(body: ProviderRequestBody, off: ReadonlySet<string>): void {
  const { reasoning } = body;
  if (reasoning !== undefined) {
    if (reasoning.effort !== undefined && off.has(reasoning.effort)) {
      delete reasoning.effort;
    }
    if (reasoning.enabled === false) {
      delete reasoning.enabled;
    }
    if (Object.keys(reasoning).length === 0) {
      delete body.reasoning;
    }
  }
  if (body.reasoning_effort !== undefined && off.has(body.reasoning_effort)) {
    delete body.reasoning_effort;
  }
  const thinkingObject = thinkingObjectSchema.safeParse(body.thinking);
  const thinkingString = z.string().safeParse(body.thinking);
  if (
    (thinkingObject.success && thinkingObject.data.type === 'disabled') ||
    (thinkingString.success && off.has(thinkingString.data))
  ) {
    delete body.thinking;
  }
  if (body.enable_thinking === false) {
    delete body.enable_thinking;
  }
  for (const field of ['chat_template_kwargs', 'chat_template_args'] as const) {
    const values = body[field];
    if (values?.enable_thinking === false) {
      delete values.enable_thinking;
      if (Object.keys(values).length === 0) {
        delete body[field];
      }
    }
  }
}

const ENCRYPTED_REASONING = 'reasoning.encrypted_content';

/** Items that end an assistant's run of output items in a Responses `input`. */
function endsAssistantOutput(item: ResponsesInputItem): boolean {
  return (
    item.type === 'function_call_output' ||
    item.type === 'custom_tool_call_output' ||
    (item.role !== undefined && item.role !== 'assistant')
  );
}

/** The output items a reasoning item is paired with by id: its tool calls and the assistant's message. */
function pairedWithReasoning(item: ResponsesInputItem): boolean {
  return (
    item.type === 'function_call' ||
    item.type === 'custom_tool_call' ||
    (item.type === 'message' && item.role === 'assistant')
  );
}

/**
 * A stand-in for the id of an assistant message whose reasoning can't be replayed: OpenAI refuses the
 * original id without that reasoning, and an output message's `id` is required. Pi itself replays a
 * message it has no id for under a made-up `msg_pi_<n>` id, which OpenAI accepts, so this one is made
 * up the same way: a hash of the original, so the same history always replays as the same bytes and
 * keeps hitting the prompt cache.
 */
function unpairedMessageId(id: string | undefined, position: number): string {
  // FNV-1a over the original id (or the item's position when it had none).
  let hash = 0x811c9dc5;
  for (const char of id ?? `position:${position}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return `msg_cc_${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Drops replayed reasoning items that carry no `encrypted_content`: with `store: false` the provider
 * has nothing to look their ids up in. The output items they were paired with are unpaired too, as Pi
 * itself replays an item it has no reasoning for: OpenAI refuses an item id whose reasoning is missing
 * as much as the reasoning itself. A tool call loses its id (Pi sends a tool call from another model
 * with none, which OpenAI accepts), and the assistant's message gets a made-up one in its place.
 */
function withoutUnreplayableReasoning(input: ResponsesInputItem[]): ResponsesInputItem[] {
  let unpaired = false;
  const kept: ResponsesInputItem[] = [];
  for (const item of input) {
    if (item.type === 'reasoning') {
      if (!item.encrypted_content) {
        unpaired = true;
        continue;
      }
      unpaired = false;
    } else if (endsAssistantOutput(item)) {
      unpaired = false;
    } else if (unpaired && pairedWithReasoning(item)) {
      const { id, ...rest } = item;
      kept.push(item.type === 'message' ? { ...rest, id: unpairedMessageId(id, kept.length) } : rest);
      continue;
    }
    kept.push(item);
  }
  return kept;
}

function withResponsesReasoning(
  body: ProviderRequestBody,
  off: ReadonlySet<string>,
  { requested, summaries }: Required<ProviderDefaultReasoningOptions>,
): void {
  const reasoning = body.reasoning ?? {};
  if (!requested && reasoning.effort !== undefined && off.has(reasoning.effort)) {
    delete reasoning.effort;
  }
  if (summaries === 'refused') {
    // Pi writes `summary: 'auto'` itself alongside a chosen effort; a key that refused them gets none.
    delete reasoning.summary;
  } else if (summaries && reasoning.summary === undefined) {
    reasoning.summary = 'auto';
  }
  if (Object.keys(reasoning).length > 0) {
    body.reasoning = reasoning;
  } else {
    delete body.reasoning;
  }
  const include = body.include ?? [];
  body.include = include.includes(ENCRYPTED_REASONING) ? include : [...include, ENCRYPTED_REASONING];
  if (body.input !== undefined) {
    body.input = withoutUnreplayableReasoning(body.input);
  }
}

type ProviderDefaultReasoningOptions = {
  /** Whether the caller asked for a reasoning level; when it did, the level stands as Pi wrote it. */
  requested: boolean;
  /**
   * Whether the provider streams reasoning summaries on request (OpenAI's own Responses API), or
   * `'refused'` when the key in use was refused them, so none is asked for, even one Pi wrote.
   */
  summaries?: boolean | 'refused';
};

/** The request body Pi wrote, corrected so no reasoning model is ever asked to stop reasoning. */
export function withProviderDefaultReasoning<T extends ProviderRequestBody>(
  model: Model<Api>,
  body: T,
  { requested, summaries = false }: ProviderDefaultReasoningOptions,
): T {
  if (!model.reasoning) {
    return body;
  }
  const off = offValues(model);
  if (model.api === 'openai-responses') {
    withResponsesReasoning(body, off, { requested, summaries });
  } else if (model.api === 'openai-completions' && !requested) {
    withoutCompletionsOff(body, off);
  }
  return body;
}
