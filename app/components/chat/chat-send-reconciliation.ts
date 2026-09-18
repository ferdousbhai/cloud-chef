import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import {
  transcriptCheckpointSchema,
  transcriptCheckpointMatchesMessages,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
  transcriptIdentitiesEqual,
} from 'cloudchef-agent/transcript';
import { z } from 'zod';

const transcriptMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(z.object({ type: z.string().min(1) }).loose()),
  })
  .loose();

/** Shape every durable-transcript read returns: the agent's checkpoint plus the messages behind it. */
export const transcriptSnapshotSchema = z.object({
  checkpoint: transcriptCheckpointSchema.nullable(),
  messages: z.array(transcriptMessageSchema),
});

export type AuthoritativeTranscriptSnapshot = {
  checkpoint: TranscriptCheckpoint | null;
  messages: CloudChefMessage[];
};

export async function loadAuthoritativeTranscriptSnapshot(args: {
  read: () => Promise<unknown>;
  expectedIdentity: TranscriptIdentity;
  attempts?: number;
}): Promise<AuthoritativeTranscriptSnapshot> {
  const attempts = args.attempts ?? 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const parsed = transcriptSnapshotSchema.safeParse(await args.read());
    if (!parsed.success) {
      continue;
    }
    const snapshot: AuthoritativeTranscriptSnapshot = parsed.data;
    if (
      (snapshot.checkpoint === null
        ? snapshot.messages.length === 0
        : transcriptIdentitiesEqual(snapshot.checkpoint, args.expectedIdentity)) &&
      (await transcriptCheckpointMatchesMessages(snapshot.checkpoint, snapshot.messages))
    ) {
      return snapshot;
    }
  }
  throw new Error('The agent returned an inconsistent transcript snapshot. Reload and try again.');
}

export async function reconcileMessagesForSend(args: {
  snapshot: AuthoritativeTranscriptSnapshot;
  localMessages: CloudChefMessage[];
}): Promise<CloudChefMessage[]> {
  if (await transcriptCheckpointMatchesMessages(args.snapshot.checkpoint, args.localMessages)) {
    return args.localMessages;
  }
  return args.snapshot.messages;
}
