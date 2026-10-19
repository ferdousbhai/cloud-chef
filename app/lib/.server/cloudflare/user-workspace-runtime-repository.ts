export type UserWorkspaceRuntime = {
  connectionId: string;
  connectionGeneration: number;
  endpoint: string;
  runtimeVersion: string;
  imageDigest: string | null;
};

type UserWorkspaceRuntimeRow = {
  connection_id: string;
  connection_generation: number;
  endpoint: string;
  runtime_version: string;
  image_digest: string | null;
};

const RUNTIME_COLUMNS = 'connection_id, connection_generation, endpoint, runtime_version, image_digest';

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
      }
    : null;
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
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  await args.db
    .prepare(
      `INSERT INTO user_computer_runtimes (
         user_id, connection_id, connection_generation, worker_name, endpoint,
         runtime_version, image_digest, status, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?)
       ON CONFLICT(user_id, connection_id) DO UPDATE SET
         connection_generation = excluded.connection_generation,
         worker_name = excluded.worker_name,
         endpoint = excluded.endpoint,
         runtime_version = excluded.runtime_version,
         image_digest = excluded.image_digest,
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
      now,
      now,
    )
    .run();
}
