import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  transcriptIdentitiesEqual,
  type TranscriptIdentity,
} from 'cloudchef-agent/transcript';
import { z } from 'zod';
import type { ConversationAgent } from '~/agents/conversation-agent';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import type { DataOperationPath, DataOperationResult } from './data-api';
import { dataOperationArgSchemas, MAX_CONVERSATION_INDEX } from './data-operation-schemas';
import { findWorkspace, openLinkedWorkspace, requireWorkspace } from './data/workspace-repository.server';
import {
  createConversation,
  discardEmptyWorkspace,
  getWorkspace,
  getConversations,
  initializeWorkspace,
  setDescription,
  setConversationDescription,
} from './data/workspace-service.server';
import { sweepAgentGcCandidatesBestEffort } from './data/agent-gc.server';
import { importProject, projectGitAddress, projectHistory, withRepositoryErrors } from './data/projects.server';
import { ensureDataBindings, internalErrorResponse } from './data/http.server';
import { requireConversation, transcriptIdentity } from './data/conversation-repository.server';
import { retryDurableObjectRpc } from './durable-object-rpc.server';

const dataOperationPathSchema = z.object(dataOperationArgSchemas).keyof();
const dataRequestSchema = z.object({ path: dataOperationPathSchema, args: z.unknown() });
const initialMessagesRequestSchema = z.object({
  workspaceId: z.string().min(1).max(512),
  conversationIndex: z.number().int().nonnegative().max(MAX_CONVERSATION_INDEX).optional(),
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
    args.executionCtx?.waitUntil(sweepAgentGcCandidatesBestEffort(args.env));
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
    const workspace = await findWorkspace(args.env.DB, { id: body.workspaceId, sessionId: args.userId });
    if (!workspace) {
      return Response.json({ status: 'missing' });
    }
    const identity = transcriptIdentity(
      await requireConversation(args.env.DB, {
        workspaceId: workspace.id,
        conversationIndex: body.conversationIndex ?? workspace.last_conversation_index,
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
      initialId: workspace.initial_id,
      description: workspace.description ?? undefined,
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
): ReturnType<ConversationAgent['getTranscriptSnapshot']> {
  return retryDurableObjectRpc(() =>
    env.ConversationAgent.getByName(identity.agentName).getTranscriptSnapshotForOwner(identity, ownerId),
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
      return initializeWorkspace(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.openLinkedChat':
      return openLinkedWorkspace(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.discardEmptyChat':
      return discardEmptyWorkspace(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.get':
      return getWorkspace(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'messages.setDescription':
      return setDescription(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'subchats.get':
      return getConversations(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'subchats.create':
      return createConversationFromAgent(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'subchats.setDescription':
      return setConversationDescription(env.DB, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'projects.history':
      return withRepositoryErrors(projectHistory(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId }));
    case 'projects.gitAddress':
      return projectGitAddress(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId });
    case 'projects.import':
      return withRepositoryErrors(importProject(env, { ...dataOperationArgSchemas[path].parse(rawArgs), sessionId }));
    default:
      path satisfies never;
      throw new Error(`Unsupported data operation: ${path}`);
  }
}

/**
 * Starts the workspace's next conversation, which continues the same project with a fresh context. The one it
 * follows is closed from then on: it stops what it has under way.
 */
async function createConversationFromAgent(
  env: Env,
  args: { sessionId: string; workspaceId: string },
): Promise<number> {
  const workspace = await requireWorkspace(env.DB, { id: args.workspaceId, sessionId: args.sessionId });
  const parent = await requireConversation(env.DB, {
    workspaceId: workspace.id,
    conversationIndex: workspace.last_conversation_index,
  });
  const identity = transcriptIdentity(parent);
  const durable = await getBuilderTranscriptSnapshot(env, identity, args.sessionId);
  if (durable.checkpoint && !transcriptIdentitiesEqual(durable.checkpoint, identity)) {
    throw new Error('Parent transcript identity changed while creating a subchat.');
  }
  const conversationIndex = await createConversation(env.DB, {
    sessionId: args.sessionId,
    workspace,
    parent,
    parentRevision: durable.checkpoint?.revision ?? 0,
  });
  // The earlier conversation is closed now, so it refuses new work whatever happens below; this stops what it
  // has under way, so that nothing but the new conversation changes the project from here.
  try {
    await env.ConversationAgent.getByName(identity.agentName).closeForSuccessor(args.sessionId);
  } catch {
    // The new conversation exists either way, and the earlier one refuses changes from now on.
    console.warn('The earlier conversation did not settle before the new one started');
  }
  return conversationIndex;
}
