import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';
import type { ConversationSummary } from './subchat-model';

export interface ChatProps {
  initialMessages: CloudChefMessage[];
  initializeWorkspace: () => Promise<{ created: boolean }>;
  discardEmptyWorkspace: () => Promise<void>;
  onBuilderRequestStart: () => void;
  subchats?: ConversationSummary[];
  initialPrompt?: string;
  transcript: TranscriptIdentity;
}
