import type { z } from 'zod';
import type { dataOperationArgSchemas } from './data-operation-schemas';
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';

/** What the chat page reads back about its chat: the title it was given. */
type ChatSummary = {
  description?: string;
};

export type WorkspaceSummary = {
  id: string;
  initialId: string;
  description?: string;
  timestamp: string;
  /** The live site's address once the project has been published. */
  productionUrl?: string | null;
};

/** One commit of a project's history, newest first. `committedAt` is in unix seconds, as Artifacts gives it. */
export type ProjectCommit = {
  hash: string;
  message: string;
  author: { name: string; email: string };
  committedAt: number;
  /** The CloudChef revision a production publish recorded with this commit. */
  revision?: string;
};

/** A short-lived read token for cloning; `expiresAt` is in milliseconds since the epoch. */
export type ProjectCloneAccess = {
  remote: string;
  token: string;
  expiresAt: number;
  command: string;
};

export type ProjectImportResult = {
  /** The imported project: a team project's id in a team, the new chat's initial id otherwise. */
  projectId: string;
  initialId: string;
  /** Workers Builds already deploys this repository from GitHub, so it can switch to building from Artifacts. */
  workersBuildsFromGitHub?: boolean;
};

export type ConversationSummary = {
  subchatIndex: number;
  description?: string;
  updatedAt: number;
  transcript: TranscriptIdentity;
};

type DataOperationResults = {
  'messages.get': ChatSummary | null;
  'messages.getAll': WorkspaceSummary[];
  'messages.initializeChat': { created: boolean };
  'messages.openLinkedChat': { initialId: string; created: boolean };
  'messages.discardEmptyChat': null;
  'messages.remove': { kind: 'success' };
  'messages.setDescription': null;
  'projects.history': ProjectCommit[];
  'projects.cloneAccess': ProjectCloneAccess;
  'projects.fork': { initialId: string };
  'projects.import': ProjectImportResult;
  'subchats.create': number;
  'subchats.get': ConversationSummary[];
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
    discardEmptyChat: 'messages.discardEmptyChat',
    remove: 'messages.remove',
    setDescription: 'messages.setDescription',
  },
  projects: {
    history: 'projects.history',
    cloneAccess: 'projects.cloneAccess',
    fork: 'projects.fork',
    import: 'projects.import',
  },
  subchats: {
    create: 'subchats.create',
    get: 'subchats.get',
    setDescription: 'subchats.setDescription',
  },
} as const satisfies Record<string, DataApiNamespace>;
