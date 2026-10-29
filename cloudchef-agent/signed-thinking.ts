import { z } from 'zod';
import type { CloudChefPart } from './ai-compat.js';

/**
 * Claude's thinking, kept in the transcript so a later request can send it back.
 *
 * Anthropic's Messages API returns each `thinking` block with a `signature`, and a `redacted_thinking`
 * block as opaque `data`. When a conversation continues, the assistant turns must carry those blocks
 * back unchanged, in the order the model wrote them and in the same turn as the `tool_use` blocks they
 * preceded; otherwise the model continues without its reasoning. A signature is valid only for the
 * model that wrote it, so the model is recorded alongside.
 *
 * The transcript stores them on the parts the stream already builds:
 *
 * - a reasoning part's `providerMetadata.anthropic` holds `signature` (a `thinking` block, whose text is
 *   the part's text) or `redactedData` (a `redacted_thinking` block, which has no text to show), and
 *   `providerMetadata.cloudchef` names the model step and the model that wrote it;
 * - a tool part's `callProviderMetadata.cloudchef` names the model step that called it.
 *
 * The step is what lets a replay rebuild each model response as one assistant turn: its thinking, text
 * and every tool call it made together, rather than one turn per tool call.
 */

/** The model a block was written by, as Pi names it: a replay is sent back only to the same model. */
export type ThinkingModel = { provider: string; api: string; model: string };

const stepSchema = z.object({ step: z.string().min(1) });

const reasoningMetadataSchema = z.object({
  providerMetadata: z.object({
    anthropic: z.union([z.object({ signature: z.string().min(1) }), z.object({ redactedData: z.string().min(1) })]),
    cloudchef: stepSchema.extend({ provider: z.string().min(1), api: z.string().min(1), model: z.string().min(1) }),
  }),
});

const toolStepSchema = z.object({ callProviderMetadata: z.object({ cloudchef: stepSchema }) });

/** A reasoning part's metadata for a signed `thinking` block. */
export function signedThinkingMetadata(step: string, model: ThinkingModel, signature: string) {
  return { anthropic: { signature }, cloudchef: { step, ...model } };
}

/** A reasoning part's metadata for a `redacted_thinking` block, whose `data` is opaque. */
export function redactedThinkingMetadata(step: string, model: ThinkingModel, redactedData: string) {
  return { anthropic: { redactedData }, cloudchef: { step, ...model } };
}

/** A tool part's metadata naming the model step that called it. */
export function toolStepMetadata(step: string) {
  return { cloudchef: { step } };
}

export type StoredThinking = {
  step: string;
  model: ThinkingModel;
} & ({ signature: string; redactedData?: undefined } | { redactedData: string; signature?: undefined });

/** The signed or redacted thinking block a reasoning part stores, if it stores one. */
export function storedThinking(part: CloudChefPart): StoredThinking | null {
  if (part.type !== 'reasoning') {
    return null;
  }
  const parsed = reasoningMetadataSchema.safeParse(part);
  if (!parsed.success) {
    return null;
  }
  const { anthropic, cloudchef } = parsed.data.providerMetadata;
  const { step, provider, api, model } = cloudchef;
  return 'signature' in anthropic
    ? { step, model: { provider, api, model }, signature: anthropic.signature }
    : { step, model: { provider, api, model }, redactedData: anthropic.redactedData };
}

/** The model step a reasoning or tool part belongs to, when the stream recorded one. */
export function partStep(part: CloudChefPart): string | null {
  if (part.type === 'reasoning') {
    return storedThinking(part)?.step ?? null;
  }
  return toolStepSchema.safeParse(part).data?.callProviderMetadata.cloudchef.step ?? null;
}

/** A `redacted_thinking` block: kept for the model, never shown, because it has nothing to read. */
export function isRedactedReasoningPart(part: CloudChefPart): boolean {
  if (part.type !== 'reasoning') {
    return false;
  }
  return redactedReasoningSchema.safeParse(part).success;
}

/** Read from the stream's metadata alone, so a redacted part hides from its first chunk. */
const redactedReasoningSchema = z.object({
  providerMetadata: z.object({ anthropic: z.object({ redactedData: z.string() }) }),
});
