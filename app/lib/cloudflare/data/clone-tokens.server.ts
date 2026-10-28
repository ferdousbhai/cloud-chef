import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';

/**
 * Clone tokens from before Clone used CloudChef's git address (2026-10-28): year-long Artifacts read tokens this
 * runtime handed out and recorded in `clone_tokens`. Nothing makes them any more; each recorded one is revoked and
 * forgotten, a few at a time, until the table is empty and a later release drops it.
 */

/** Tokens one sweep revokes; the rest wait for the next. */
const CLONE_TOKEN_REVOKE_LIMIT = 50;

const logger = createScopedLogger('CloneTokens');

export async function revokeRecordedCloneTokens(
  env: Pick<Env, 'DB' | 'ARTIFACTS'>,
  store: ProjectRepositories = new ProjectRepositories(env.ARTIFACTS),
): Promise<void> {
  const { results } = await env.DB.prepare('SELECT repo, token_id FROM clone_tokens LIMIT ?')
    .bind(CLONE_TOKEN_REVOKE_LIMIT)
    .all<{ repo: string; token_id: string }>();
  for (const token of results) {
    await store.revokeToken(token.repo, token.token_id);
    await env.DB.prepare('DELETE FROM clone_tokens WHERE repo = ? AND token_id = ?')
      .bind(token.repo, token.token_id)
      .run();
  }
}

export async function revokeRecordedCloneTokensBestEffort(
  env: Parameters<typeof revokeRecordedCloneTokens>[0],
): Promise<void> {
  try {
    await revokeRecordedCloneTokens(env);
  } catch {
    logger.warn('Unable to revoke recorded clone tokens');
  }
}
