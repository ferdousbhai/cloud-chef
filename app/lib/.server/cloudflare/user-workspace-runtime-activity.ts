import { BUILDER_TURN_WALL_CLOCK_MS } from '~/lib/.server/llm/builder-turn-budget';

/**
 * Whether a workspace runtime is doing work a redeploy would cut off, and the window an upgrade claims
 * when it is not. Both live in the runtime's own D1 (`user-workspace-migrations/0012_runtime_activity.sql`):
 * every BuilderAgent writes its own row, and the control plane asks through the runtime, which is the
 * only place that knows about turns running with no browser open.
 */

/**
 * A busy row a Durable Object never cleared stops counting after this long: longer than a turn can
 * run, so a row is never dropped while its work could still be running.
 */
export const RUNTIME_BUSY_LEASE_MS = BUILDER_TURN_WALL_CLOCK_MS + 30 * 60_000;

/** A busy row is rewritten at least this often while its work continues, so the lease follows it. */
export const RUNTIME_BUSY_RENEWAL_MS = 10 * 60_000;

/**
 * Work that just ended still counts for this long. It covers the hand-off from a turn to the preview
 * and deployment it starts, and someone reading an answer before they reply.
 */
export const RUNTIME_QUIET_PERIOD_MS = 2 * 60_000;

/** How long a claimed upgrade holds new work back on the version it replaces. */
export const RUNTIME_UPGRADE_WINDOW_MS = 2 * 60_000;

type ActivityDatabase = Pick<D1Database, 'prepare'>;

export async function recordRuntimeActivity(
  db: ActivityDatabase,
  args: { agentName: string; busy: boolean; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO runtime_activity (agent_name, busy, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_name) DO UPDATE SET busy = excluded.busy, updated_at = excluded.updated_at`,
    )
    .bind(args.agentName, args.busy ? 1 : 0, args.now)
    .run();
}

type RuntimeUpgradeWindowClaim = { granted: true } | { granted: false; busy: number };

/**
 * Claim the upgrade window only if no work is running or just ended, in one statement, so work that
 * records itself as it starts either stops the claim or sees the window it lost to.
 */
export async function claimRuntimeUpgradeWindow(
  db: ActivityDatabase,
  args: { targetVersion: string; now: number },
): Promise<RuntimeUpgradeWindowClaim> {
  const busySince = args.now - RUNTIME_BUSY_LEASE_MS;
  const quietSince = args.now - RUNTIME_QUIET_PERIOD_MS;
  await db
    .prepare(
      `DELETE FROM runtime_activity
       WHERE (busy = 1 AND updated_at <= ?) OR (busy = 0 AND updated_at <= ?)`,
    )
    .bind(busySince, quietSince)
    .run();
  const claim = await db
    .prepare(
      `INSERT INTO runtime_upgrade_window (id, target_version, expires_at)
       SELECT 1, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM runtime_activity
         WHERE (busy = 1 AND updated_at > ?) OR (busy = 0 AND updated_at > ?)
       )
       ON CONFLICT(id) DO UPDATE SET
         target_version = excluded.target_version,
         expires_at = excluded.expires_at`,
    )
    .bind(args.targetVersion, args.now + RUNTIME_UPGRADE_WINDOW_MS, busySince, quietSince)
    .run();
  if (claim.meta.changes > 0) {
    return { granted: true };
  }
  const active = await db
    .prepare(
      `SELECT COUNT(*) AS busy FROM runtime_activity
       WHERE (busy = 1 AND updated_at > ?) OR (busy = 0 AND updated_at > ?)`,
    )
    .bind(busySince, quietSince)
    .first<{ busy: number }>();
  return { granted: false, busy: active?.busy ?? 0 };
}

/** The upgrade window still open at `now`, if one is. */
export async function readRuntimeUpgradeWindow(
  db: ActivityDatabase,
  now: number,
): Promise<{ targetVersion: string; expiresAt: number } | null> {
  const row = await db
    .prepare('SELECT target_version, expires_at FROM runtime_upgrade_window WHERE id = 1 AND expires_at > ?')
    .bind(now)
    .first<{ target_version: string; expires_at: number }>();
  return row ? { targetVersion: row.target_version, expiresAt: row.expires_at } : null;
}
