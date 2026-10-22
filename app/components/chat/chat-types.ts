import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';
import type { SubchatSummary } from './subchat-model';

export interface ChatProps {
  initialMessages: CloudChefMessage[];
  initializeChat: () => Promise<{ created: boolean }>;
  discardEmptyChat: () => Promise<void>;
  onBuilderRequestStart: () => void;
  subchats?: SubchatSummary[];
  initialPrompt?: string;
  transcript: TranscriptIdentity;
}
