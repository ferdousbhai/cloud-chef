import type { WorkspaceRow } from './types';
import { DataNotFoundError } from './errors';

const WORKSPACE_COLUMNS =
  'workspaces.id, workspaces.creator_id, workspaces.initial_id, workspaces.description, workspaces.timestamp, workspaces.last_conversation_index, workspaces.has_messages, workspaces.is_deleted';

/**
 * Create the workspace catalog row and its ConversationAgent transcript identity, or bring back the one a
 * failed first message discarded.
 *
 * The homepage pins its workspace id for the life of the page, so the ordinary "send failed, try again"
 * path re-initializes an id whose row `discardEmptyWorkspace` has already soft-deleted. Without the
 * revive the insert matched nothing, the owner-scoped read below found nothing, and every later
 * send failed with a generic 500 until the page was reloaded.
 */
export async function ensureInitialWorkspace(
  db: D1Database,
  args: { id: string; creatorId: string; initialId: string; orgProjectId?: string },
): Promise<WorkspaceRow & { created: boolean }> {
  const createdAt = Date.now();
  const results = await db.batch([
    // Revive first, so the insert below sees an active row and stays a no-op: a second row for the
    // same initial_id would violate the partial unique index on (creator_id, initial_id), and its
    // transcript would collide on the globally unique agent_name the surviving one still holds.
    // Only a still-empty workspace is eligible; a discarded workspace that ever accepted content is not.
    db
      .prepare(
        `UPDATE workspaces
         SET is_deleted = 0
         WHERE id = (
           SELECT id FROM workspaces
           WHERE creator_id = ? AND initial_id = ? AND is_deleted = 1 AND has_messages = 0
           ORDER BY timestamp DESC, id DESC
           LIMIT 1
         )`,
      )
      .bind(args.creatorId, args.initialId),
    // The discard queued this workspace's ConversationAgent for deletion. A revived workspace has to drop that
    // receipt, or the sweep destroys the Agent it was just given back. An active workspace has a candidate only
    // because it was discarded, so this is scoped to the revival.
    db
      .prepare(
        `DELETE FROM agent_gc_candidates
         WHERE workspace_id IN (
           SELECT id FROM workspaces WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         )`,
      )
      .bind(args.creatorId, args.initialId),
    db
      .prepare(
        `INSERT INTO workspaces (
          id, creator_id, initial_id, description, timestamp, last_conversation_index, has_messages, is_deleted,
          org_project_id
        )
        SELECT ?, ?, ?, NULL, ?, 0, 0, 0, ?
        WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE initial_id = ?)
        ON CONFLICT DO NOTHING`,
      )
      .bind(
        args.id,
        args.creatorId,
        args.initialId,
        new Date().toISOString(),
        args.orgProjectId ?? null,
        args.initialId,
      ),
    db
      .prepare(
        `INSERT INTO conversations (
          workspace_id, conversation_index, agent_name,
          parent_conversation_index, parent_revision, transition_token, created_at, updated_at
        )
        SELECT workspaces.id, 0, workspaces.initial_id, NULL, NULL, ?, ?, ?
        FROM workspaces
        WHERE workspaces.id = ? AND workspaces.creator_id = ? AND workspaces.initial_id = ? AND workspaces.is_deleted = 0
        ON CONFLICT(workspace_id, conversation_index) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), createdAt, createdAt, args.id, args.creatorId, args.initialId),
  ]);

  const workspace = await db
    .prepare(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
       WHERE workspaces.creator_id = ? AND workspaces.initial_id = ? AND workspaces.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.creatorId, args.initialId)
    .first<WorkspaceRow>();
  if (!workspace) {
    throw new DataNotFoundError('Unable to initialize chat');
  }
  // A revived workspace is empty again, so a second failed submission must still be able to discard it.
  return { ...workspace, created: results[0].meta.changes > 0 || results[3].meta.changes > 0 };
}

/**
 * The workspace working on a team project, created the first time it's opened; a new conversation on the project
 * is a conversation of it. The project is set before the workspace is ever opened, because its workspace is seeded the
 * moment its agent starts.
 */
export async function openLinkedWorkspace(
  db: D1Database,
  args: { sessionId: string; id: string; orgProjectId: string },
): Promise<{ initialId: string; created: boolean }> {
  const existing = await findLinkedWorkspace(db, args);
  if (existing) {
    return { initialId: existing, created: false };
  }
  try {
    const workspace = await ensureInitialWorkspace(db, {
      id: crypto.randomUUID(),
      creatorId: args.sessionId,
      initialId: args.id,
      orgProjectId: args.orgProjectId,
    });
    return { initialId: workspace.initial_id, created: workspace.created };
  } catch (error) {
    // Opened in two tabs at once: the other one's workspace won the unique index.
    const raced = error instanceof DataNotFoundError ? await findLinkedWorkspace(db, args) : null;
    if (raced) {
      return { initialId: raced, created: false };
    }
    throw error;
  }
}

async function findLinkedWorkspace(db: D1Database, args: { sessionId: string; orgProjectId: string }) {
  const row = await db
    .prepare(
      `SELECT initial_id FROM workspaces
       WHERE creator_id = ? AND org_project_id = ? AND is_deleted = 0 LIMIT 1`,
    )
    .bind(args.sessionId, args.orgProjectId)
    .first<{ initial_id: string }>();
  return row?.initial_id ?? null;
}

export function findWorkspace(db: D1Database, args: { id: string; sessionId: string }): Promise<WorkspaceRow | null> {
  return db
    .prepare(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces
       WHERE workspaces.creator_id = ? AND workspaces.initial_id = ? AND workspaces.is_deleted = 0
       LIMIT 1`,
    )
    .bind(args.sessionId, args.id)
    .first<WorkspaceRow>();
}

export async function requireWorkspace(db: D1Database, args: { id: string; sessionId: string }): Promise<WorkspaceRow> {
  const workspace = await findWorkspace(db, args);
  if (!workspace) {
    throw new DataNotFoundError('Chat not found');
  }
  return workspace;
}

/** Record only the catalog fact that an Agent accepted content; the Agent owns the checkpoint. */
export async function markWorkspaceStarted(
  db: D1Database,
  args: { sessionId: string; workspaceId: string; agentName: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE workspaces
       SET has_messages = 1
       WHERE creator_id = ? AND initial_id = ? AND is_deleted = 0
         AND EXISTS (
           SELECT 1 FROM conversations
           WHERE conversations.workspace_id = workspaces.id AND conversations.agent_name = ?
         )`,
    )
    .bind(args.sessionId, args.workspaceId, args.agentName)
    .run();
}
