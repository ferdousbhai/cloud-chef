import type { z } from 'zod';
import type { dataOperationArgSchemas } from './data-operation-schemas';
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';

/** What the chat page reads back about its chat: the title it was given. */
type ChatSummary = {
  description?: string;
};

export type ChatHistorySummary = {
  id: string;
  initialId: string;
  description?: string;
  timestamp: string;
  /** The app's production address, once a deployment of it succeeded. */
  productionUrl?: string;
  /** When its latest production publish became a commit (ISO 8601). */
  lastCommitAt?: string;
};

export type SubchatSummary = {
  subchatIndex: number;
  description?: string;
  updatedAt: number;
  transcript: TranscriptIdentity;
};

/** One commit of a project's history, newest first. `revision` is the CloudChef revision it published, if any. */
export type ProjectHistoryEntry = {
  hash: string;
  message: string;
  author: { name: string; email: string };
  /** Unix seconds. */
  committedAt: number;
  revision?: string;
};

/** How to clone a project: anyone with `command` can download its code until `expiresAt` (epoch ms). */
export type ProjectCloneAccess = { remote: string; token: string; expiresAt: number; command: string };

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
  'projects.history': ProjectHistoryEntry[];
  'projects.cloneAccess': ProjectCloneAccess;
  'projects.fork': { initialId: string };
  'projects.import': { projectId: string; initialId: string; workersBuildsFromGitHub?: boolean };
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
  projects: {
    history: 'projects.history',
    cloneAccess: 'projects.cloneAccess',
    fork: 'projects.fork',
    import: 'projects.import',
  },
} as const satisfies Record<string, DataApiNamespace>;
