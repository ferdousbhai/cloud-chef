import type { Api, Model } from '@earendil-works/pi-ai';

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
 * (their `Off` included, were it ever offered) reaches the provider unchanged.
 *
 * OpenAI Responses requests are sent with `store: false`, so a reasoning item replayed on the next
 * request of a tool turn is valid only with its `encrypted_content`. Pi asks for that content only
 * when a level is set; this asks for it on every reasoning model's request, and, as a safety net,
 * drops a replayed reasoning item that still lacks it (and the item ids paired with it), which the
 * provider would otherwise reject as an item it cannot find. On OpenAI's own models it also asks for
 * reasoning summaries, so a long silent think still streams progress the turn's inactivity watchdog
 * can see; the effort itself is left to the provider.
 */

type RequestBody = Record<string, unknown>;

/** The values that mean "reasoning off" to a model: its own `off` mapping, and the generic `none`. */
function offValues(model: Model<Api>): ReadonlySet<string> {
  const off = model.thinkingLevelMap?.off;
  return new Set(typeof off === 'string' ? [off, 'none'] : ['none']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes `key` from `holder[field]`, and `holder[field]` itself once nothing is left in it. */
function deleteNested(holder: RequestBody, field: string, key: string): void {
  const nested = holder[field];
  if (!isRecord(nested)) {
    return;
  }
  delete nested[key];
  if (Object.keys(nested).length === 0) {
    delete holder[field];
  }
}

function withoutCompletionsOff(body: RequestBody, off: ReadonlySet<string>): void {
  const { reasoning, thinking } = body;
  if (isRecord(reasoning)) {
    if (typeof reasoning.effort === 'string' && off.has(reasoning.effort)) {
      deleteNested(body, 'reasoning', 'effort');
    }
    if (reasoning.enabled === false) {
      deleteNested(body, 'reasoning', 'enabled');
    }
  }
  if (typeof body.reasoning_effort === 'string' && off.has(body.reasoning_effort)) {
    delete body.reasoning_effort;
  }
  if ((isRecord(thinking) && thinking.type === 'disabled') || (typeof thinking === 'string' && off.has(thinking))) {
    delete body.thinking;
  }
  if (body.enable_thinking === false) {
    delete body.enable_thinking;
  }
  for (const field of ['chat_template_kwargs', 'chat_template_args']) {
    const kwargs = body[field];
    if (isRecord(kwargs) && kwargs.enable_thinking === false) {
      deleteNested(body, field, 'enable_thinking');
    }
  }
}

const ENCRYPTED_REASONING = 'reasoning.encrypted_content';

/** Items that end an assistant's run of output items in a Responses `input`. */
function endsAssistantOutput(item: Record<string, unknown>): boolean {
  return (
    item.type === 'function_call_output' ||
    item.type === 'custom_tool_call_output' ||
    (item.role !== undefined && item.role !== 'assistant')
  );
}

/**
 * Drops replayed reasoning items that carry no `encrypted_content`: with `store: false` the provider
 * has nothing to look their ids up in. The tool-call items they were paired with lose their ids too,
 * which is how Pi itself replays a call it has no reasoning for.
 */
function withoutUnreplayableReasoning(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }
  let unpaired = false;
  const kept: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      kept.push(item);
      continue;
    }
    if (item.type === 'reasoning') {
      if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0) {
        unpaired = true;
        continue;
      }
      unpaired = false;
    } else if (endsAssistantOutput(item)) {
      unpaired = false;
    } else if (unpaired && (item.type === 'function_call' || item.type === 'custom_tool_call')) {
      const { id: _id, ...rest } = item;
      kept.push(rest);
      continue;
    }
    kept.push(item);
  }
  return kept;
}

function withResponsesReasoning(
  body: RequestBody,
  off: ReadonlySet<string>,
  requested: boolean,
  summaries: boolean,
): void {
  const reasoning = isRecord(body.reasoning) ? body.reasoning : {};
  if (!requested && typeof reasoning.effort === 'string' && off.has(reasoning.effort)) {
    delete reasoning.effort;
  }
  if (summaries && reasoning.summary === undefined) {
    reasoning.summary = 'auto';
  }
  if (Object.keys(reasoning).length > 0) {
    body.reasoning = reasoning;
  } else {
    delete body.reasoning;
  }
  const include = Array.isArray(body.include) ? body.include : [];
  body.include = include.includes(ENCRYPTED_REASONING) ? include : [...include, ENCRYPTED_REASONING];
  body.input = withoutUnreplayableReasoning(body.input);
}

export type ProviderDefaultReasoningOptions = {
  /** Whether the caller asked for a reasoning level; when it did, the level stands as Pi wrote it. */
  requested: boolean;
  /** Whether the provider streams reasoning summaries on request (OpenAI's own Responses API). */
  summaries?: boolean;
};

/** The request body Pi wrote, corrected so no reasoning model is ever asked to stop reasoning. */
export function withProviderDefaultReasoning<T extends RequestBody>(
  model: Model<Api>,
  body: T,
  { requested, summaries = false }: ProviderDefaultReasoningOptions,
): T {
  if (!model.reasoning) {
    return body;
  }
  const off = offValues(model);
  if (model.api === 'openai-responses') {
    withResponsesReasoning(body, off, requested, summaries);
  } else if (model.api === 'openai-completions' && !requested) {
    withoutCompletionsOff(body, off);
  }
  return body;
}
