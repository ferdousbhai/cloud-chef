import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  transcriptIdentitiesEqual,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import { z } from 'zod';
import type { BuilderAgent } from '~/agents/builder-agent';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { DataOperationPath, DataOperationResult } from './data-api';
import { dataOperationArgSchemas, MAX_SUBCHAT_INDEX } from './data-operation-schemas';
import {
  findChat,
  isChatArchived,
  listLinkedChatHistory,
  openLinkedChat,
  requireChat,
  startLinkedChat,
} from './data/chat-repository.server';
import {
  createSubchat,
  discardEmptyChat,
  getAllChats,
  getChat,
  getSubchats,
  initializeChat,
  removeChat,
  setDescription,
  setSubchatDescription,
} from './data/chat-service.server';
import { sweepAgentGcCandidatesBestEffort } from './data/agent-gc.server';
import {
  forkProject,
  importProject,
  projectCloneAccess,
  projectHistory,
  withRepositoryErrors,
} from './data/projects.server';
import { sweepAppResourceGcCandidatesBestEffort } from './data/app-resource-gc.server';
import { ensureDataBindings, internalErrorResponse } from './data/http.server';
import { ChatArchivedError } from './data/errors';
import { requireChatTranscript, transcriptIdentity } from './data/transcript-repository.server';
import { retryDurableObjectRpc } from './durable-object-rpc.server';

const dataOperationPathSchema = z.object(dataOperationArgSchemas).keyof();
const dataRequestSchema = z.object({ path: dataOperationPathSchema, args: z.unknown() });
const initialMessagesRequestSchema = z.object({
  chatId: z.string().min(1).max(512),
  subchatIndex: z.number().int().nonnegative().max(MAX_SUBCHAT_INDEX).optional(),
});
const MAX_DATA_REQUEST_BYTES = 64 * 1024;
const MAX_INITIAL_MESSAGES_REQUEST_BYTES = 8 * 1024;

export async function userRuntimeDataAction(args: {
  request: Request;
  env: Env;
  userId: string;
  executionCtx?: Pick<ExecutionContext, 'waitUntil'>;
}): Promise<Response> {
  try {
    const body = dataRequestSchema.parse(
      await readJsonBodyWithLimit(args.request, MAX_DATA_REQUEST_BYTES, 'Data request'),
    );
    ensureDataBindings(args.env);
    const result = runKnownDataOperation(args.env, body.path, body.args, args.userId, args.executionCtx);
    args.executionCtx?.waitUntil(sweepAgentGcCandidatesBestEffort(args.env));
    args.executionCtx?.waitUntil(sweepAppResourceGcCandidatesBestEffort(args.env));
    return Response.json({ result: await result });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown data error');
  }
}

export async function userRuntimeInitialMessagesAction(args: {
  request: Request;
  env: Env;
  userId: string;
}): Promise<Response> {
  try {
    ensureDataBindings(args.env);
    const body = initialMessagesRequestSchema.parse(
      await readJsonBodyWithLimit(args.request, MAX_INITIAL_MESSAGES_REQUEST_BYTES, 'Initial messages request'),
    );
    const chat = await findChat(args.env.DB, { id: body.chatId, sessionId: args.userId });
    if (!chat) {
      return Response.json({ status: 'missing' });
    }
    const identity = transcriptIdentity(
      await requireChatTranscript(args.env.DB, {
        chatId: chat.id,
        subchatIndex: body.subchatIndex ?? chat.last_subchat_index,
      }),
    );
    const durable = await getBuilderTranscriptSnapshot(args.env, identity, args.userId);
    const checkpoint = durable.checkpoint && durable.checkpoint.revision > 0 ? durable.checkpoint : null;
    if (checkpoint && !transcriptIdentitiesEqual(checkpoint, identity)) {
      return transcriptConflictResponse();
    }
    return Response.json({
      status: 'ready',
      version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
      initialId: chat.initial_id,
      description: chat.description ?? undefined,
      transcript: identity,
      checkpoint,
      messages: checkpoint ? durable.messages : [],
    });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown initial messages error');
  }
}

function transcriptConflictResponse(): Response {
  return Response.json(
    { error: 'The Agent transcript identity no longer matches this catalog entry. Reload the latest transcript.' },
    { status: 409 },
  );
}

function getBuilderTranscriptSnapshot(
  env: Env,
  identity: TranscriptIdentity,
  ownerId: string,
): ReturnType<BuilderAgent['getTranscriptSnapshot']> {
  return retryDurableObjectRpc(() =>
    env.BuilderAgent.getByName(identity.agentName).getTranscriptSnapshotForOwner(identity, ownerId),
  );
}

function runKnownDataOperation(
  env: Env,
  path: DataOperationPath,
  rawArgs: unknown,
  sessionId: string,
  executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<DataOperationResult<DataOperationPath>> {
  // Every operation acts for the signed-in user the runtime session belongs to, never one the request names.
  switch (path) {
    case 'messages.initializeChat':
      return initializeChat(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.openLinkedChat':
      return openLinkedChat(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.startLinkedChat':
      return startLinkedChatAndStopArchived(
        env,
        { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId },
        executionCtx,
      );
    case 'messages.linkedChatHistory':
      return listLinkedChatHistory(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.discardEmptyChat':
      return discardEmptyChat(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.get':
      return getChat(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.getAll':
      return getAllChats(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.setDescription':
      return setDescription(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.remove':
      return removeChat(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'subchats.get':
      return getSubchats(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'subchats.create':
      return createSubchatFromAgent(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'subchats.setDescription':
      return setSubchatDescription(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'projects.history':
      return withRepositoryErrors(projectHistory(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId }));
    case 'projects.cloneAccess':
      return withRepositoryErrors(
        projectCloneAccess(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId }),
      );
    case 'projects.fork':
      return withRepositoryErrors(forkProject(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId }));
    case 'projects.import':
      return withRepositoryErrors(importProject(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId }));
    default:
      path satisfies never;
      throw new Error(`Unsupported data operation: ${path}`);
  }
}

/**
 * Starts a new conversation on a team project and tells the one it archived to stop now, rather than at
 * whatever it does next. The new conversation's agent also waits for that before it copies the workspace,
 * so this is only the early start: the answer doesn't wait for it.
 */
async function startLinkedChatAndStopArchived(
  env: Env,
  args: { sessionId: string; id: string; orgProjectId: string },
  executionCtx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<{ initialId: string }> {
  const { initialId, archivedAgentNames } = await startLinkedChat(env.DB, args);
  const stopping = Promise.all(
    archivedAgentNames.map((agentName) =>
      env.BuilderAgent.getByName(agentName)
        .settleForSuccessor(args.sessionId)
        .catch(() => console.warn('An archived conversation could not be stopped yet; it stops before it is copied')),
    ),
  );
  executionCtx?.waitUntil(stopping);
  return { initialId };
}

async function createSubchatFromAgent(env: Env, args: { sessionId: string; chatId: string }): Promise<number> {
  const chat = await requireChat(env.DB, { id: args.chatId, sessionId: args.sessionId });
  // An earlier conversation on a team project is kept to read: a subchat would work on its old copy.
  if (await isChatArchived(env.DB, { id: args.chatId, sessionId: args.sessionId })) {
    throw new ChatArchivedError();
  }
  const parent = await requireChatTranscript(env.DB, {
    chatId: chat.id,
    subchatIndex: chat.last_subchat_index,
  });
  const identity = transcriptIdentity(parent);
  const durable = await getBuilderTranscriptSnapshot(env, identity, args.sessionId);
  if (durable.checkpoint && !transcriptIdentitiesEqual(durable.checkpoint, identity)) {
    throw new Error('Parent transcript identity changed while creating a subchat.');
  }
  return createSubchat(env.DB, {
    sessionId: args.sessionId,
    chat,
    parent,
    parentRevision: durable.checkpoint?.revision ?? 0,
  });
}
