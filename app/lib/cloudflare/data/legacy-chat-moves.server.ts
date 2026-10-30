import { createScopedLogger } from 'cloudchef-agent/utils/logger';

/** How many agents one maintenance run starts: the few old chats move within the hour. */
const LEGACY_CHAT_MOVE_SWEEP_LIMIT = 8;

const logger = createScopedLogger('LegacyChatMoves');

/** What the sweep uses: the workspace's D1, and each conversation's agent by name. */
type LegacyChatMovesEnv = {
  DB: D1Database;
  ConversationAgent: { getByName(agentName: string): { moveLegacyChat(): Promise<number> } };
};

/**
 * Starts each conversation's agent that `legacy_chat_moves` still lists, once, so a chat from before pi-durable moves
 * into its transcript without anyone opening it. Reaching an idle agent only starts it; one already running answers
 * as it is. A move is recorded only once the agent answered; a failure is logged and tried at the next run.
 */
export async function sweepLegacyChatMoves(env: LegacyChatMovesEnv): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT moves.agent_name
     FROM legacy_chat_moves AS moves
     JOIN workspaces ON workspaces.id = moves.workspace_id
     WHERE moves.moved_at IS NULL AND workspaces.is_deleted = 0
     ORDER BY moves.attempts, moves.agent_name
     LIMIT ?`,
  )
    .bind(LEGACY_CHAT_MOVE_SWEEP_LIMIT)
    .all<{ agent_name: string }>();
  await Promise.all(pending.results.map(({ agent_name: agentName }) => moveLegacyChat(env, agentName)));
}

export async function sweepLegacyChatMovesBestEffort(env: LegacyChatMovesEnv): Promise<void> {
  try {
    await sweepLegacyChatMoves(env);
  } catch {
    logger.warn('Unable to sweep old chats to move');
  }
}

async function moveLegacyChat(env: LegacyChatMovesEnv, agentName: string): Promise<void> {
  try {
    const movedMessages = await env.ConversationAgent.getByName(agentName).moveLegacyChat();
    await env.DB.prepare(`UPDATE legacy_chat_moves SET moved_messages = ?, moved_at = ? WHERE agent_name = ?`)
      .bind(movedMessages, Date.now(), agentName)
      .run();
  } catch {
    await env.DB.prepare(`UPDATE legacy_chat_moves SET attempts = attempts + 1 WHERE agent_name = ?`)
      .bind(agentName)
      .run()
      .catch(() => undefined);
    logger.warn('Unable to move an old chat', { agentName });
  }
}
