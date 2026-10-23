import { createScopedLogger } from 'cloudchef-agent/utils/logger';
import { runtimeConnectionIdentity } from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { openProject, ProjectAccessError } from '~/lib/.server/cloudflare/linked-project-client';
import { ProjectRepositories } from '~/lib/.server/cloudflare/project-repository';

/**
 * Each person's clone token for a repository, kept in this runtime's database so Clone shows the same
 * command for as long as the token lasts (a year): a clone made from it keeps pulling. A team project's
 * token is revoked once the person can no longer see that project.
 */

/** Team projects whose access one sweep checks; the rest wait for the next. */
const CLONE_TOKEN_SWEEP_LIMIT = 20;

const logger = createScopedLogger('CloneTokens');

type CloneTokenRow = { repo: string; token_id: string; secret: string; remote: string; expires_at: number };

/** The person's token for `repo`, while it lasts; a new one once it has expired or there is none. */
export async function cloneToken(
  db: D1Database,
  store: ProjectRepositories,
  args: { repo: string; userId: string; orgProjectId: string | null },
): Promise<{ remote: string; token: string; expiresAt: number }> {
  const kept = await db
    .prepare('SELECT repo, token_id, secret, remote, expires_at FROM clone_tokens WHERE repo = ? AND user_id = ?')
    .bind(args.repo, args.userId)
    .first<CloneTokenRow>();
  if (kept && kept.expires_at > Date.now()) {
    return { remote: kept.remote, token: kept.secret, expiresAt: kept.expires_at };
  }
  const access = await store.readAccess(args.repo);
  const expiresAt = Date.parse(access.expiresAt);
  await db
    .prepare(
      `INSERT INTO clone_tokens (repo, user_id, org_project_id, token_id, secret, remote, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, user_id) DO UPDATE SET org_project_id = excluded.org_project_id,
         token_id = excluded.token_id, secret = excluded.secret, remote = excluded.remote,
         expires_at = excluded.expires_at`,
    )
    .bind(args.repo, args.userId, args.orgProjectId, access.tokenId, access.token, access.remote, expiresAt)
    .run();
  return { remote: access.remote, token: access.token, expiresAt };
}

/** Forgets every token for `repo` as its repository is deleted, which revokes them. */
export async function forgetCloneTokens(db: D1Database, repo: string): Promise<void> {
  await db.prepare('DELETE FROM clone_tokens WHERE repo = ?').bind(repo).run();
}

/**
 * Forgets expired tokens, and revokes the tokens of team projects the control plane says the person can no
 * longer see: removed from the project or the team, or paused. A control plane that can't be reached
 * revokes nothing.
 */
export async function sweepCloneTokens(
  env: Parameters<typeof runtimeConnectionIdentity>[0] &
    Pick<Env, 'DB' | 'ARTIFACTS'> &
    Parameters<typeof openProject>[0],
  store: ProjectRepositories = new ProjectRepositories(env.ARTIFACTS),
): Promise<void> {
  await env.DB.prepare('DELETE FROM clone_tokens WHERE expires_at <= ?').bind(Date.now()).run();
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    return;
  }
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT org_project_id FROM clone_tokens WHERE org_project_id IS NOT NULL
     ORDER BY org_project_id LIMIT ?`,
  )
    .bind(CLONE_TOKEN_SWEEP_LIMIT)
    .all<{ org_project_id: string }>();
  for (const { org_project_id: orgProjectId } of results) {
    try {
      await openProject(env, identity, orgProjectId);
      continue;
    } catch (error) {
      if (!(error instanceof ProjectAccessError)) {
        continue;
      }
    }
    const { results: tokens } = await env.DB.prepare('SELECT repo, token_id FROM clone_tokens WHERE org_project_id = ?')
      .bind(orgProjectId)
      .all<{ repo: string; token_id: string }>();
    for (const token of tokens) {
      await store.revokeToken(token.repo, token.token_id);
      await env.DB.prepare('DELETE FROM clone_tokens WHERE repo = ? AND token_id = ?')
        .bind(token.repo, token.token_id)
        .run();
    }
  }
}

export async function sweepCloneTokensBestEffort(env: Parameters<typeof sweepCloneTokens>[0]): Promise<void> {
  try {
    await sweepCloneTokens(env);
  } catch {
    logger.warn('Unable to sweep clone tokens');
  }
}
