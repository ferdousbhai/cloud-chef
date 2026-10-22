import type { z } from 'zod';
import type { dataOperationArgSchemas } from './data-operation-schemas';
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';

type ChatSummary = {
  initialId: string;
  description?: string;
  timestamp: string;
  subchatIndex: number;
};

export type ChatHistorySummary = {
  id: string;
  initialId: string;
  description?: string;
  timestamp: string;
};

export type SubchatSummary = {
  subchatIndex: number;
  description?: string;
  updatedAt: number;
  transcript: TranscriptIdentity;
};

type DataOperationResults = {
  'messages.get': ChatSummary | null;
  'messages.getAll': ChatHistorySummary[];
  'messages.initializeChat': { created: boolean };
  'messages.openLinkedChat': { initialId: string; created: boolean };
  'messages.startLinkedChat': { initialId: string };
  'messages.linkedChatHistory': { initialId: string; description: string | null; archivedAt: number }[];
  'messages.discardEmptyChat': null;
  'messages.remove': { kind: 'success' };
  'messages.setDescription': null;
  'subchats.create': number;
  'subchats.get': SubchatSummary[];
  'subchats.setDescription': null;
};

export type DataOperationPath = keyof typeof dataOperationArgSchemas;
export type DataOperationArgs<Path extends DataOperationPath> = z.infer<(typeof dataOperationArgSchemas)[Path]>;
export type DataOperationResult<Path extends DataOperationPath> = DataOperationResults[Path];
type DataApiNamespace = Record<string, DataOperationPath>;

export const api = {
  messages: {
    get: 'messages.get',
    getAll: 'messages.getAll',
    initializeChat: 'messages.initializeChat',
    openLinkedChat: 'messages.openLinkedChat',
    startLinkedChat: 'messages.startLinkedChat',
    linkedChatHistory: 'messages.linkedChatHistory',
    discardEmptyChat: 'messages.discardEmptyChat',
    remove: 'messages.remove',
    setDescription: 'messages.setDescription',
  },
  subchats: {
    create: 'subchats.create',
    get: 'subchats.get',
    setDescription: 'subchats.setDescription',
  },
} as const satisfies Record<string, DataApiNamespace>;
