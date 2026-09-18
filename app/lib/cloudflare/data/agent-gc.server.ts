import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { transcriptAgentName } from 'cloudchef-agent/transcript';
import { EMPTY_CHAT_DISCARD_PREDICATE } from './empty-chat.server';

export const AGENT_GC_SWEEP_LIMIT = 4;
export const AGENT_GC_RETRY_BASE_MS = 30_000;
export const AGENT_GC_GRACE_PERIOD_MS = 30 * 60 * 1000;
const AGENT_GC_RETRY_MAX_MS = 60 * 60 * 1000;

const logger = createScopedLogger('CloudflareAgentGc');

type AgentGcCandidateRow = {
  chat_id: string;
  initial_id: string;
  owner_id: string;
  subchat_index: number;
  next_generation: number;
  max_generation: number;
  not_before: number;
  attempts: number;
};

export function prepareAgentGcCandidatesStatement(
  db: D1Database,
  args: { initialId: string; ownerId: string; now?: number; requireEmpty?: boolean },
): D1PreparedStatement {
  const now = args.now ?? Date.now();
  const notBefore = now + AGENT_GC_GRACE_PERIOD_MS;
  return db
    .prepare(
      `INSERT INTO agent_gc_candidates (
         chat_id, initial_id, subchat_index, next_generation, max_generation, not_before, created_at, attempts
       )
       SELECT chats.id, chats.initial_id, transcripts.subchat_index, 0, transcripts.generation, ?, ?, 0
       FROM chats
       JOIN chat_transcripts AS transcripts ON transcripts.chat_id = chats.id
       WHERE chats.creator_id = ? AND chats.initial_id = ?
         AND ${args.requireEmpty ? EMPTY_CHAT_DISCARD_PREDICATE : 'chats.is_deleted = 0'}
       ON CONFLICT(chat_id, subchat_index) DO UPDATE SET
         max_generation = MAX(agent_gc_candidates.max_generation, excluded.max_generation),
         not_before = MIN(agent_gc_candidates.not_before, excluded.not_before)`,
    )
    .bind(notBefore, now, args.ownerId, args.initialId);
}

export async function sweepAgentGcCandidates(
  env: Pick<Env, 'BuilderAgent' | 'DB'>,
  options: { limit?: number; now?: number } = {},
): Promise<void> {
  const limit = Math.max(1, Math.min(options.limit ?? AGENT_GC_SWEEP_LIMIT, AGENT_GC_SWEEP_LIMIT));
  const now = options.now ?? Date.now();
  const result = await env.DB.prepare(
    `SELECT candidates.chat_id, candidates.initial_id, chats.creator_id AS owner_id,
            candidates.subchat_index, candidates.next_generation, candidates.max_generation,
            candidates.not_before, candidates.attempts
     FROM agent_gc_candidates AS candidates
     INNER JOIN chats ON chats.id = candidates.chat_id
     WHERE candidates.not_before <= ?
     ORDER BY candidates.not_before, candidates.chat_id, candidates.subchat_index
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<AgentGcCandidateRow>();

  await Promise.all(result.results.map((candidate) => destroyCandidateGeneration(env, candidate, now)));
}

export async function sweepAgentGcCandidatesBestEffort(env: Pick<Env, 'BuilderAgent' | 'DB'>): Promise<void> {
  try {
    await sweepAgentGcCandidates(env);
  } catch {
    logger.warn('Unable to sweep deferred BuilderAgent state');
  }
}

async function destroyCandidateGeneration(
  env: Pick<Env, 'BuilderAgent' | 'DB'>,
  candidate: AgentGcCandidateRow,
  now: number,
): Promise<void> {
  try {
    const name = transcriptAgentName(candidate.initial_id, candidate.subchat_index, candidate.next_generation);
    const agent = env.BuilderAgent.getByName(name);
    // The SDK durably records a condemned marker and alarm before this RPC
    // resolves. Advance the D1 receipt only after that schedule is accepted;
    // the alarm owns the abort-shaped physical teardown and can resume it.
    await agent.scheduleDestroyForGc(candidate.owner_id);
    await (candidate.next_generation === candidate.max_generation
      ? deleteCompletedCandidate(env.DB, candidate)
      : advanceCompletedCandidate(env.DB, candidate, now));
  } catch {
    const retryAt = now + retryDelay(candidate.attempts);
    await env.DB.prepare(
      `UPDATE agent_gc_candidates
       SET attempts = attempts + 1, not_before = ?
       WHERE chat_id = ? AND subchat_index = ? AND next_generation = ? AND not_before = ?`,
    )
      .bind(retryAt, candidate.chat_id, candidate.subchat_index, candidate.next_generation, candidate.not_before)
      .run();
    logger.warn('Unable to destroy deferred BuilderAgent generation', {
      subchatIndex: candidate.subchat_index,
      generation: candidate.next_generation,
    });
  }
}

function deleteCompletedCandidate(db: D1Database, candidate: AgentGcCandidateRow): Promise<D1Result> {
  return db
    .prepare(
      `DELETE FROM agent_gc_candidates
       WHERE chat_id = ? AND subchat_index = ? AND next_generation = ? AND not_before = ?`,
    )
    .bind(candidate.chat_id, candidate.subchat_index, candidate.next_generation, candidate.not_before)
    .run();
}

function advanceCompletedCandidate(db: D1Database, candidate: AgentGcCandidateRow, now: number): Promise<D1Result> {
  return db
    .prepare(
      `UPDATE agent_gc_candidates
       SET next_generation = next_generation + 1, attempts = 0, not_before = ?
       WHERE chat_id = ? AND subchat_index = ? AND next_generation = ? AND not_before = ?`,
    )
    .bind(now, candidate.chat_id, candidate.subchat_index, candidate.next_generation, candidate.not_before)
    .run();
}

function retryDelay(attempts: number): number {
  return Math.min(AGENT_GC_RETRY_BASE_MS * 2 ** Math.min(attempts, 7), AGENT_GC_RETRY_MAX_MS);
}
