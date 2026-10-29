import { z } from 'zod';
import type { CloudChefPart } from './ai-compat.js';

/**
 * `data-handoff`: near the model's context limit, the model wrote a handoff note, and the conversation went on in a
 * fresh context that starts from the system prompt, the note and the person's latest message. The chat shows it where
 * it happened as a closed item the person can open to read the note; everything before it stays in the chat.
 */
export const HANDOFF_PART_TYPE = 'data-handoff';

const handoffDataSchema = z.object({ note: z.string().min(1) });
export type HandoffData = z.infer<typeof handoffDataSchema>;

const handoffPartSchema = z.object({ type: z.literal(HANDOFF_PART_TYPE), data: handoffDataSchema });

/** The part the chat shows a handoff as. */
export function handoffPart(note: string): CloudChefPart {
  return { type: HANDOFF_PART_TYPE, data: { note } };
}

/** The handoff a part records; null for any other part. */
export function handoffPartData(part: CloudChefPart): HandoffData | null {
  return handoffPartSchema.safeParse(part).data?.data ?? null;
}
