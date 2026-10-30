import { ensureInitialWorkspace, findWorkspace, requireWorkspace } from './workspace-repository.server';
import type { WorkspaceSummary } from '~/lib/cloudflare/data-api';
import { prepareInsertConversation } from './conversation-repository.server';
import type { WorkspaceRow, ConversationRow } from './types';
import { prepareAgentGcCandidatesStatement } from './agent-gc.server';
import { MAX_CONVERSATION_INDEX } from '~/lib/cloudflare/data-operation-schemas';
import { DataNotFoundError, ConversationLimitError } from './errors';
import { EMPTY_WORKSPACE_DISCARD_PREDICATE } from './empty-workspace.server';
import { prepareAppResourceGcCandidateStatement } from './app-resource-gc.server';

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
    prepareAppResourceGcCandidateStatement(db, {
      ownerId: args.sessionId,
      initialId: args.id,
      requireEmpty: true,
    }),
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

export async function getAllWorkspaces(db: D1Database, args: { sessionId: string }) {
  const { results } = await db
    .prepare(
      `SELECT
         workspaces.initial_id,
         COALESCE(
           NULLIF(TRIM(workspaces.description), ''),
           (
             SELECT NULLIF(TRIM(conversations.description), '')
             FROM conversations
             WHERE conversations.workspace_id = workspaces.id
               AND conversations.description IS NOT NULL
               AND TRIM(conversations.description) <> ''
             ORDER BY conversations.conversation_index ASC
             LIMIT 1
           )
         ) AS description,
         workspaces.timestamp,
         (
           SELECT deployments.production_url FROM deployments
           WHERE deployments.workspace_id = workspaces.id AND deployments.status = 'succeeded'
             AND deployments.production_url IS NOT NULL
           ORDER BY deployments.updated_at DESC LIMIT 1
         ) AS production_url
       FROM workspaces
       WHERE workspaces.creator_id = ? AND workspaces.is_deleted = 0
         AND workspaces.has_messages = 1
         -- A team project's workspace is listed with the team's projects, not as an app of one's own; so is a draft
         -- an admin made one of the team's projects.
         AND workspaces.org_project_id IS NULL AND workspaces.adopted_by_org_project_id IS NULL
       ORDER BY workspaces.timestamp DESC, workspaces.id DESC`,
    )
    .bind(args.sessionId)
    .all<{
      initial_id: string;
      description: string | null;
      timestamp: string;
      production_url: string | null;
    }>();
  return results.map((row) => {
    const summary: WorkspaceSummary = {
      id: row.initial_id,
      initialId: row.initial_id,
      description: row.description ?? undefined,
      timestamp: row.timestamp,
    };
    if (row.production_url?.startsWith('https://')) {
      summary.productionUrl = row.production_url;
    }
    return summary;
  });
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

export async function setHeuristicProjectDescriptionIfMissing(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE workspaces
       SET description = ?, description_source = 'heuristic'
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         -- A team or imported project's workspace goes by the project's name, never its first message's.
         AND org_project_id IS NULL
         AND description_source IS NULL
         AND NULLIF(TRIM(description), '') IS NULL`,
    )
    .bind(args.description, args.sessionId, args.id)
    .run();
  return result.meta.changes > 0;
}

/** Finalize the one automatic project title; later prompts never call this transition. */
export async function setGeneratedProjectDescription(
  db: D1Database,
  args: { sessionId: string; id: string; description: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE workspaces
       SET description = ?, description_source = 'generated'
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         AND org_project_id IS NULL
         AND (
           description_source = 'heuristic'
           OR (description_source IS NULL AND NULLIF(TRIM(description), '') IS NULL)
         )`,
    )
    .bind(args.description, args.sessionId, args.id)
    .run();
  return result.meta.changes > 0;
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
    prepareAppResourceGcCandidateStatement(db, { initialId: args.id, ownerId: args.sessionId }),
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
