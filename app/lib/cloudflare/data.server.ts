import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  transcriptIdentitiesEqual,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import { z } from 'zod';
import type { BuilderAgent } from '~/agents/builder-agent';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { MAX_SUBCHAT_INDEX } from './data-pagination';
import type { DataOperationPath, DataOperationResult } from './data-api';
import { dataOperationArgSchemas } from './data-operation-schemas';
import { getSessionId, UnauthorizedError } from './data/auth.server';
import { findChat, requireChat } from './data/chat-repository.server';
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
import { sweepAppResourceGcCandidatesBestEffort } from './data/app-resource-gc.server';
import { ensureDataBindings, internalErrorResponse } from './data/http.server';
import { requireChatTranscript, transcriptIdentity } from './data/transcript-repository.server';
import { retryDurableObjectRpc } from './durable-object-rpc.server';
import type { ChatTranscriptRow } from './data/types';

const dataOperationPathSchema = z.object(dataOperationArgSchemas).keyof();
const dataRequestSchema = z.object({ path: dataOperationPathSchema, args: z.unknown() });
const chatRequestSchema = z.object({
  sessionId: z.string().min(1).max(512),
  chatId: z.string().min(1).max(512),
});
const initialMessagesRequestSchema = chatRequestSchema.extend({
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
    if (getSessionId(body.args) !== args.userId) {
      throw new UnauthorizedError();
    }
    const result = runKnownDataOperation(args.env, body.path, body.args);
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
    if (body.sessionId !== args.userId) {
      throw new UnauthorizedError();
    }
    const chat = await findChat(args.env.DB, { id: body.chatId, sessionId: args.userId });
    if (!chat) {
      return new Response(`Chat not found: ${body.chatId}`, { status: 404 });
    }
    const transcript = await requireChatTranscript(args.env.DB, {
      chatId: chat.id,
      subchatIndex: body.subchatIndex ?? 0,
    });
    const durable = await getBuilderTranscriptSnapshot(args.env, transcriptIdentity(transcript), args.userId);
    if (!durable.checkpoint || durable.checkpoint.revision === 0) {
      return new Response(null, { status: 204, headers: transcriptResponseHeaders(transcript) });
    }
    if (!transcriptIdentitiesEqual(durable.checkpoint, transcriptIdentity(transcript))) {
      return transcriptConflictResponse();
    }
    return Response.json(
      { version: TRANSCRIPT_HISTORY_FORMAT_VERSION, transcript: durable.checkpoint, messages: durable.messages },
      { headers: transcriptResponseHeaders(transcript) },
    );
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

function transcriptResponseHeaders(transcript: ChatTranscriptRow): Headers {
  return new Headers({
    'X-CloudChef-Transcript-Agent': transcript.agent_name,
    'X-CloudChef-Transcript-Generation': transcript.generation.toString(),
    'X-CloudChef-Transcript-Subchat': transcript.subchat_index.toString(),
  });
}

function runKnownDataOperation(
  env: Env,
  path: DataOperationPath,
  rawArgs: unknown,
): Promise<DataOperationResult<DataOperationPath>> {
  switch (path) {
    case 'messages.initializeChat':
      return initializeChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.discardEmptyChat':
      return discardEmptyChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.get':
      return getChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.getAll':
      return getAllChats(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.setDescription':
      return setDescription(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'messages.remove':
      return removeChat(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.get':
      return getSubchats(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.create':
      return createSubchatFromAgent(env, dataOperationArgSchemas[path].parse(rawArgs));
    case 'subchats.setDescription':
      return setSubchatDescription(env.DB, dataOperationArgSchemas[path].parse(rawArgs));
    default:
      path satisfies never;
      throw new Error(`Unsupported data operation: ${path}`);
  }
}

async function createSubchatFromAgent(env: Env, args: { sessionId: string; chatId: string }): Promise<number> {
  const chat = await requireChat(env.DB, { id: args.chatId, sessionId: args.sessionId });
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
    ...args,
    parentRevision: durable.checkpoint?.revision ?? 0,
  });
}
