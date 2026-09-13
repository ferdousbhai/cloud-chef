import type { CloudflareOAuthScopeGrantStatus } from './cloudflare-oauth-scope-manifest';

export type CloudflareConnectionStatus = 'linking' | 'active' | 'revoked' | 'error';

export type CloudflareConnection = {
  id: string;
  userId: string;
  accountId: string;
  accountName: string | null;
  status: CloudflareConnectionStatus;
  credentialHandle: string | null;
  /** Ghostbuild product capabilities (workers, d1, ...), never OAuth scope IDs. */
  grantedCapabilities: string[];
  /** Exact scope IDs the authorization request asked Cloudflare for. */
  requestedOAuthScopes: string[];
  /** Exact provider-confirmed scope IDs. Empty, with status 'unknown', for a legacy grant. */
  grantedOAuthScopes: string[];
  oauthScopeProfileVersion: string | null;
  oauthScopeGrantStatus: CloudflareOAuthScopeGrantStatus;
  aiBillingEnabled: boolean;
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
  user_id: string;
  account_id: string;
  account_name: string | null;
  status: CloudflareConnectionStatus;
  credential_handle: string | null;
  granted_capabilities_json: string;
  requested_oauth_scopes_json: string;
  granted_oauth_scopes_json: string;
  oauth_scope_profile_version: string | null;
  oauth_scope_grant_status: string;
  oauth_grant_updated_at: number | null;
  ai_billing_enabled: number;
  connected_at: number | null;
  updated_at: number;
  connection_generation: number;
};

const CONNECTION_COLUMNS = `id, user_id, account_id, account_name, status, credential_handle,
              granted_capabilities_json, requested_oauth_scopes_json, granted_oauth_scopes_json,
              oauth_scope_profile_version, oauth_scope_grant_status, oauth_grant_updated_at,
              ai_billing_enabled, connected_at, updated_at, connection_generation`;

export async function findCloudflareConnectionForUser(
  db: D1Database,
  userId: string,
): Promise<CloudflareConnection | null> {
  const row = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS}
       FROM cloudflare_connections
       WHERE user_id = ?`,
    )
    .bind(userId)
    .first<CloudflareConnectionRow>();
  return row ? connectionFromRow(row) : null;
}

export async function requireActiveCloudflareConnection(
  db: D1Database,
  connectionId: string,
): Promise<CloudflareConnection> {
  const row = await db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS}
       FROM cloudflare_connections
       WHERE id = ? AND status = 'active'`,
    )
    .bind(connectionId)
    .first<CloudflareConnectionRow>();
  if (!row) {
    throw new Error('An active Cloudflare connection is required.');
  }
  return connectionFromRow(row);
}

export async function activateCloudflareConnection(args: {
  db: D1Database;
  userId: string;
  accountId: string;
  accountName: string | null;
  credentialHandle: string;
  grantedCapabilities: string[];
  requestedOAuthScopes: string[];
  grantedOAuthScopes: string[];
  oauthScopeProfileVersion: string;
  oauthScopeGrantStatus: CloudflareOAuthScopeGrantStatus;
  aiBillingEnabled: boolean;
  expectedGeneration: number | null;
  now?: number;
}): Promise<void> {
  const now = args.now ?? Date.now();
  const connectionId = crypto.randomUUID();
  const capabilitiesJson = JSON.stringify(args.grantedCapabilities);
  const requestedScopesJson = JSON.stringify(args.requestedOAuthScopes);
  const grantedScopesJson = JSON.stringify(args.grantedOAuthScopes);
  const verifyCommitted = () =>
    isExactActivatedCloudflareConnection({
      ...args,
      connectionId,
      capabilitiesJson,
      requestedScopesJson,
      grantedScopesJson,
      now,
    }).catch(() => false);
  let row: CloudflareConnectionRow | null;
  try {
    row =
      args.expectedGeneration === null
        ? await args.db
            .prepare(
              `INSERT INTO cloudflare_connections (
        id, user_id, account_id, account_name, status, credential_handle,
        granted_capabilities_json, requested_oauth_scopes_json, granted_oauth_scopes_json,
        oauth_scope_profile_version, oauth_scope_grant_status, oauth_grant_updated_at,
        ai_billing_enabled, connected_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING
      RETURNING ${CONNECTION_COLUMNS}`,
            )
            .bind(
              connectionId,
              args.userId,
              args.accountId,
              args.accountName,
              args.credentialHandle,
              capabilitiesJson,
              requestedScopesJson,
              grantedScopesJson,
              args.oauthScopeProfileVersion,
              args.oauthScopeGrantStatus,
              now,
              args.aiBillingEnabled ? 1 : 0,
              now,
              now,
              now,
            )
            .first<CloudflareConnectionRow>()
        : await args.db
            .prepare(
              `UPDATE cloudflare_connections
             SET account_id = ?, account_name = ?, status = 'active', credential_handle = ?,
                 granted_capabilities_json = ?, requested_oauth_scopes_json = ?,
                 granted_oauth_scopes_json = ?, oauth_scope_profile_version = ?, oauth_scope_grant_status = ?,
                 oauth_grant_updated_at = ?, ai_billing_enabled = ?, connected_at = ?,
                 connection_generation = connection_generation + 1, updated_at = ?
             WHERE user_id = ? AND connection_generation = ?
             RETURNING ${CONNECTION_COLUMNS}`,
            )
            .bind(
              args.accountId,
              args.accountName,
              args.credentialHandle,
              capabilitiesJson,
              requestedScopesJson,
              grantedScopesJson,
              args.oauthScopeProfileVersion,
              args.oauthScopeGrantStatus,
              now,
              args.aiBillingEnabled ? 1 : 0,
              now,
              now,
              args.userId,
              args.expectedGeneration,
            )
            .first<CloudflareConnectionRow>();
  } catch (error) {
    if (await verifyCommitted()) {
      return;
    }
    throw error;
  }
  if (!row) {
    if (await verifyCommitted()) {
      return;
    }
    throw new CloudflareConnectionChangedError();
  }
}

async function isExactActivatedCloudflareConnection(
  args: Parameters<typeof activateCloudflareConnection>[0] & {
    connectionId: string;
    capabilitiesJson: string;
    requestedScopesJson: string;
    grantedScopesJson: string;
    now: number;
  },
): Promise<boolean> {
  const row = await args.db
    .prepare(
      `SELECT ${CONNECTION_COLUMNS}
       FROM cloudflare_connections
       WHERE user_id = ?`,
    )
    .bind(args.userId)
    .first<CloudflareConnectionRow>();
  const intendedGeneration = args.expectedGeneration === null ? 1 : args.expectedGeneration + 1;
  if (
    !row ||
    (args.expectedGeneration === null && row.id !== args.connectionId) ||
    row.user_id !== args.userId ||
    row.account_id !== args.accountId ||
    row.account_name !== args.accountName ||
    row.status !== 'active' ||
    row.credential_handle !== args.credentialHandle ||
    row.granted_capabilities_json !== args.capabilitiesJson ||
    row.requested_oauth_scopes_json !== args.requestedScopesJson ||
    row.granted_oauth_scopes_json !== args.grantedScopesJson ||
    row.oauth_scope_profile_version !== args.oauthScopeProfileVersion ||
    row.oauth_scope_grant_status !== args.oauthScopeGrantStatus ||
    row.oauth_grant_updated_at !== args.now ||
    row.ai_billing_enabled !== (args.aiBillingEnabled ? 1 : 0) ||
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
    userId: row.user_id,
    accountId: row.account_id,
    accountName: row.account_name,
    status: row.status,
    credentialHandle: row.credential_handle,
    grantedCapabilities: parseStoredStringArray(row.granted_capabilities_json),
    requestedOAuthScopes: parseStoredStringArray(row.requested_oauth_scopes_json),
    grantedOAuthScopes: parseStoredStringArray(row.granted_oauth_scopes_json),
    oauthScopeProfileVersion: row.oauth_scope_profile_version,
    oauthScopeGrantStatus: parseStoredGrantStatus(row.oauth_scope_grant_status),
    aiBillingEnabled: row.ai_billing_enabled === 1,
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

function parseStoredGrantStatus(value: string): CloudflareOAuthScopeGrantStatus {
  if (value !== 'unknown' && value !== 'core' && value !== 'partial' && value !== 'full') {
    throw new Error('Stored Cloudflare OAuth grant status is invalid.');
  }
  return value;
}
