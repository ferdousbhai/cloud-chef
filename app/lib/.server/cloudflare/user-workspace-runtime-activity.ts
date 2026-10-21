import { BUILDER_TURN_WALL_CLOCK_MS } from '~/lib/.server/llm/builder-turn-limits';

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

/**
 * How long a claimed or renewed upgrade window holds new work back. The upgrade renews it while it
 * redeploys the Worker, rolls out the container image, and waits for the new runtime to be ready, and
 * releases it when it is; this bounds the wait when an upgrade stops partway and never releases it.
 */
export const RUNTIME_UPGRADE_WINDOW_MS = 5 * 60_000;

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
 * The upgrade asking, named by its Workflow instance: another may not claim, renew or release a window
 * it holds open. Null is a control plane from before holders, whose calls work as they always did, and
 * a window claimed by one has no holder, so any upgrade may renew or release it.
 */
type RuntimeUpgradeWindowHolder = string | null;

/**
 * Claim the upgrade window only if no work is running or just ended, in one statement, so work that
 * records itself as it starts either stops the claim or sees the window it lost to. A window another
 * upgrade holds open is not taken over: the claim is refused, as for a busy workspace, until it is
 * released or lapses. Its own holder's claim of a window still open is renewed whatever is busy, as a
 * hold is: a retried step claims again, perhaps of the Worker it already redeployed, and work that
 * started meanwhile is waiting for exactly this window to close.
 */
export async function claimRuntimeUpgradeWindow(
  db: ActivityDatabase,
  args: { targetVersion: string; now: number; holder?: RuntimeUpgradeWindowHolder },
): Promise<RuntimeUpgradeWindowClaim> {
  const holder = args.holder ?? null;
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
      `INSERT INTO runtime_upgrade_window (id, target_version, expires_at, holder)
       SELECT 1, ?, ?, ?
       WHERE (
         NOT EXISTS (
           SELECT 1 FROM runtime_activity
           WHERE (busy = 1 AND updated_at > ?) OR (busy = 0 AND updated_at > ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM runtime_upgrade_window
           WHERE id = 1 AND expires_at > ? AND ? IS NOT NULL AND holder IS NOT ?
         )
       )
       OR EXISTS (
         SELECT 1 FROM runtime_upgrade_window
         WHERE id = 1 AND expires_at > ? AND ? IS NOT NULL AND holder = ?
       )
       ON CONFLICT(id) DO UPDATE SET
         target_version = excluded.target_version,
         expires_at = excluded.expires_at,
         holder = excluded.holder`,
    )
    .bind(
      args.targetVersion,
      args.now + RUNTIME_UPGRADE_WINDOW_MS,
      holder,
      busySince,
      quietSince,
      args.now,
      holder,
      holder,
      args.now,
      holder,
      holder,
    )
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

type RuntimeUpgradeWindowHold = { held: true } | { held: false; busy: number };

/**
 * Keep the window an upgrade claimed open while it finishes: the container rollout and readiness check
 * that follow the redeploy. A window still open is renewed whatever is busy, since work that starts
 * meanwhile records itself busy and waits for exactly this window to close, but only for its holder:
 * another upgrade's open window is refused like a busy workspace. One that lapsed (a retry's backoff
 * outlasted it) is opened again only while nothing is busy, in one statement like the claim: work that
 * started while no window was open would be cut off by the rollout, so the upgrade waits.
 */
export async function holdRuntimeUpgradeWindow(
  db: ActivityDatabase,
  args: { targetVersion: string; now: number; holder?: RuntimeUpgradeWindowHolder },
): Promise<RuntimeUpgradeWindowHold> {
  const busySince = args.now - RUNTIME_BUSY_LEASE_MS;
  const holder = args.holder ?? null;
  const hold = await db
    .prepare(
      `INSERT INTO runtime_upgrade_window (id, target_version, expires_at, holder)
       SELECT 1, ?, ?, ?
       WHERE EXISTS (
           SELECT 1 FROM runtime_upgrade_window
           WHERE id = 1 AND expires_at > ? AND (? IS NULL OR holder IS NULL OR holder = ?)
         )
          OR (
           NOT EXISTS (SELECT 1 FROM runtime_upgrade_window WHERE id = 1 AND expires_at > ?)
           AND NOT EXISTS (SELECT 1 FROM runtime_activity WHERE busy = 1 AND updated_at > ?)
         )
       ON CONFLICT(id) DO UPDATE SET
         target_version = excluded.target_version,
         expires_at = excluded.expires_at,
         holder = COALESCE(excluded.holder, runtime_upgrade_window.holder)`,
    )
    .bind(
      args.targetVersion,
      args.now + RUNTIME_UPGRADE_WINDOW_MS,
      holder,
      args.now,
      holder,
      holder,
      args.now,
      busySince,
    )
    .run();
  if (hold.meta.changes > 0) {
    return { held: true };
  }
  const active = await db
    .prepare('SELECT COUNT(*) AS busy FROM runtime_activity WHERE busy = 1 AND updated_at > ?')
    .bind(busySince)
    .first<{ busy: number }>();
  return { held: false, busy: active?.busy ?? 0 };
}

/**
 * Close the window once the upgrade to `targetVersion` is serving, so waiting work starts at once. Only
 * its holder closes it: another upgrade's release leaves it open.
 */
export async function releaseRuntimeUpgradeWindow(
  db: ActivityDatabase,
  args: { targetVersion: string; holder?: RuntimeUpgradeWindowHolder },
): Promise<void> {
  const holder = args.holder ?? null;
  await db
    .prepare(
      `DELETE FROM runtime_upgrade_window
       WHERE id = 1 AND target_version = ? AND (? IS NULL OR holder IS NULL OR holder = ?)`,
    )
    .bind(args.targetVersion, holder, holder)
    .run();
}
