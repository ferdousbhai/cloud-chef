import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { transcriptAgentName } from 'cloudchef-agent/transcript';
import { EMPTY_WORKSPACE_DISCARD_PREDICATE } from './empty-workspace.server';

export const AGENT_GC_SWEEP_LIMIT = 4;
export const AGENT_GC_RETRY_BASE_MS = 30_000;
export const AGENT_GC_GRACE_PERIOD_MS = 30 * 60 * 1000;
const AGENT_GC_RETRY_MAX_MS = 60 * 60 * 1000;

const logger = createScopedLogger('CloudflareAgentGc');

type AgentGcCandidateRow = {
  workspace_id: string;
  initial_id: string;
  owner_id: string;
  conversation_index: number;
  not_before: number;
  attempts: number;
};

export function prepareAgentGcCandidatesStatement(
  db: D1Database,
  args: { initialId: string; ownerId: string; requireEmpty?: boolean },
): D1PreparedStatement {
  const now = Date.now();
  const notBefore = now + AGENT_GC_GRACE_PERIOD_MS;
  return db
    .prepare(
      `INSERT INTO agent_gc_candidates (
         workspace_id, initial_id, conversation_index, not_before, created_at, attempts
       )
       SELECT workspaces.id, workspaces.initial_id, transcripts.conversation_index, ?, ?, 0
       FROM workspaces
       JOIN conversations AS transcripts ON transcripts.workspace_id = workspaces.id
       WHERE workspaces.creator_id = ? AND workspaces.initial_id = ?
         AND ${args.requireEmpty ? EMPTY_WORKSPACE_DISCARD_PREDICATE : 'workspaces.is_deleted = 0'}
       ON CONFLICT(workspace_id, conversation_index) DO UPDATE SET
         not_before = MIN(agent_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(notBefore, now, args.ownerId, args.initialId);
}

export async function sweepAgentGcCandidates(env: Pick<Env, 'ConversationAgent' | 'DB'>): Promise<void> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `SELECT candidates.workspace_id, candidates.initial_id, workspaces.creator_id AS owner_id,
            candidates.conversation_index, candidates.not_before, candidates.attempts
     FROM agent_gc_candidates AS candidates
     INNER JOIN workspaces ON workspaces.id = candidates.workspace_id
     WHERE candidates.not_before <= ? AND workspaces.is_deleted = 1
     ORDER BY candidates.not_before, candidates.workspace_id, candidates.conversation_index
     LIMIT ?`,
  )
    .bind(now, AGENT_GC_SWEEP_LIMIT)
    .all<AgentGcCandidateRow>();

  await Promise.all(result.results.map((candidate) => destroyCandidateAgent(env, candidate, now)));
}

export async function sweepAgentGcCandidatesBestEffort(env: Pick<Env, 'ConversationAgent' | 'DB'>): Promise<void> {
  try {
    await sweepAgentGcCandidates(env);
  } catch {
    logger.warn('Unable to sweep deferred ConversationAgent state');
  }
}

async function destroyCandidateAgent(
  env: Pick<Env, 'ConversationAgent' | 'DB'>,
  candidate: AgentGcCandidateRow,
  now: number,
): Promise<void> {
  try {
    const name = transcriptAgentName(candidate.initial_id, candidate.conversation_index);
    const agent = env.ConversationAgent.getByName(name);
    // The SDK durably records a condemned marker and alarm before this RPC
    // resolves. Delete the D1 receipt only after that schedule is accepted;
    // the alarm owns the abort-shaped physical teardown and can resume it.
    await agent.scheduleDestroyForGc(candidate.owner_id);
    await deleteCompletedCandidate(env.DB, candidate);
  } catch {
    const retryAt = now + retryDelay(candidate.attempts);
    await env.DB.prepare(
      `UPDATE agent_gc_candidates
       SET attempts = attempts + 1, not_before = ?
       WHERE workspace_id = ? AND conversation_index = ? AND not_before = ?`,
    )
      .bind(retryAt, candidate.workspace_id, candidate.conversation_index, candidate.not_before)
      .run();
    logger.warn('Unable to destroy deferred ConversationAgent', { conversationIndex: candidate.conversation_index });
  }
}

function deleteCompletedCandidate(db: D1Database, candidate: AgentGcCandidateRow): Promise<D1Result> {
  return db
    .prepare(
      `DELETE FROM agent_gc_candidates
       WHERE workspace_id = ? AND conversation_index = ? AND not_before = ?`,
    )
    .bind(candidate.workspace_id, candidate.conversation_index, candidate.not_before)
    .run();
}

/** How long a sweep waits before trying a candidate again after `attempts` failures. */
function retryDelay(attempts: number): number {
  return Math.min(AGENT_GC_RETRY_BASE_MS * 2 ** Math.min(attempts, 7), AGENT_GC_RETRY_MAX_MS);
}
