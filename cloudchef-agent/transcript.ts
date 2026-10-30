import { z } from 'zod';

export const TRANSCRIPT_HISTORY_FORMAT_VERSION = 2 as const;

export const transcriptIdentitySchema = z.object({
  agentName: z.string().min(1).max(512),
  conversationIndex: z.number().int().nonnegative(),
});

export const transcriptCheckpointSchema = transcriptIdentitySchema.extend({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  messageCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

export type TranscriptIdentity = z.infer<typeof transcriptIdentitySchema>;
export type TranscriptCheckpoint = z.infer<typeof transcriptCheckpointSchema>;
type TranscriptMessage = { id: string; role: string; parts: unknown[] };

export function transcriptIdentitiesEqual(left: TranscriptIdentity, right: TranscriptIdentity): boolean {
  return left.agentName === right.agentName && left.conversationIndex === right.conversationIndex;
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

/**
 * A transcript's ConversationAgent name: the chat's initial id for its first subchat, and a fixed `-0` suffix for the
 * others, which existing Agents are named by.
 */
export function transcriptAgentName(initialId: string, conversationIndex: number): string {
  return conversationIndex === 0 ? initialId : `${initialId}--transcript-${conversationIndex}-0`;
}

/** The chat a transcript's ConversationAgent belongs to, read back from its name (`transcriptAgentName`). */
export function transcriptChatInitialId(agentName: string): string {
  return agentName.replace(/--transcript-[1-9][0-9]*-0$/, '');
}

async function digestTranscriptMessages(messages: TranscriptMessage[]): Promise<string> {
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

function canonicalTranscriptMessage(message: TranscriptMessage) {
  return {
    id: message.id,
    role: message.role,
    parts: message.parts,
  };
}
