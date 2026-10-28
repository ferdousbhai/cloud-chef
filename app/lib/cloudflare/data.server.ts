import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  transcriptAgentName,
  transcriptIdentitiesEqual,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import { z } from 'zod';
import { runtimeConnectionIdentity } from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { syncAccountApps } from '~/lib/.server/cloudflare/linked-project-client';
import type { BuilderAgent } from '~/agents/builder-agent';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { DataOperationPath, DataOperationResult } from './data-api';
import { dataOperationArgSchemas, MAX_SUBCHAT_INDEX } from './data-operation-schemas';
import { findChat, openLinkedChat, requireChat } from './data/chat-repository.server';
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
    const result = runKnownDataOperation(args.env, body.path, body.args, args.userId);
    if (body.path === 'messages.getAll') {
      // CloudChef keeps a record of the person's apps, so they can be public, copied and reached from the command line.
      args.executionCtx?.waitUntil(syncAppsBestEffort(args.env, result));
    }
    args.executionCtx?.waitUntil(sweepAgentGcCandidatesBestEffort(args.env));
    args.executionCtx?.waitUntil(sweepAppResourceGcCandidatesBestEffort(args.env));
    return Response.json({ result: await result });
  } catch (error) {
    return internalErrorResponse(error, 'Unknown data error');
  }
}

/** Tells CloudChef the apps a chat list has, with their live addresses; a failure only waits for the next list. */
async function syncAppsBestEffort(env: Env, listed: Promise<DataOperationResult<DataOperationPath>>): Promise<void> {
  const chats = chatListSchema.safeParse(await listed.catch(() => null));
  const identity = runtimeConnectionIdentity(env);
  if (!chats.success || !identity) {
    return;
  }
  await syncAccountApps(
    env,
    identity,
    chats.data.map((chat) => ({
      id: chat.initialId,
      name: chat.description ?? 'Untitled app',
      siteUrl: chat.productionUrl ?? null,
    })),
  ).catch((error: Error) => console.warn({ event: 'apps_sync_failed', message: error.message }));
}

const chatListSchema = z.array(
  z.object({ initialId: z.string(), description: z.string().optional(), productionUrl: z.string().optional() }),
);

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
        subchatIndex: body.subchatIndex ?? chat.last_conversation_index,
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
): Promise<DataOperationResult<DataOperationPath>> {
  // Every operation acts for the signed-in user the runtime session belongs to, never one the request names.
  switch (path) {
    case 'messages.initializeChat':
      return initializeChat(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.openLinkedChat':
      return openLinkedChat(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
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
 * Starts the chat's next conversation, which continues the same project with a fresh context. The one it
 * follows is closed from then on: it stops, and hands over its publication state to the new one.
 */
async function createSubchatFromAgent(env: Env, args: { sessionId: string; chatId: string }): Promise<number> {
  const chat = await requireChat(env.DB, { id: args.chatId, sessionId: args.sessionId });
  const parent = await requireChatTranscript(env.DB, {
    chatId: chat.id,
    subchatIndex: chat.last_conversation_index,
  });
  const identity = transcriptIdentity(parent);
  const durable = await getBuilderTranscriptSnapshot(env, identity, args.sessionId);
  if (durable.checkpoint && !transcriptIdentitiesEqual(durable.checkpoint, identity)) {
    throw new Error('Parent transcript identity changed while creating a subchat.');
  }
  const subchatIndex = await createSubchat(env.DB, {
    sessionId: args.sessionId,
    chat,
    parent,
    parentRevision: durable.checkpoint?.revision ?? 0,
  });
  // The earlier conversation is closed now, so it refuses new work whatever happens below; this stops what it
  // has under way, so that nothing but the new conversation changes the project from here.
  try {
    const handover = await env.BuilderAgent.getByName(identity.agentName).settleForSuccessor(args.sessionId);
    if (handover) {
      await env.BuilderAgent.getByName(transcriptAgentName(chat.initial_id, subchatIndex)).continuePublication(
        args.sessionId,
        handover,
      );
    }
  } catch {
    // The new conversation exists either way; without the handover, its first turn publishes the project again.
    console.warn('The earlier conversation did not hand the project over; the new one publishes it again');
  }
  return subchatIndex;
}
