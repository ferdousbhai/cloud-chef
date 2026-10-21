export type UserWorkspaceRuntime = {
  connectionId: string;
  connectionGeneration: number;
  endpoint: string;
  runtimeVersion: string;
  imageDigest: string | null;
  /** The runtime protocol it speaks; null for one provisioned before that was recorded, which speaks 1. */
  protocolVersion: number | null;
  /** When a browser last received a session for it. */
  lastSessionAt: number | null;
};

type UserWorkspaceRuntimeRow = {
  connection_id: string;
  connection_generation: number;
  endpoint: string;
  runtime_version: string;
  image_digest: string | null;
  protocol_version: number | null;
  last_session_at: number | null;
};

const RUNTIME_COLUMNS =
  'connection_id, connection_generation, endpoint, runtime_version, image_digest, protocol_version, last_session_at';
/** A session within this long of the last recorded one is not written again. */
const SESSION_RECORD_INTERVAL_MS = 60_000;

/**
 * The ready runtime locator for a person in one Cloudflare account (their own, or an organization's);
 * provisioning state lives in Cloudflare Workflows.
 */
export async function findUserWorkspaceRuntime(
  db: D1Database,
  userId: string,
  connectionId: string,
): Promise<UserWorkspaceRuntime | null> {
  const row = await db
    .prepare(
      `SELECT ${RUNTIME_COLUMNS} FROM user_computer_runtimes
       WHERE user_id = ? AND connection_id = ? AND status = 'ready'`,
    )
    .bind(userId, connectionId)
    .first<UserWorkspaceRuntimeRow>();
  return row
    ? {
        connectionId: row.connection_id,
        connectionGeneration: row.connection_generation,
        endpoint: row.endpoint,
        runtimeVersion: row.runtime_version,
        imageDigest: row.image_digest,
        protocolVersion: row.protocol_version,
        lastSessionAt: row.last_session_at,
      }
    : null;
}

/**
 * Note that a browser received a session for the runtime: a runtime too old to report its own activity
 * is upgraded only once none was issued for longer than a turn can run.
 */
export async function recordUserWorkspaceRuntimeSession(
  db: D1Database,
  args: { userId: string; connectionId: string; now?: number },
): Promise<void> {
  const now = args.now ?? Date.now();
  await db
    .prepare(
      `UPDATE user_computer_runtimes SET last_session_at = ?
       WHERE user_id = ? AND connection_id = ? AND (last_session_at IS NULL OR last_session_at < ?)`,
    )
    .bind(now, args.userId, args.connectionId, now - SESSION_RECORD_INTERVAL_MS)
    .run();
}

export async function upsertUserWorkspaceRuntime(args: {
  db: D1Database;
  userId: string;
  connectionId: string;
  connectionGeneration: number;
  workerName: string;
  endpoint: string;
  runtimeVersion: string;
  imageDigest: string;
  protocolVersion: number;
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  await args.db
    .prepare(
      `INSERT INTO user_computer_runtimes (
         user_id, connection_id, connection_generation, worker_name, endpoint,
         runtime_version, image_digest, protocol_version, status, last_error, created_at, updated_at,
         last_session_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?)
       ON CONFLICT(user_id, connection_id) DO UPDATE SET
         connection_generation = excluded.connection_generation,
         worker_name = excluded.worker_name,
         endpoint = excluded.endpoint,
         runtime_version = excluded.runtime_version,
         image_digest = excluded.image_digest,
         protocol_version = excluded.protocol_version,
         status = 'ready',
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(
      args.userId,
      args.connectionId,
      args.connectionGeneration,
      args.workerName,
      args.endpoint,
      args.runtimeVersion,
      args.imageDigest,
      args.protocolVersion,
      now,
      now,
      now,
    )
    .run();
}

/** A ready runtime the scheduled sweep may upgrade in the background. */
export type OutdatedUserWorkspaceRuntime = {
  userId: string;
  connectionId: string;
  connectionGeneration: number;
};

/**
 * Ready runtimes from an earlier release that still serve their connection's current generation and
 * speak this release's protocol: a session can be issued for each, and its upgrade can wait for a quiet
 * moment. Ordered most recently used first; when there are more than `limit`, sweep `rotation` reads the
 * page that many pages on, wrapping around, so runtimes whose upgrades are all waiting at the front never
 * keep the sweep from the rest.
 */
export async function listOutdatedUserWorkspaceRuntimes(
  db: D1Database,
  args: { runtimeVersion: string; imageDigest: string; protocolVersion: number; limit: number; rotation: number },
): Promise<OutdatedUserWorkspaceRuntime[]> {
  const outdated = `FROM user_computer_runtimes AS runtimes
       JOIN cloudflare_connections AS connections
         ON connections.id = runtimes.connection_id
        AND connections.status = 'active'
        AND connections.connection_generation = runtimes.connection_generation
       WHERE runtimes.status = 'ready'
         AND (runtimes.runtime_version <> ? OR runtimes.image_digest IS NULL OR runtimes.image_digest <> ?)
         AND COALESCE(runtimes.protocol_version, 1) = ?`;
  const bindings = [args.runtimeVersion, args.imageDigest, args.protocolVersion];
  const page = async (limit: number, offset: number) =>
    (
      await db
        .prepare(
          `SELECT runtimes.user_id, runtimes.connection_id, runtimes.connection_generation
           ${outdated}
           ORDER BY runtimes.last_session_at IS NULL, runtimes.last_session_at DESC, runtimes.user_id, runtimes.connection_id
           LIMIT ? OFFSET ?`,
        )
        .bind(...bindings, limit, offset)
        .all<{ user_id: string; connection_id: string; connection_generation: number }>()
    ).results.map((row) => ({
      userId: row.user_id,
      connectionId: row.connection_id,
      connectionGeneration: row.connection_generation,
    }));
  const total =
    args.rotation > 0
      ? ((
          await db
            .prepare(`SELECT COUNT(*) AS total ${outdated}`)
            .bind(...bindings)
            .first<{ total: number }>()
        )?.total ?? 0)
      : 0;
  const offset = total > args.limit ? (args.rotation * args.limit) % total : 0;
  const rotated = await page(args.limit, offset);
  // Wrapped around: the rest of the page comes from the front, short of where this page began.
  return offset > 0 && rotated.length < args.limit
    ? [...rotated, ...(await page(Math.min(offset, args.limit - rotated.length), 0))]
    : rotated;
}
