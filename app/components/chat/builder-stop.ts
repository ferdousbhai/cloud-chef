import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { transcriptSnapshotSchema, type AuthoritativeTranscriptSnapshot } from './chat-send-reconciliation';

export async function settleBuilderStop(args: {
  cancel: () => Promise<unknown>;
  reconcileMessages: (messages: CloudChefMessage[]) => void;
  refreshWorkspace: () => Promise<void>;
}): Promise<AuthoritativeTranscriptSnapshot> {
  const parsed = transcriptSnapshotSchema.safeParse(await args.cancel());
  if (!parsed.success) {
    throw new Error('The builder returned an invalid transcript after cancellation. Reload and try again.');
  }
  const result: AuthoritativeTranscriptSnapshot = parsed.data;
  args.reconcileMessages(result.messages);
  await args.refreshWorkspace();
  return result;
}
