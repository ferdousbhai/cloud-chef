import { findCloudflareConnectionForUser } from './cloudflare-connection-repository';

/**
 * Bumped whenever a field is added, removed, or reinterpreted, so a file a user
 * kept for years stays readable against the shape it was written in.
 */
export const ACCOUNT_EXPORT_SCHEMA_VERSION = 2;

/**
 * Per-section ceiling on rows. Sign-in sessions and OAuth state are the only
 * records an account accumulates without a natural limit, so each returns its most
 * recent page and reports the untruncated count beside it. Every other section
 * holds at most one row, so a whole export is bounded at 404 records.
 */
export const ACCOUNT_EXPORT_ROW_LIMIT = 200;

const SECTION_NAMES = [
  'account',
  'cloudflareConnection',
  'encryptedCredential',
  'computerRuntimes',
  'organizations',
  'organizationInvites',
  'organizationUsage',
  'authSessions',
  'oauthStates',
] as const;

type SectionName = (typeof SECTION_NAMES)[number];

/**
 * A section that could not be read stays in the document saying so, because a
 * section quietly missing from a file is indistinguishable from a section that was
 * empty. The database's own message can carry statement text, so it goes to the
 * log and this fixed sentence goes to the user.
 */
const SECTION_UNAVAILABLE = 'CloudChef could not read this section, so it is missing from this export.';

const EXPORT_COVERS =
  'Every record the CloudChef control plane — the operator-held database — stores for this account, and nothing else.';

const EXPORT_OMITS = [
  'Chats, transcripts, project files, and deployment records. These live in the connected Cloudflare account, not in the control plane. Download individual project source with Download code in the project header.',
  'Workers and their unpromoted preview versions, production and preview D1 databases, R2 buckets, KV namespaces, Containers, Durable Objects, and Agents that CloudChef deployed, and the logs and traces they produce. These live in the connected Cloudflare account and are readable with that account’s own tools.',
  'Copies held by the browser. No server request can reach them; clear CloudChef site data in every browser and profile you have used.',
  'Encrypted credential material, initialisation vectors, credential handles, and session tokens. These are never exported.',
];

type ExportedAccount = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  cloudflareSubject: string | null;
  googleSubject: string | null;
  /** When CloudChef last proved the email by an emailed link or Google. */
  emailProvenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type ExportedCloudflareConnection = {
  id: string;
  accountId: string;
  accountName: string | null;
  status: string;
  grantedCapabilities: string[];
  grantedOAuthScopes: string[];
  oauthScopeGrantStatus: string;
  aiBillingEnabled: boolean;
  connectedAt: string | null;
  updatedAt: string;
  generation: number;
};

type ExportedEncryptedCredential = {
  keyVersion: number;
  storedAt: string;
  rotatedAt: string | null;
};

type ExportedComputerRuntime = {
  connectionId: string;
  connectionGeneration: number;
  workerName: string;
  endpoint: string;
  runtimeVersion: string;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** An organization this person belongs to. Its Cloudflare connection and credential are its own, not theirs. */
type ExportedMembership = {
  organizationId: string;
  organizationName: string;
  role: string;
  joinedAt: string;
  pausedAt: string | null;
};

/** An invite addressed to this person's email, accepted or not. */
type ExportedInvite = {
  organizationName: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

/** One day's model use in an organization's account, as its admins see it. */
type ExportedUsageDay = {
  organizationId: string;
  day: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
};

type ExportedAuthSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

type ExportedOAuthState = {
  id: string;
  status: string;
  returnTo: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type ExportedSection<T extends object> = ({ status: 'exported' } & T) | { status: 'unavailable'; error: string };

type BoundedList<T extends object> = { total: number; truncated: boolean } & T;

/**
 * The operator's whole record of one account, covering exactly the rows
 * `eraseControlPlaneAccount` deletes. Everything else CloudChef touches lives in
 * the user's own Cloudflare account or in their browser, so this operation
 * deliberately reaches neither.
 */
type ControlPlaneExport = {
  schemaVersion: number;
  exportedAt: string;
  status: 'complete' | 'incomplete';
  unavailableSections: SectionName[];
  rowLimitPerSection: number;
  covers: string;
  omits: string[];
  sections: {
    account: ExportedSection<{ account: ExportedAccount | null }>;
    cloudflareConnection: ExportedSection<{ connection: ExportedCloudflareConnection | null }>;
    encryptedCredential: ExportedSection<{ encryptedCredential: ExportedEncryptedCredential | null }>;
    computerRuntimes: ExportedSection<BoundedList<{ computerRuntimes: ExportedComputerRuntime[] }>>;
    organizations: ExportedSection<BoundedList<{ memberships: ExportedMembership[] }>>;
    organizationInvites: ExportedSection<BoundedList<{ invites: ExportedInvite[] }>>;
    organizationUsage: ExportedSection<BoundedList<{ usage: ExportedUsageDay[] }>>;
    authSessions: ExportedSection<BoundedList<{ sessions: ExportedAuthSession[] }>>;
    oauthStates: ExportedSection<BoundedList<{ states: ExportedOAuthState[] }>>;
  };
};

/**
 * Read every operator-held record for one account. Each section is read on its own
 * so one unreadable table cannot silently shrink the rest: a failed section is
 * named at the top of the document and left in place marked `unavailable`, and the
 * export as a whole reports itself `incomplete`.
 */
export async function exportControlPlaneAccount(args: { env: Env; userId: string }): Promise<ControlPlaneExport> {
  const db = args.env.DB;
  const sections: ControlPlaneExport['sections'] = {
    account: await exportSection('account', () => readAccount(db, args.userId)),
    cloudflareConnection: await exportSection('cloudflareConnection', () => readCloudflareConnection(db, args.userId)),
    encryptedCredential: await exportSection('encryptedCredential', () => readEncryptedCredential(db, args.userId)),
    computerRuntimes: await exportSection('computerRuntimes', () => readComputerRuntimes(db, args.userId)),
    organizations: await exportSection('organizations', () => readMemberships(db, args.userId)),
    organizationInvites: await exportSection('organizationInvites', () => readInvites(db, args.userId)),
    organizationUsage: await exportSection('organizationUsage', () => readUsage(db, args.userId)),
    authSessions: await exportSection('authSessions', () => readAuthSessions(db, args.userId)),
    oauthStates: await exportSection('oauthStates', () => readOAuthStates(db, args.userId)),
  };
  const unavailableSections = SECTION_NAMES.filter((name) => sections[name].status === 'unavailable');

  return {
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    status: unavailableSections.length === 0 ? 'complete' : 'incomplete',
    unavailableSections,
    rowLimitPerSection: ACCOUNT_EXPORT_ROW_LIMIT,
    covers: EXPORT_COVERS,
    omits: EXPORT_OMITS,
    sections,
  };
}

async function exportSection<T extends object>(
  section: SectionName,
  read: () => Promise<T>,
): Promise<ExportedSection<T>> {
  try {
    return { status: 'exported', ...(await read()) };
  } catch (error) {
    console.warn(
      `Unable to read the ${section} section during account export`,
      error instanceof Error ? error.message : String(error),
    );
    return { status: 'unavailable', error: SECTION_UNAVAILABLE };
  }
}

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: number;
  image: string | null;
  cloudflare_subject: string | null;
  google_subject: string | null;
  email_proven_at: number | null;
  createdAt: number;
  updatedAt: number;
};

async function readAccount(db: D1Database, userId: string): Promise<{ account: ExportedAccount | null }> {
  const row = await db
    .prepare(
      `SELECT id, name, email, emailVerified, image, cloudflare_subject, google_subject, email_proven_at,
              createdAt, updatedAt
       FROM "user" WHERE id = ?`,
    )
    .bind(userId)
    .first<UserRow>();
  return {
    account: row && {
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerified: row.emailVerified === 1,
      image: row.image,
      cloudflareSubject: row.cloudflare_subject,
      googleSubject: row.google_subject,
      emailProvenAt: optionalIsoTimestamp(row.email_proven_at),
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
    },
  };
}

async function readCloudflareConnection(
  db: D1Database,
  userId: string,
): Promise<{ connection: ExportedCloudflareConnection | null }> {
  const connection = await findCloudflareConnectionForUser(db, userId);
  return {
    // The credential handle resolves the stored ciphertext, so it is dropped here
    // rather than carried into a file the user keeps and forwards.
    connection: connection && {
      id: connection.id,
      accountId: connection.accountId,
      accountName: connection.accountName,
      status: connection.status,
      grantedCapabilities: connection.grantedCapabilities,
      grantedOAuthScopes: connection.grantedOAuthScopes,
      oauthScopeGrantStatus: connection.oauthScopeGrantStatus,
      aiBillingEnabled: connection.aiBillingEnabled,
      connectedAt: optionalIsoTimestamp(connection.connectedAt),
      updatedAt: isoTimestamp(connection.updatedAt),
      generation: connection.generation,
    },
  };
}

type CredentialMetadataRow = { key_version: number; created_at: number; rotated_at: number | null };

async function readEncryptedCredential(
  db: D1Database,
  userId: string,
): Promise<{ encryptedCredential: ExportedEncryptedCredential | null }> {
  const row = await db
    .prepare(
      `SELECT credentials.key_version, credentials.created_at, credentials.rotated_at
       FROM cloudflare_connections AS connections
       JOIN cloudflare_credentials AS credentials ON credentials.handle = connections.credential_handle
       WHERE connections.user_id = ?`,
    )
    .bind(userId)
    .first<CredentialMetadataRow>();
  return {
    // That a credential record exists, when it was stored, and which key version
    // wraps it are portable facts. The ciphertext and its IV are not, at any size.
    encryptedCredential: row && {
      keyVersion: row.key_version,
      storedAt: isoTimestamp(row.created_at),
      rotatedAt: optionalIsoTimestamp(row.rotated_at),
    },
  };
}

type ComputerRuntimeRow = {
  connection_id: string;
  connection_generation: number;
  worker_name: string;
  endpoint: string;
  runtime_version: string;
  status: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

/** One workspace runtime per Cloudflare account the person builds in: their own, and each organization's. */
async function readComputerRuntimes(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ computerRuntimes: ExportedComputerRuntime[] }>> {
  const rows = await db
    .prepare(
      `SELECT connection_id, connection_generation, worker_name, endpoint, runtime_version,
              status, last_error, created_at, updated_at, COUNT(*) OVER () AS total_rows
       FROM user_computer_runtimes WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, ACCOUNT_EXPORT_ROW_LIMIT)
    .all<ComputerRuntimeRow & { total_rows: number }>();
  const computerRuntimes = rows.results.map((row) => ({
    connectionId: row.connection_id,
    connectionGeneration: row.connection_generation,
    workerName: row.worker_name,
    endpoint: row.endpoint,
    runtimeVersion: row.runtime_version,
    status: row.status,
    lastError: row.last_error,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  }));
  return { computerRuntimes, ...boundsOf(rows.results, computerRuntimes.length) };
}

async function readMemberships(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ memberships: ExportedMembership[] }>> {
  const rows = await db
    .prepare(
      `SELECT members.org_id, organizations.name, members.role, members.joined_at, members.paused_at,
              COUNT(*) OVER () AS total_rows
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       WHERE members.user_id = ?
       ORDER BY members.joined_at LIMIT ?`,
    )
    .bind(userId, ACCOUNT_EXPORT_ROW_LIMIT)
    .all<{
      org_id: string;
      name: string;
      role: string;
      joined_at: number;
      paused_at: number | null;
      total_rows: number;
    }>();
  const memberships = rows.results.map((row) => ({
    organizationId: row.org_id,
    organizationName: row.name,
    role: row.role,
    joinedAt: isoTimestamp(row.joined_at),
    pausedAt: optionalIsoTimestamp(row.paused_at),
  }));
  return { memberships, ...boundsOf(rows.results, memberships.length) };
}

type AuthSessionRow = {
  id: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  total_rows: number;
};

async function readAuthSessions(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ sessions: ExportedAuthSession[] }>> {
  const rows = await db
    .prepare(
      `SELECT id, created_at, updated_at, expires_at, COUNT(*) OVER () AS total_rows
       FROM cloudflare_auth_sessions WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(userId, ACCOUNT_EXPORT_ROW_LIMIT)
    .all<AuthSessionRow>();
  // The token hash authenticates a live session, so only the record of the
  // session's existence and lifetime is exported.
  const sessions = rows.results.map((row) => ({
    id: row.id,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    expiresAt: isoTimestamp(row.expires_at),
  }));
  return { sessions, ...boundsOf(rows.results, sessions.length) };
}

type OAuthStateRow = {
  id: string;
  status: string;
  return_to: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
  total_rows: number;
};

async function readOAuthStates(db: D1Database, userId: string): Promise<BoundedList<{ states: ExportedOAuthState[] }>> {
  const rows = await db
    .prepare(
      `SELECT id, status, return_to, expires_at, created_at, updated_at, COUNT(*) OVER () AS total_rows
       FROM cloudflare_oauth_states WHERE authenticated_user_id = ?1 OR linking_user_id = ?1
       ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(userId, ACCOUNT_EXPORT_ROW_LIMIT)
    .all<OAuthStateRow>();
  // The provider session identifier is the handle Cloudflare's authorization flow
  // is resumed with, so only the local record of the attempt is exported.
  const states = rows.results.map((row) => ({
    id: row.id,
    status: row.status,
    returnTo: row.return_to,
    expiresAt: isoTimestamp(row.expires_at),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  }));
  return { states, ...boundsOf(rows.results, states.length) };
}

async function readInvites(db: D1Database, userId: string): Promise<BoundedList<{ invites: ExportedInvite[] }>> {
  const rows = await db
    .prepare(
      `SELECT organizations.name, invites.role, invites.created_at, invites.expires_at, invites.accepted_at,
              COUNT(*) OVER () AS total_rows
       FROM organization_invites AS invites
       JOIN organizations ON organizations.id = invites.org_id
       -- Only to an email CloudChef proved: one a Cloudflare login merely reports says nothing about
       -- who holds it, and the invites to it aren't this person's to see.
       WHERE invites.email = (SELECT email FROM "user" WHERE id = ? AND email_proven_at IS NOT NULL) COLLATE NOCASE
       ORDER BY invites.created_at DESC LIMIT ?`,
    )
    .bind(userId, ACCOUNT_EXPORT_ROW_LIMIT)
    .all<{
      name: string;
      role: string;
      created_at: number;
      expires_at: number;
      accepted_at: number | null;
      total_rows: number;
    }>();
  // The invite token's hash authenticates acceptance, so only the record of the invite is exported.
  const invites = rows.results.map((row) => ({
    organizationName: row.name,
    role: row.role,
    createdAt: isoTimestamp(row.created_at),
    expiresAt: isoTimestamp(row.expires_at),
    acceptedAt: optionalIsoTimestamp(row.accepted_at),
  }));
  return { invites, ...boundsOf(rows.results, invites.length) };
}

async function readUsage(db: D1Database, userId: string): Promise<BoundedList<{ usage: ExportedUsageDay[] }>> {
  const rows = await db
    .prepare(
      `SELECT org_id, day, turns, input_tokens, output_tokens, cached_tokens, COUNT(*) OVER () AS total_rows
       FROM organization_usage_daily WHERE user_id = ?
       ORDER BY day DESC LIMIT ?`,
    )
    .bind(userId, ACCOUNT_EXPORT_ROW_LIMIT)
    .all<{
      org_id: string;
      day: string;
      turns: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      total_rows: number;
    }>();
  const usage = rows.results.map((row) => ({
    organizationId: row.org_id,
    day: row.day,
    turns: row.turns,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
  }));
  return { usage, ...boundsOf(rows.results, usage.length) };
}

type ExportSectionBounds = { total: number; truncated: boolean };

/**
 * `COUNT(*) OVER ()` counts the matching rows before `LIMIT` applies, so a
 * truncated section reports how many records it left behind rather than implying
 * the page it returned was all of them.
 */
function boundsOf(rows: { total_rows: number }[], returned: number): ExportSectionBounds {
  const total = rows[0]?.total_rows ?? 0;
  return { total, truncated: total > returned };
}

function isoTimestamp(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

function optionalIsoTimestamp(epochMilliseconds: number | null): string | null {
  return epochMilliseconds === null ? null : isoTimestamp(epochMilliseconds);
}
