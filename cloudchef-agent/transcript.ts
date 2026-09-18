import { z } from 'zod';

export const TRANSCRIPT_HISTORY_FORMAT_VERSION = 2 as const;
export const TRANSCRIPT_BASE_METADATA_KEY = 'cloudchefTranscriptBase' as const;
/** New transcripts remain generation zero; nonzero values identify deployed rewind-era objects. */
export const CURRENT_TRANSCRIPT_GENERATION = 0 as const;

export const transcriptIdentitySchema = z.object({
  agentName: z.string().min(1).max(512),
  generation: z.number().int().nonnegative(),
  subchatIndex: z.number().int().nonnegative(),
});

export const transcriptCheckpointSchema = transcriptIdentitySchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  messageCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

export type TranscriptIdentity = z.infer<typeof transcriptIdentitySchema>;
export type TranscriptCheckpoint = z.infer<typeof transcriptCheckpointSchema>;
type TranscriptMessage = { id: string; role: string; parts?: unknown[] };

export function transcriptIdentitiesEqual(left: TranscriptIdentity, right: TranscriptIdentity): boolean {
  return (
    left.agentName === right.agentName &&
    left.generation === right.generation &&
    left.subchatIndex === right.subchatIndex
  );
}

export function transcriptCheckpointsEqual(
  left: TranscriptCheckpoint | null,
  right: TranscriptCheckpoint | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      transcriptIdentitiesEqual(left, right) &&
      left.revision === right.revision &&
      left.digest === right.digest &&
      left.messageCount === right.messageCount)
  );
}

export function transcriptAgentName(initialId: string, subchatIndex: number, generation: number): string {
  if (subchatIndex === 0 && generation === CURRENT_TRANSCRIPT_GENERATION) {
    return initialId;
  }
  return `${initialId}--transcript-${subchatIndex}-${generation}`;
}

export async function digestTranscriptMessages(messages: TranscriptMessage[]): Promise<string> {
  const canonical = messages.map(canonicalTranscriptMessage);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function advanceTranscriptCheckpoint(
  previous: TranscriptCheckpoint | null,
  identity: TranscriptIdentity,
  messages: TranscriptMessage[],
): Promise<TranscriptCheckpoint> {
  const digest = await digestTranscriptMessages(messages);
  const sameIdentity = previous !== null && transcriptIdentitiesEqual(previous, identity);
  if (sameIdentity && previous.digest === digest && previous.messageCount === messages.length) {
    return previous;
  }
  return {
    ...identity,
    digest,
    messageCount: messages.length,
    revision: sameIdentity ? previous.revision + 1 : 1,
  };
}

export async function transcriptCheckpointMatchesMessages(
  checkpoint: TranscriptCheckpoint | null,
  messages: TranscriptMessage[],
): Promise<boolean> {
  if (checkpoint === null) {
    return messages.length === 0;
  }
  return (
    checkpoint.messageCount === messages.length && checkpoint.digest === (await digestTranscriptMessages(messages))
  );
}

export function transcriptMessagesEqual(left: TranscriptMessage, right: TranscriptMessage): boolean {
  return JSON.stringify(canonicalTranscriptMessage(left)) === JSON.stringify(canonicalTranscriptMessage(right));
}

export function stripTranscriptBaseMetadata<T extends { metadata?: unknown }>(message: T): T {
  if (!isRecord(message.metadata) || !Object.hasOwn(message.metadata, TRANSCRIPT_BASE_METADATA_KEY)) {
    return message;
  }
  const { [TRANSCRIPT_BASE_METADATA_KEY]: _checkpoint, ...metadata } = message.metadata;
  return {
    ...message,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function canonicalTranscriptMessage(message: TranscriptMessage) {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
