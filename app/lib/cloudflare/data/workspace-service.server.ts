import { ensureInitialWorkspace, findWorkspace, requireWorkspace } from './workspace-repository.server';
import { prepareInsertConversation } from './conversation-repository.server';
import type { WorkspaceRow, ConversationRow } from './types';
import { prepareAgentGcCandidatesStatement } from './agent-gc.server';
import { MAX_CONVERSATION_INDEX } from '~/lib/cloudflare/data-operation-schemas';
import { DataNotFoundError, ConversationLimitError } from './errors';
import { EMPTY_WORKSPACE_DISCARD_PREDICATE } from './empty-workspace.server';

export async function initializeWorkspace(
  db: D1Database,
  args: { sessionId: string; id: string },
): Promise<{ created: boolean }> {
  const workspace = await ensureInitialWorkspace(db, {
    id: crypto.randomUUID(),
    creatorId: args.sessionId,
    initialId: args.id,
  });
  return { created: workspace.created };
}

export async function discardEmptyWorkspace(db: D1Database, args: { sessionId: string; id: string }): Promise<null> {
  await db.batch([
    prepareAgentGcCandidatesStatement(db, { ownerId: args.sessionId, initialId: args.id, requireEmpty: true }),
    db
      .prepare(
        `UPDATE workspaces
         SET is_deleted = 1
         WHERE creator_id = ? AND initial_id = ?
           AND ${EMPTY_WORKSPACE_DISCARD_PREDICATE}`,
      )
      .bind(args.sessionId, args.id),
  ]);
  return null;
}

export async function getWorkspace(db: D1Database, args: { id: string; sessionId: string }) {
  const workspace = await findWorkspace(db, args);
  if (!workspace) {
    return null;
  }
  return { description: workspace.description ?? undefined };
}

export async function setDescription(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<null> {
  const workspace = await requireWorkspace(db, { id: args.id, sessionId: args.sessionId });
  await db
    .prepare(`UPDATE workspaces SET description = ?, description_source = 'user' WHERE id = ?`)
    .bind(args.description, workspace.id)
    .run();
  return null;
}

/** Apply an automatic conversation title unless a manual rename or newer prompt won. */
export async function setGeneratedConversationDescription(
  db: D1Database,
  args: {
    sessionId: string;
    id: string;
    conversationIndex: number;
    description: string;
    promptGeneration: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE conversations
       SET description = ?, description_source = 'generated', description_generation = ?
       WHERE workspace_id = (
         SELECT id FROM workspaces
         WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
       )
         AND conversation_index = ?
         AND description_generation <= ?
         AND (
           description_source IN ('heuristic', 'generated')
           OR (description_source IS NULL AND description IS NULL)
         )`,
    )
    .bind(
      args.description,
      args.promptGeneration,
      args.sessionId,
      args.id,
      args.conversationIndex,
      args.promptGeneration,
    )
    .run();
  return result.meta.changes > 0;
}

export async function setHeuristicConversationDescriptionIfMissing(
  db: D1Database,
  args: { sessionId: string; id: string; conversationIndex: number; description: string; promptGeneration: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE conversations
       SET description = ?, description_source = 'heuristic', description_generation = ?
       WHERE workspace_id = (
         SELECT id FROM workspaces
         WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
       )
         AND conversation_index = ?
         AND description_source IS NULL
         AND description IS NULL`,
    )
    .bind(args.description, args.promptGeneration, args.sessionId, args.id, args.conversationIndex)
    .run();
  return result.meta.changes > 0;
}

export async function setConversationDescription(
  db: D1Database,
  args: { sessionId: string; workspaceId: string; conversationIndex: number; description: string },
): Promise<null> {
  const result = await db
    .prepare(
      `UPDATE conversations
       SET description = ?, description_source = 'user'
       WHERE workspace_id = (
         SELECT id FROM workspaces
         WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
       )
         AND conversation_index = ?`,
    )
    .bind(args.description, args.sessionId, args.workspaceId, args.conversationIndex)
    .run();
  if (result.meta.changes === 0) {
    throw new DataNotFoundError('Chat not found');
  }
  return null;
}

export async function removeWorkspace(db: D1Database, args: { sessionId: string; id: string }) {
  await db.batch([
    prepareAgentGcCandidatesStatement(db, { initialId: args.id, ownerId: args.sessionId }),
    db
      .prepare(
        `UPDATE workspaces
         SET is_deleted = 1
         WHERE initial_id = ? AND creator_id = ? AND is_deleted = 0`,
      )
      .bind(args.id, args.sessionId),
  ]);
  return { kind: 'success' } as const;
}

export async function getConversations(db: D1Database, args: { sessionId: string; workspaceId: string }) {
  const workspace = await requireWorkspace(db, { id: args.workspaceId, sessionId: args.sessionId });
  const { results } = await db
    .prepare(
      `SELECT conversation_index, description, updated_at, agent_name
       FROM conversations
       WHERE workspace_id = ?
       ORDER BY conversation_index ASC`,
    )
    .bind(workspace.id)
    .all<{
      conversation_index: number;
      description: string | null;
      updated_at: number;
      agent_name: string;
    }>();
  return results.map((row) => ({
    conversationIndex: row.conversation_index,
    description: row.description ?? undefined,
    updatedAt: row.updated_at,
    transcript: { agentName: row.agent_name, conversationIndex: row.conversation_index },
  }));
}

/**
 * Adds the workspace's next conversation, continuing `parent`, its latest. The batch commits only while the
 * workspace still ends at that parent, so values read earlier cannot add a second conversation at the same index.
 */
export async function createConversation(
  db: D1Database,
  args: { sessionId: string; workspace: WorkspaceRow; parent: ConversationRow; parentRevision: number },
) {
  const { workspace, parent } = args;
  if (workspace.last_conversation_index >= MAX_CONVERSATION_INDEX) {
    throw new ConversationLimitError();
  }
  const conversationIndex = workspace.last_conversation_index + 1;
  const transitionToken = crypto.randomUUID();
  const results = await db.batch([
    prepareInsertConversation(db, {
      workspaceId: workspace.id,
      initialId: workspace.initial_id,
      conversationIndex,
      parent: { conversationIndex: parent.conversation_index, revision: args.parentRevision },
      ownerId: args.sessionId,
      transitionToken,
    }),
    db
      .prepare(
        `UPDATE workspaces
         SET last_conversation_index = ?
         WHERE id = ? AND last_conversation_index = ? AND EXISTS (
           SELECT 1 FROM conversations
           WHERE workspace_id = ? AND conversation_index = ? AND transition_token = ?
         )`,
      )
      .bind(
        conversationIndex,
        workspace.id,
        workspace.last_conversation_index,
        workspace.id,
        conversationIndex,
        transitionToken,
      ),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new Error('Chat transcript changed while creating a subchat; retry the operation');
  }
  return conversationIndex;
}
