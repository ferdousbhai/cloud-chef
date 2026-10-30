import { transcriptIdentitySchema, type TranscriptIdentity } from 'cloudchef-agent/transcript';
import { MAX_USER_MESSAGE_CHARACTERS } from 'cloudchef-agent/context-limits';
import type { UIMessage } from 'ai';
import {
  builderModelIdSchema,
  builderReasoningLevelSchema,
  type BuilderModelId,
  type BuilderReasoningLevel,
} from '~/lib/workers-ai-model';

export type BuilderTranscriptBinding = {
  agentName: string;
  chatInitialId: string;
  conversationIndex: number;
  parentAgentName: string | null;
};

export function builderTranscriptBindingsEqual(
  left: BuilderTranscriptBinding,
  right: BuilderTranscriptBinding,
): boolean {
  return (
    left.agentName === right.agentName &&
    left.chatInitialId === right.chatInitialId &&
    left.conversationIndex === right.conversationIndex &&
    left.parentAgentName === right.parentAgentName
  );
}

type BuilderTranscriptRow = {
  agent_name: string;
  initial_id: string;
  conversation_index: number;
  parent_agent_name: string | null;
};

/** Resolve the durable Agent name to the active, owner-scoped D1 transcript it represents. */
export async function loadBuilderTranscriptBinding(
  db: D1Database,
  args: { agentName: string; ownerId: string },
): Promise<BuilderTranscriptBinding | null> {
  const row = await db
    .prepare(
      `SELECT transcripts.agent_name,
              workspaces.initial_id,
              transcripts.conversation_index,
              parent.agent_name AS parent_agent_name
       FROM conversations AS transcripts
       INNER JOIN workspaces ON workspaces.id = transcripts.workspace_id
       LEFT JOIN conversations AS parent
         ON parent.workspace_id = transcripts.workspace_id
        AND parent.conversation_index = transcripts.parent_conversation_index
       WHERE transcripts.agent_name = ?
         AND workspaces.creator_id = ?
         AND workspaces.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.agentName, args.ownerId)
    .first<BuilderTranscriptRow>();

  return row
    ? {
        agentName: row.agent_name,
        chatInitialId: row.initial_id,
        conversationIndex: row.conversation_index,
        parentAgentName: row.parent_agent_name ?? null,
      }
    : null;
}

/**
 * The team project a transcript's chat works on (null for a CloudChef app), whether a newer conversation
 * in the chat has closed this one (it stays to read, and only the newest changes the project), and whether
 * the member deleted the chat (its agent lives on for a while, and nothing of it may change the project), and the
 * team project a CloudChef app became when an admin approved it as a draft (it is kept to read from then on).
 */
export async function loadConversationScope(
  db: D1Database,
  args: { agentName: string; ownerId: string },
): Promise<{ orgProjectId: string | null; closed: boolean; deleted: boolean; adoptedBy: string | null }> {
  const row = await db
    .prepare(
      `SELECT workspaces.org_project_id, workspaces.is_deleted, workspaces.adopted_by_org_project_id,
              transcripts.conversation_index < workspaces.last_conversation_index AS closed
       FROM conversations AS transcripts
       INNER JOIN workspaces ON workspaces.id = transcripts.workspace_id
       WHERE transcripts.agent_name = ? AND workspaces.creator_id = ?
       LIMIT 1`,
    )
    .bind(args.agentName, args.ownerId)
    .first<{
      org_project_id: string | null;
      is_deleted: number;
      adopted_by_org_project_id: string | null;
      closed: number;
    }>();
  if (!row || row.is_deleted !== 0) {
    return { orgProjectId: null, closed: false, deleted: row !== null, adoptedBy: null };
  }
  return {
    orgProjectId: row.org_project_id,
    closed: row.closed === 1,
    deleted: false,
    adoptedBy: row.adopted_by_org_project_id,
  };
}

/**
 * Records the project a new chat's workspace made for itself (`created_from = 'chat'`): from then on the workspace is
 * that project's, as one opened from the projects home is. Only a workspace with no project yet.
 */
export async function linkWorkspaceToProject(
  db: D1Database,
  args: { agentName: string; ownerId: string; orgProjectId: string },
): Promise<boolean> {
  const linked = await db
    .prepare(
      `UPDATE workspaces SET org_project_id = ?
       WHERE creator_id = ? AND org_project_id IS NULL
         AND id = (SELECT workspace_id FROM conversations WHERE agent_name = ?)`,
    )
    .bind(args.orgProjectId, args.ownerId, args.agentName)
    .run();
  return linked.meta.changes === 1;
}

/**
 * Records that a CloudChef app's repository became the team project `orgProjectId` (an admin approved it as a
 * draft): the transcript's workspace is kept to read from then on.
 */
export async function recordAppAdoption(
  db: D1Database,
  args: { agentName: string; ownerId: string; orgProjectId: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE workspaces SET adopted_by_org_project_id = ?
       WHERE id = (SELECT workspace_id FROM conversations WHERE agent_name = ?)
         AND creator_id = ? AND org_project_id IS NULL AND adopted_by_org_project_id IS NULL`,
    )
    .bind(args.orgProjectId, args.agentName, args.ownerId)
    .run();
}

/**
 * The chat request fields the builder scope check reads. Every one arrives unvalidated from the client.
 * The chat and subchat the browser also sends are not read: the agent's own D1 binding names them.
 */
type BuilderChatRequestBody = {
  transcript?: unknown;
  modelId?: unknown;
  reasoningLevel?: unknown;
};

type BuilderRequestScope = {
  chatInitialId: string;
  conversationIndex: number;
  transcript: TranscriptIdentity;
  modelId: BuilderModelId;
  /** The reasoning effort the person chose; absent for the provider's default. */
  reasoningLevel?: BuilderReasoningLevel;
};

export function requireBuilderRequestScope(
  body: BuilderChatRequestBody,
  binding: BuilderTranscriptBinding,
): BuilderRequestScope {
  const transcript = requireBuilderTranscriptIdentity(body.transcript, binding);
  const modelId = builderModelIdSchema.safeParse(body.modelId);
  if (!modelId.success) {
    throw new Response('Invalid builder model', { status: 400 });
  }
  const reasoningLevel = builderReasoningLevelSchema.optional().safeParse(body.reasoningLevel ?? undefined);
  if (!reasoningLevel.success) {
    throw new Response('Invalid reasoning effort', { status: 400 });
  }
  return {
    chatInitialId: binding.chatInitialId,
    conversationIndex: binding.conversationIndex,
    transcript,
    modelId: modelId.data,
    reasoningLevel: reasoningLevel.data,
  };
}

export function requireBuilderTranscriptIdentity(
  value: unknown,
  binding: BuilderTranscriptBinding | null,
): TranscriptIdentity {
  const result = transcriptIdentitySchema.safeParse(value);
  if (!result.success) {
    throw new Response('Invalid transcript identity', { status: 400 });
  }
  if (
    !binding ||
    result.data.agentName !== binding.agentName ||
    result.data.conversationIndex !== binding.conversationIndex
  ) {
    throw new Response('Transcript identity does not match this agent', { status: 409 });
  }
  return result.data;
}

/** Keep direct Agent clients from persisting prompt text beyond the product's supported input size. */
export function boundBuilderMessageForPersistence(message: UIMessage): UIMessage {
  if (message.role !== 'user') {
    return message;
  }
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === 'text' && part.text.length > MAX_USER_MESSAGE_CHARACTERS
        ? { ...part, text: part.text.slice(0, MAX_USER_MESSAGE_CHARACTERS) }
        : part,
    ),
  };
}
