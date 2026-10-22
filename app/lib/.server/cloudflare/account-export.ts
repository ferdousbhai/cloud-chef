import { z } from 'zod';
import type { AccountExportSectionName } from '~/lib/account-data';
import { findCloudflareConnectionForUser } from './cloudflare-connection-repository';

/**
 * Bumped whenever a field is added, removed, or reinterpreted, so a file a user
 * kept for years stays readable against the shape it was written in.
 */
export const ACCOUNT_EXPORT_SCHEMA_VERSION = 7;

/**
 * Per-section ceiling on rows. A list section returns its most recent page and
 * reports the untruncated count beside it, so a whole export stays bounded.
 */
export const ACCOUNT_EXPORT_ROW_LIMIT = 200;

const SECTION_NAMES = [
  'account',
  'cloudflareConnection',
  'encryptedCredential',
  'computerRuntimes',
  'organizations',
  'organizationInvites',
  'organizationQuotaEvents',
  'organizationUsage',
  'organizationProjects',
  'productionRequests',
  'githubConnections',
  'githubApprovals',
  'emailSignInLinks',
  'authSessions',
  'oauthStates',
] as const satisfies readonly AccountExportSectionName[];

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
  'Production and preview Workers, production and preview D1 databases, R2 buckets, KV namespaces, Containers, Durable Objects, and Agents that CloudChef deployed, and the logs and traces they produce. These live in the connected Cloudflare account and are readable with that account’s own tools.',
  'Copies held by the browser. No server request can reach them; clear CloudChef site data in every browser and profile you have used.',
  'Encrypted credential material, initialisation vectors, credential handles, session tokens, and the hashes and state values that sign-in links, invites, and authorizations in progress are checked against. These are never exported.',
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
  /** Whether their model requests are logged with their content in the connected account's AI Gateway. */
  aiGatewayContentLogging: boolean;
  createdAt: string;
  updatedAt: string;
};

type ExportedCloudflareConnection = {
  id: string;
  accountId: string;
  accountName: string | null;
  status: string;
  grantedCapabilities: string[];
  requestedOAuthScopes: string[];
  grantedOAuthScopes: string[];
  oauthScopeProfileVersion: string | null;
  oauthScopeGrantStatus: string;
  /** The model builders in this account start on, as its owner chose; null for CloudChef's default. */
  defaultBuilderModel: string | null;
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
  imageDigest: string;
  protocolVersion: number;
  status: string;
  lastError: string | null;
  lastSessionAt: string | null;
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
  /** Whether they may build new apps of their own there, or only the GitHub projects they're given. */
  draftsAllowed: boolean;
};

/** An invite addressed to this person's email, accepted or not. */
type ExportedInvite = {
  organizationName: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  /** The team's projects it gives on joining. */
  projectIds: string[];
  draftsAllowed: boolean;
};

/** An invite this person sent, or a team they created, as counted toward the limits on both. */
type ExportedQuotaEvent = {
  kind: 'invite' | 'team';
  organizationId: string;
  createdAt: string;
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

/** A GitHub-backed project this person was given access to. Its repository's contents live in GitHub. */
type ExportedProjectAccess = {
  organizationId: string;
  projectName: string;
  repository: string;
  grantedAt: string;
};

/**
 * A draft this person asked to make a real project. Its files travel with the request until it is
 * decided, and are exported as the gzipped JSON CloudChef holds; after a decision only the record is kept.
 */
type ExportedProductionRequest = {
  id: string;
  organizationId: string;
  title: string;
  note: string | null;
  previewUrl: string | null;
  draftId: string | null;
  draftRevision: string | null;
  status: string;
  decisionNote: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string | null;
  decidedAt: string | null;
  draftFiles: number;
  draftSourceGzipBase64: string | null;
};

/** A GitHub connection this person started for a team: who for, and where it returned. */
type ExportedGitHubConnection = {
  organizationId: string;
  returnTo: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};

/** An approval of a production request this person started, while GitHub authorized it. */
type ExportedGitHubApproval = {
  requestId: string;
  repositoryName: string;
  private: boolean;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};

/** A sign-in link CloudChef emailed to this person's address. */
type ExportedEmailSignInLink = {
  email: string;
  returnTo: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};

type ExportedAuthSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

type ExportedOAuthState = {
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
    organizationQuotaEvents: ExportedSection<BoundedList<{ events: ExportedQuotaEvent[] }>>;
    organizationUsage: ExportedSection<BoundedList<{ usage: ExportedUsageDay[] }>>;
    organizationProjects: ExportedSection<BoundedList<{ projects: ExportedProjectAccess[] }>>;
    productionRequests: ExportedSection<BoundedList<{ requests: ExportedProductionRequest[] }>>;
    githubConnections: ExportedSection<BoundedList<{ connections: ExportedGitHubConnection[] }>>;
    githubApprovals: ExportedSection<BoundedList<{ approvals: ExportedGitHubApproval[] }>>;
    emailSignInLinks: ExportedSection<BoundedList<{ links: ExportedEmailSignInLink[] }>>;
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
    organizationQuotaEvents: await exportSection('organizationQuotaEvents', () => readQuotaEvents(db, args.userId)),
    organizationUsage: await exportSection('organizationUsage', () => readUsage(db, args.userId)),
    organizationProjects: await exportSection('organizationProjects', () => readProjectAccess(db, args.userId)),
    productionRequests: await exportSection('productionRequests', () => readProductionRequests(db, args.userId)),
    githubConnections: await exportSection('githubConnections', () => readGitHubConnections(db, args.userId)),
    githubApprovals: await exportSection('githubApprovals', () => readGitHubApprovals(db, args.userId)),
    emailSignInLinks: await exportSection('emailSignInLinks', () => readEmailSignInLinks(db, args.userId)),
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
  ai_gateway_content_logging: number;
  createdAt: number;
  updatedAt: number;
};

async function readAccount(db: D1Database, userId: string): Promise<{ account: ExportedAccount | null }> {
  const row = await db
    .prepare(
      `SELECT id, name, email, emailVerified, image, cloudflare_subject, google_subject, email_proven_at,
              ai_gateway_content_logging, createdAt, updatedAt
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
      aiGatewayContentLogging: row.ai_gateway_content_logging === 1,
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
  const model = connection
    ? await db
        .prepare('SELECT default_builder_model FROM cloudflare_connections WHERE id = ?')
        .bind(connection.id)
        .first<{ default_builder_model: string | null }>()
    : null;
  return {
    // The credential handle resolves the stored ciphertext, so it is dropped here
    // rather than carried into a file the user keeps and forwards.
    connection: connection && {
      id: connection.id,
      accountId: connection.accountId,
      accountName: connection.accountName,
      status: connection.status,
      grantedCapabilities: connection.grantedCapabilities,
      requestedOAuthScopes: connection.requestedOAuthScopes,
      grantedOAuthScopes: connection.grantedOAuthScopes,
      oauthScopeProfileVersion: connection.oauthScopeProfileVersion,
      oauthScopeGrantStatus: connection.oauthScopeGrantStatus,
      defaultBuilderModel: model?.default_builder_model ?? null,
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
  image_digest: string;
  protocol_version: number;
  status: string;
  last_error: string | null;
  last_session_at: number | null;
  created_at: number;
  updated_at: number;
};

/** One workspace runtime per Cloudflare account the person builds in: their own, and each organization's. */
async function readComputerRuntimes(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ computerRuntimes: ExportedComputerRuntime[] }>> {
  const { items: computerRuntimes, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT connection_id, connection_generation, worker_name, endpoint, runtime_version, image_digest,
              protocol_version, status, last_error, last_session_at, created_at, updated_at,
              COUNT(*) OVER () AS total_rows
       FROM user_computer_runtimes WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    (row: ComputerRuntimeRow) => ({
      connectionId: row.connection_id,
      connectionGeneration: row.connection_generation,
      workerName: row.worker_name,
      endpoint: row.endpoint,
      runtimeVersion: row.runtime_version,
      imageDigest: row.image_digest,
      protocolVersion: row.protocol_version,
      status: row.status,
      lastError: row.last_error,
      lastSessionAt: optionalIsoTimestamp(row.last_session_at),
      createdAt: isoTimestamp(row.created_at),
      updatedAt: isoTimestamp(row.updated_at),
    }),
  );
  return { computerRuntimes, ...bounds };
}

async function readMemberships(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ memberships: ExportedMembership[] }>> {
  const { items: memberships, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT members.org_id, organizations.name, members.role, members.joined_at, members.paused_at,
              members.drafts_allowed, COUNT(*) OVER () AS total_rows
       FROM organization_members AS members
       JOIN organizations ON organizations.id = members.org_id
       WHERE members.user_id = ?
       ORDER BY members.joined_at LIMIT ?`,
    (row: {
      org_id: string;
      name: string;
      role: string;
      joined_at: number;
      paused_at: number | null;
      drafts_allowed: number;
    }) => ({
      organizationId: row.org_id,
      organizationName: row.name,
      role: row.role,
      joinedAt: isoTimestamp(row.joined_at),
      pausedAt: optionalIsoTimestamp(row.paused_at),
      draftsAllowed: row.role === 'admin' || row.drafts_allowed === 1,
    }),
  );
  return { memberships, ...bounds };
}

type AuthSessionRow = {
  id: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

async function readAuthSessions(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ sessions: ExportedAuthSession[] }>> {
  // The token hash authenticates a live session, so only the record of the
  // session's existence and lifetime is exported.
  const { items: sessions, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT id, created_at, updated_at, expires_at, COUNT(*) OVER () AS total_rows
       FROM cloudflare_auth_sessions WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    (row: AuthSessionRow) => ({
      id: row.id,
      createdAt: isoTimestamp(row.created_at),
      updatedAt: isoTimestamp(row.updated_at),
      expiresAt: isoTimestamp(row.expires_at),
    }),
  );
  return { sessions, ...bounds };
}

type OAuthStateRow = {
  status: string;
  return_to: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
};

async function readOAuthStates(db: D1Database, userId: string): Promise<BoundedList<{ states: ExportedOAuthState[] }>> {
  // The state id is what Cloudflare's return is checked against, and the provider session identifier
  // the handle its authorization flow is resumed with, so only the local record of the attempt is exported.
  const { items: states, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT status, return_to, expires_at, created_at, updated_at, COUNT(*) OVER () AS total_rows
       FROM cloudflare_oauth_states WHERE authenticated_user_id = ?1 OR linking_user_id = ?1
       ORDER BY created_at DESC LIMIT ?2`,
    (row: OAuthStateRow) => ({
      status: row.status,
      returnTo: row.return_to,
      expiresAt: isoTimestamp(row.expires_at),
      createdAt: isoTimestamp(row.created_at),
      updatedAt: isoTimestamp(row.updated_at),
    }),
  );
  return { states, ...bounds };
}

async function readInvites(db: D1Database, userId: string): Promise<BoundedList<{ invites: ExportedInvite[] }>> {
  // The invite token's hash authenticates acceptance, so only the record of the invite is exported.
  const { items: invites, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT organizations.name, invites.role, invites.created_at, invites.expires_at, invites.accepted_at,
              invites.project_ids, invites.drafts_allowed, COUNT(*) OVER () AS total_rows
       FROM organization_invites AS invites
       JOIN organizations ON organizations.id = invites.org_id
       -- Only to an email CloudChef proved: one a Cloudflare login merely reports says nothing about
       -- who holds it, and the invites to it aren't this person's to see.
       WHERE invites.email = (SELECT email FROM "user" WHERE id = ? AND email_proven_at IS NOT NULL) COLLATE NOCASE
       ORDER BY invites.created_at DESC LIMIT ?`,
    (row: {
      name: string;
      role: string;
      created_at: number;
      expires_at: number;
      accepted_at: number | null;
      project_ids: string | null;
      drafts_allowed: number;
    }) => ({
      organizationName: row.name,
      role: row.role,
      createdAt: isoTimestamp(row.created_at),
      expiresAt: isoTimestamp(row.expires_at),
      acceptedAt: optionalIsoTimestamp(row.accepted_at),
      projectIds: storedProjectIds(row.project_ids),
      draftsAllowed: row.role === 'admin' || row.drafts_allowed === 1,
    }),
  );
  return { invites, ...bounds };
}

const quotaEventKindSchema = z.enum(['invite', 'team']);

async function readQuotaEvents(db: D1Database, userId: string): Promise<BoundedList<{ events: ExportedQuotaEvent[] }>> {
  const { items: events, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT kind, org_id, created_at, COUNT(*) OVER () AS total_rows
       FROM organization_quota_events WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    (row: { kind: string; org_id: string; created_at: number }) => ({
      kind: quotaEventKindSchema.parse(row.kind),
      organizationId: row.org_id,
      createdAt: isoTimestamp(row.created_at),
    }),
  );
  return { events, ...bounds };
}

async function readUsage(db: D1Database, userId: string): Promise<BoundedList<{ usage: ExportedUsageDay[] }>> {
  const { items: usage, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT org_id, day, turns, input_tokens, output_tokens, cached_tokens, COUNT(*) OVER () AS total_rows
       FROM organization_usage_daily WHERE user_id = ?
       ORDER BY day DESC LIMIT ?`,
    (row: {
      org_id: string;
      day: string;
      turns: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
    }) => ({
      organizationId: row.org_id,
      day: row.day,
      turns: row.turns,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
    }),
  );
  return { usage, ...bounds };
}

/** An invite's stored project ids, exactly as kept; anything unreadable is none. */
function storedProjectIds(stored: string | null): string[] {
  if (stored === null) {
    return [];
  }
  try {
    return storedProjectIdsSchema.catch([]).parse(JSON.parse(stored));
  } catch {
    return [];
  }
}

const storedProjectIdsSchema = z.array(z.string());

type ExportSectionBounds = { total: number; truncated: boolean };

/**
 * One list section: the most recent page of the rows `sql` selects for the person (bound to the user id
 * and the row limit, in that order), each as `toItem` exports it. `sql` selects `COUNT(*) OVER ()` as
 * `total_rows`, which counts the matching rows before `LIMIT` applies, so a truncated section reports how
 * many records it left behind rather than implying the page it returned was all of them.
 */
async function readBoundedList<Row, Item>(
  db: D1Database,
  userId: string,
  sql: string,
  toItem: (row: Row) => Item,
): Promise<{ items: Item[] } & ExportSectionBounds> {
  const rows = await db.prepare(sql).bind(userId, ACCOUNT_EXPORT_ROW_LIMIT).all<Row & { total_rows: number }>();
  const items = rows.results.map(toItem);
  const total = rows.results[0]?.total_rows ?? 0;
  return { items, total, truncated: total > items.length };
}

function isoTimestamp(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString();
}

function optionalIsoTimestamp(epochMilliseconds: number | null): string | null {
  return epochMilliseconds === null ? null : isoTimestamp(epochMilliseconds);
}

async function readProjectAccess(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ projects: ExportedProjectAccess[] }>> {
  const { items: projects, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT projects.org_id, projects.name, projects.repo_full_name, access.granted_at, COUNT(*) OVER () AS total_rows
       FROM org_project_access AS access
       JOIN org_projects AS projects ON projects.id = access.project_id
       WHERE access.user_id = ?
       ORDER BY access.granted_at DESC LIMIT ?`,
    (row: { org_id: string; name: string; repo_full_name: string; granted_at: number }) => ({
      organizationId: row.org_id,
      projectName: row.name,
      repository: row.repo_full_name,
      grantedAt: new Date(row.granted_at).toISOString(),
    }),
  );
  return { projects, ...bounds };
}

async function readProductionRequests(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ requests: ExportedProductionRequest[] }>> {
  const { items: requests, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT id, org_id, title, note, preview_url, draft_id, draft_revision, status, decision_note, project_id,
              created_at, updated_at, decided_at, snapshot_files, snapshot_gzip_base64, COUNT(*) OVER () AS total_rows
       FROM production_requests WHERE requested_by = ?
       ORDER BY created_at DESC LIMIT ?`,
    (row: {
      id: string;
      org_id: string;
      title: string;
      note: string | null;
      preview_url: string | null;
      draft_id: string | null;
      draft_revision: string | null;
      status: string;
      decision_note: string | null;
      project_id: string | null;
      created_at: number;
      updated_at: number | null;
      decided_at: number | null;
      snapshot_files: number;
      snapshot_gzip_base64: string;
    }) => ({
      id: row.id,
      organizationId: row.org_id,
      title: row.title,
      note: row.note,
      previewUrl: row.preview_url,
      draftId: row.draft_id,
      draftRevision: row.draft_revision,
      status: row.status,
      decisionNote: row.decision_note,
      projectId: row.project_id,
      createdAt: isoTimestamp(row.created_at),
      updatedAt: optionalIsoTimestamp(row.updated_at),
      decidedAt: optionalIsoTimestamp(row.decided_at),
      draftFiles: row.snapshot_files,
      // The member's own source; a decided request keeps none (an empty string).
      draftSourceGzipBase64: row.snapshot_gzip_base64 || null,
    }),
  );
  return { requests, ...bounds };
}

async function readGitHubConnections(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ connections: ExportedGitHubConnection[] }>> {
  // The state id is what GitHub's return is checked against, so only the record is exported.
  const { items: connections, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT org_id, return_to, created_at, expires_at, used_at, COUNT(*) OVER () AS total_rows
       FROM github_install_states WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    (row: { org_id: string; return_to: string; created_at: number; expires_at: number; used_at: number | null }) => ({
      organizationId: row.org_id,
      returnTo: row.return_to,
      createdAt: isoTimestamp(row.created_at),
      expiresAt: isoTimestamp(row.expires_at),
      usedAt: optionalIsoTimestamp(row.used_at),
    }),
  );
  return { connections, ...bounds };
}

async function readGitHubApprovals(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ approvals: ExportedGitHubApproval[] }>> {
  const { items: approvals, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT request_id, repo_name, private, created_at, expires_at, used_at, COUNT(*) OVER () AS total_rows
       FROM github_approval_states WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    (row: {
      request_id: string;
      repo_name: string;
      private: number;
      created_at: number;
      expires_at: number;
      used_at: number | null;
    }) => ({
      requestId: row.request_id,
      repositoryName: row.repo_name,
      private: row.private === 1,
      createdAt: isoTimestamp(row.created_at),
      expiresAt: isoTimestamp(row.expires_at),
      usedAt: optionalIsoTimestamp(row.used_at),
    }),
  );
  return { approvals, ...bounds };
}

async function readEmailSignInLinks(
  db: D1Database,
  userId: string,
): Promise<BoundedList<{ links: ExportedEmailSignInLink[] }>> {
  // The token's hash signs the person in, so only the record of the link is exported.
  const { items: links, ...bounds } = await readBoundedList(
    db,
    userId,
    `SELECT email, return_to, created_at, expires_at, used_at, COUNT(*) OVER () AS total_rows
       FROM email_sign_in_tokens WHERE email = (SELECT lower(email) FROM "user" WHERE id = ?)
       ORDER BY created_at DESC LIMIT ?`,
    (row: { email: string; return_to: string; created_at: number; expires_at: number; used_at: number | null }) => ({
      email: row.email,
      returnTo: row.return_to,
      createdAt: isoTimestamp(row.created_at),
      expiresAt: isoTimestamp(row.expires_at),
      usedAt: optionalIsoTimestamp(row.used_at),
    }),
  );
  return { links, ...bounds };
}
