type CloudflareConnectionStatus = 'active' | 'revoked';

/**
 * One space's connection to the Cloudflare account it builds in. Its id and generation are the space's own
 * (sessions, workspaces, projects and GitHub installations are keyed by them); its credential and scopes are the
 * account's one authorization (`cloudflare_authorizations`), shared by every space in that account, so one
 * reconnect updates all of them.
 */
export type CloudflareConnection = {
  id: string;
  /** The space (`organizations`) whose connection this is. */
  orgId: string;
  /**
   * The person this space was made for, when it was made for one (their own Cloudflare account, connected by
   * signing in with it): their workspace there keeps the name and secret it had before spaces had people.
   */
  personalUserId: string | null;
  accountId: string;
  accountName: string | null;
  status: CloudflareConnectionStatus;
  /** The account's authorization; null when the account has none, which fails closed. */
  credentialHandle: string | null;
  /** Exact provider-confirmed scope IDs; one missing a core scope asks for reauthorization. */
  grantedOAuthScopes: string[];
  connectedAt: number | null;
  updatedAt: number;
  generation: number;
};

export class CloudflareConnectionChangedError extends Error {
  constructor() {
    super('The Cloudflare connection changed while authorization was completing.');
    this.name = 'CloudflareConnectionChangedError';
  }
}

type CloudflareConnectionRow = {
  id: string;
  org_id: string;
  personal_user_id: string | null;
  account_id: string;
  account_name: string | null;
  status: CloudflareConnectionStatus;
  credential_handle: string | null;
  granted_oauth_scopes_json: string | null;
  connected_at: number | null;
  updated_at: number;
  connection_generation: number;
};

const CONNECTION_SELECT = `SELECT connections.id, connections.org_id, spaces.personal_user_id, connections.account_id,
              connections.account_name, connections.status, authorizations.credential_handle,
              authorizations.granted_oauth_scopes_json, connections.connected_at, connections.updated_at,
              connections.connection_generation
       FROM cloudflare_connections AS connections
       JOIN organizations AS spaces ON spaces.id = connections.org_id
       LEFT JOIN cloudflare_authorizations AS authorizations ON authorizations.account_id = connections.account_id`;

/** The connection of the space `orgId`, whatever its status; null while it has none. */
export async function findCloudflareConnectionForOrganization(
  db: D1Database,
  orgId: string,
): Promise<CloudflareConnection | null> {
  const row = await db
    .prepare(`${CONNECTION_SELECT} WHERE connections.org_id = ?`)
    .bind(orgId)
    .first<CloudflareConnectionRow>();
  return row ? connectionFromRow(row) : null;
}

/** The connection of the space made for `userId` (their own Cloudflare account), whatever its status. */
export async function findCloudflareConnectionForPerson(
  db: D1Database,
  userId: string,
): Promise<CloudflareConnection | null> {
  const row = await db
    .prepare(`${CONNECTION_SELECT} WHERE spaces.personal_user_id = ?`)
    .bind(userId)
    .first<CloudflareConnectionRow>();
  return row ? connectionFromRow(row) : null;
}

/**
 * Whether `userId`'s workspace in `connection`'s account is the one they had when the account was theirs alone:
 * it keeps the name and secret it always had, and its runtime answers as the account's owner, which they remain.
 */
function isFoundersWorkspace(connection: Pick<CloudflareConnection, 'personalUserId'>, userId: string): boolean {
  return connection.personalUserId === userId;
}

/**
 * The connection a workspace's name and secret are bound to beside its person and account, so the workspaces one
 * person has in two spaces of the same Cloudflare account never share either; null for the workspace they had
 * when the account was theirs alone, which keeps the name and secret it always had.
 */
export function workspaceBindingConnectionId(
  connection: Pick<CloudflareConnection, 'id' | 'personalUserId'>,
  userId: string,
): string | null {
  return isFoundersWorkspace(connection, userId) ? null : connection.id;
}

export async function findActiveCloudflareConnection(
  db: D1Database,
  connectionId: string,
): Promise<CloudflareConnection | null> {
  const row = await db
    .prepare(`${CONNECTION_SELECT} WHERE connections.id = ? AND connections.status = 'active'`)
    .bind(connectionId)
    .first<CloudflareConnectionRow>();
  return row ? connectionFromRow(row) : null;
}

export async function requireActiveCloudflareConnection(
  db: D1Database,
  connectionId: string,
): Promise<CloudflareConnection> {
  const connection = await findActiveCloudflareConnection(db, connectionId);
  if (!connection) {
    throw new Error('An active Cloudflare connection is required.');
  }
  return connection;
}

/** The account's one authorization, which every space building in it uses; null when it has none. */
export async function findCloudflareAuthorization(
  db: D1Database,
  accountId: string,
): Promise<{ credentialHandle: string; grantedOAuthScopes: string[] } | null> {
  const row = await db
    .prepare('SELECT credential_handle, granted_oauth_scopes_json FROM cloudflare_authorizations WHERE account_id = ?')
    .bind(accountId)
    .first<{ credential_handle: string; granted_oauth_scopes_json: string }>();
  return row
    ? {
        credentialHandle: row.credential_handle,
        grantedOAuthScopes: parseStoredStringArray(row.granted_oauth_scopes_json),
      }
    : null;
}

/**
 * Whether `userId` runs every space building in `accountId` other than `orgId` (the one they are connecting):
 * each is one they are an active admin of, spaces CloudChef runs there aside. Only then may they bring a space
 * into that account while its authorization, which all of those spaces use, still works. `userId` is null
 * for someone signing in with Cloudflare for the first time, who runs no space yet.
 */
export async function runsEveryOtherSpaceInAccount(
  db: D1Database,
  args: { userId: string | null; orgId: string | null; accountId: string },
): Promise<boolean> {
  const notTheirs = args.orgId ? 'AND connections.org_id IS NOT ?2' : '';
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS others
       FROM cloudflare_connections AS connections
       WHERE connections.account_id = ?1 AND connections.status = 'active' ${notTheirs}
         -- A space CloudChef runs is the host team's to answer for, and that team is counted itself.
         AND NOT EXISTS (
           SELECT 1 FROM organizations AS space
           WHERE space.id = connections.org_id AND space.managed_host_org_id IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM organization_members AS members
           WHERE members.org_id = connections.org_id AND members.user_id = ?3
             AND members.role = 'admin' AND members.paused_at IS NULL
         )`,
    )
    .bind(args.accountId, args.orgId, args.userId)
    .first<{ others: number }>();
  return (row?.others ?? 0) === 0;
}

/**
 * The credential of `accountId`'s authorization once no active space builds in that account any more, for
 * its grant to be revoked with Cloudflare; null while another space still uses it, or when there is none.
 */
export async function unusedCloudflareAuthorization(db: D1Database, accountId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT credential_handle FROM cloudflare_authorizations AS authorizations
       WHERE account_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM cloudflare_connections AS connections
           WHERE connections.account_id = authorizations.account_id AND connections.status = 'active'
         )`,
    )
    .bind(accountId)
    .first<{ credential_handle: string }>();
  return row?.credential_handle ?? null;
}

/** Deletes `accountId`'s authorization once no space, active or not, names that account. */
export function deleteUnusedCloudflareAuthorization(db: D1Database, accountId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM cloudflare_authorizations
       WHERE account_id = ?1 AND NOT EXISTS (SELECT 1 FROM cloudflare_connections WHERE account_id = ?1)`,
    )
    .bind(accountId);
}

/** No authorization names the stored credential whose handle is `handle`, an SQL expression. */
export function credentialUnreferenced(handle: string): string {
  return `NOT EXISTS (SELECT 1 FROM cloudflare_authorizations WHERE credential_handle = ${handle})`;
}

/** No authorization names the stored credential the handle bound as `?1` names. */
export const CREDENTIAL_UNREFERENCED = credentialUnreferenced('?1');

/**
 * Connects the space `orgId` to the account, or reconnects it, with a new authorization: the space advances
 * its own generation (expected to still be `expectedGeneration`, null for a first connection), and the
 * account's authorization, which every space building in that account uses, becomes this one in place of
 * `replacedCredentialHandle`, the one the caller read (null when the account had none). All of it is
 * written together or not at all: when the space or the account's authorization changed in between,
 * nothing is, and `CloudflareConnectionChangedError` says so. Other spaces keep their generation, so their
 * workspaces carry on and use the new authorization from their next call.
 */
export async function activateCloudflareConnection(args: {
  db: D1Database;
  orgId: string;
  accountId: string;
  accountName: string | null;
  credentialHandle: string;
  grantedOAuthScopes: string[];
  expectedGeneration: number | null;
  replacedCredentialHandle: string | null;
}): Promise<void> {
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  const grantedScopesJson = JSON.stringify(args.grantedOAuthScopes);
  const intendedGeneration = args.expectedGeneration === null ? 1 : args.expectedGeneration + 1;
  // The account's authorization first, only while the space is as the caller read it and the account still
  // has the authorization they read (compare-and-set).
  const spaceAsRead =
    args.expectedGeneration === null
      ? `NOT EXISTS (SELECT 1 FROM cloudflare_connections WHERE org_id = ?1)`
      : `EXISTS (SELECT 1 FROM cloudflare_connections WHERE org_id = ?1 AND connection_generation = ?7)`;
  const authorization = args.db
    .prepare(
      `INSERT INTO cloudflare_authorizations (account_id, credential_handle, granted_oauth_scopes_json, created_at, updated_at)
       SELECT ?2, ?5, ?6, ?4, ?4 WHERE ${spaceAsRead}
       ON CONFLICT(account_id) DO UPDATE SET
         credential_handle = excluded.credential_handle,
         granted_oauth_scopes_json = excluded.granted_oauth_scopes_json,
         updated_at = excluded.updated_at
       WHERE cloudflare_authorizations.credential_handle IS ?3`,
    )
    .bind(
      args.orgId,
      args.accountId,
      args.replacedCredentialHandle,
      now,
      args.credentialHandle,
      grantedScopesJson,
      ...(args.expectedGeneration === null ? [] : [args.expectedGeneration]),
    );
  // Then the space, only once the account's authorization is this one: the batch is one transaction.
  const authorized =
    'EXISTS (SELECT 1 FROM cloudflare_authorizations WHERE account_id = ?2 AND credential_handle = ?3)';
  const space =
    args.expectedGeneration === null
      ? args.db
          .prepare(
            `INSERT INTO cloudflare_connections (
               id, org_id, account_id, account_name, status, connected_at, created_at, updated_at
             ) SELECT ?4, ?1, ?2, ?5, 'active', ?6, ?6, ?6 WHERE ${authorized}
             ON CONFLICT(org_id) DO NOTHING`,
          )
          .bind(args.orgId, args.accountId, args.credentialHandle, connectionId, args.accountName, now)
      : args.db
          .prepare(
            `UPDATE cloudflare_connections
             SET account_id = ?2, account_name = ?5, status = 'active', connected_at = ?6,
                 connection_generation = connection_generation + 1, updated_at = ?6
             WHERE org_id = ?1 AND connection_generation = ?4 AND ${authorized}`,
          )
          .bind(args.orgId, args.accountId, args.credentialHandle, args.expectedGeneration, args.accountName, now);
  // Written only when the space's own write above was.
  const written = `EXISTS (
    SELECT 1 FROM cloudflare_connections
    WHERE org_id = ?1 AND account_id = ?2 AND connection_generation = ?3 AND connected_at = ?4
  )`;
  const accountName = args.db
    .prepare(`UPDATE cloudflare_connections SET account_name = ?5 WHERE account_id = ?2 AND ${written}`)
    .bind(args.orgId, args.accountId, intendedGeneration, now, args.accountName);
  const verifyCommitted = () =>
    isExactActivatedCloudflareConnection({ ...args, connectionId, grantedScopesJson, now }).catch(() => false);
  let committed: boolean;
  try {
    const [, result] = await args.db.batch([authorization, space, accountName]);
    committed = result.meta.changes === 1;
  } catch (error) {
    if (await verifyCommitted()) {
      return;
    }
    throw error;
  }
  if (!committed) {
    if (await verifyCommitted()) {
      return;
    }
    throw new CloudflareConnectionChangedError();
  }
}

async function isExactActivatedCloudflareConnection(
  args: Parameters<typeof activateCloudflareConnection>[0] & {
    connectionId: string;
    grantedScopesJson: string;
    now: number;
  },
): Promise<boolean> {
  const row = await args.db
    .prepare(`${CONNECTION_SELECT} WHERE connections.org_id = ?`)
    .bind(args.orgId)
    .first<CloudflareConnectionRow>();
  const intendedGeneration = args.expectedGeneration === null ? 1 : args.expectedGeneration + 1;
  if (
    !row ||
    (args.expectedGeneration === null && row.id !== args.connectionId) ||
    row.account_id !== args.accountId ||
    row.account_name !== args.accountName ||
    row.status !== 'active' ||
    row.credential_handle !== args.credentialHandle ||
    row.granted_oauth_scopes_json !== args.grantedScopesJson ||
    row.connected_at !== args.now ||
    row.updated_at !== args.now ||
    row.connection_generation !== intendedGeneration
  ) {
    return false;
  }
  return true;
}

function connectionFromRow(row: CloudflareConnectionRow): CloudflareConnection {
  return {
    id: row.id,
    orgId: row.org_id,
    personalUserId: row.personal_user_id,
    accountId: row.account_id,
    accountName: row.account_name,
    status: row.status,
    credentialHandle: row.credential_handle,
    grantedOAuthScopes:
      row.granted_oauth_scopes_json === null ? [] : parseStoredStringArray(row.granted_oauth_scopes_json),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    generation: row.connection_generation,
  };
}

function parseStoredStringArray(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Stored Cloudflare connection scopes are invalid.', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string' || scope.length === 0)) {
    throw new Error('Stored Cloudflare connection scopes are invalid.');
  }
  return parsed;
}
