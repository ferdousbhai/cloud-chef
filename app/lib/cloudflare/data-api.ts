import type { z } from 'zod';
import type { dataOperationArgSchemas } from './data-operation-schemas';
import type { TranscriptIdentity } from 'cloudchef-agent/transcript';

/** What the chat page reads back about its chat: the title it was given. */
type ChatSummary = {
  description?: string;
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

/** The id CloudChef's git address names a project by: `cloudchef.build/git/<projectId>.git`. */
export type ProjectGitAddress = { projectId: string };

export type ProjectImportResult = {
  /** The imported project: a team project's id in a team, the new chat's initial id otherwise. */
  projectId: string;
  initialId: string;
  /** Workers Builds already deploys this repository from GitHub, so it can switch to building from Artifacts. */
  workersBuildsFromGitHub?: boolean;
};

export type ConversationSummary = {
  conversationIndex: number;
  description?: string;
  updatedAt: number;
  transcript: TranscriptIdentity;
};

type DataOperationResults = {
  'messages.get': ChatSummary | null;
  'messages.initializeChat': { created: boolean };
  'messages.openLinkedChat': { initialId: string; created: boolean };
  'messages.discardEmptyChat': null;
  'messages.setDescription': null;
  'projects.history': ProjectCommit[];
  'projects.gitAddress': ProjectGitAddress;
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
    initializeChat: 'messages.initializeChat',
    openLinkedChat: 'messages.openLinkedChat',
    discardEmptyChat: 'messages.discardEmptyChat',
    setDescription: 'messages.setDescription',
  },
  projects: {
    history: 'projects.history',
    gitAddress: 'projects.gitAddress',
    import: 'projects.import',
  },
  subchats: {
    create: 'subchats.create',
    get: 'subchats.get',
    setDescription: 'subchats.setDescription',
  },
} as const satisfies Record<string, DataApiNamespace>;
