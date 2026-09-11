import type { z } from 'zod';
import type { dataOperationArgSchemas } from './data-operation-schemas';
import type { TranscriptIdentity } from 'ghostbuild-agent/transcript';
import type { ChatHistoryCursor, DataPage, SubchatCursor } from './data-pagination';

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
  'messages.getAll': DataPage<ChatHistorySummary, ChatHistoryCursor>;
  'messages.initializeChat': { created: boolean };
  'messages.discardEmptyChat': null;
  'messages.remove': { kind: 'success' };
  'messages.setDescription': null;
  'subchats.create': number;
  'subchats.get': DataPage<SubchatSummary, SubchatCursor>;
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
