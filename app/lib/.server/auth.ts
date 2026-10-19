const SESSION_COOKIE = 'cloudchef_session';
import { bytesToBase64Url, sha256Hex } from '~/lib/hex-digest';
import { IdentityConflictError } from '~/lib/.server/identity-conflict-error';
import { listWorkspaceContexts, type WorkspaceContextOption } from '~/lib/cloudflare/data/organization-access.server';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type CloudflareAuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

/**
 * The Cloudflare account a session builds in: the person's own, or an organization's they belong to.
 * A session doesn't imply one: someone signed in by email or Google has none until they connect
 * Cloudflare or join an organization.
 */
export type WorkspaceContext = WorkspaceContextOption;

export type CloudflareAuthSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: number;
    createdAt: number;
  };
  user: CloudflareAuthUser;
  context: WorkspaceContext | null;
  /** Every account this person can switch to, `context` among them. */
  contexts: WorkspaceContext[];
};

type PreparedAuthSession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
  cookie: string;
};

type CloudflareOAuthIdentity = {
  subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
};

type SessionRow = {
  session_id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
  name: string;
  email: string;
  image: string | null;
  context_connection_id: string | null;
};

type CloudflareAuthUserRow = CloudflareAuthUser & {
  cloudflare_subject?: string | null;
  email_proven_at: number | null;
};

export async function getAuthSession(env: Env, request: Request): Promise<CloudflareAuthSession | null> {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT auth.id AS session_id, auth.user_id, auth.expires_at, auth.created_at, auth.context_connection_id,
            users.name, users.email, users.image
     FROM cloudflare_auth_sessions AS auth
     JOIN "user" AS users ON users.id = auth.user_id
     WHERE auth.token_hash = ? AND auth.expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<SessionRow>();
  if (!row) {
    return null;
  }
  const contexts = await listWorkspaceContexts(env.DB, row.user_id);
  return {
    session: { id: row.session_id, userId: row.user_id, expiresAt: row.expires_at, createdAt: row.created_at },
    user: { id: row.user_id, name: row.name, email: row.email, image: row.image },
    // The account the session chose, while the person may still build in it; otherwise their first.
    context: contexts.find((option) => option.connectionId === row.context_connection_id) ?? contexts.at(0) ?? null,
    contexts,
  };
}

/**
 * Switches the session to another account this person may build in. False, and nothing changed, when
 * the session is gone or the account isn't one of theirs.
 */
export async function setSessionContext(env: Env, request: Request, connectionId: string): Promise<boolean> {
  const session = await getAuthSession(env, request);
  if (!session?.contexts.some((option) => option.connectionId === connectionId)) {
    return false;
  }
  await env.DB.prepare('UPDATE cloudflare_auth_sessions SET context_connection_id = ?, updated_at = ? WHERE id = ?')
    .bind(connectionId, Date.now(), session.session.id)
    .run();
  return true;
}

export async function prepareAuthSession(
  userId: string,
  request?: Request,
  now = Date.now(),
): Promise<PreparedAuthSession> {
  const token = randomToken();
  return {
    id: crypto.randomUUID(),
    userId,
    tokenHash: await sha256Hex(token),
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1_000,
    createdAt: now,
    cookie: serializeSessionCookie(token, SESSION_MAX_AGE_SECONDS, isHttps(request)),
  };
}

export async function createAuthSession(env: Env, session: PreparedAuthSession): Promise<string> {
  try {
    await env.DB.prepare(
      `INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt, session.createdAt)
      .run();
  } catch (error) {
    const committed = await isExactAuthSessionCommitted(env.DB, session).catch((readError) => {
      console.warn('Unable to verify auth session commit', readError);
      return false;
    });
    if (!committed) {
      throw error;
    }
  }
  return session.cookie;
}

export async function deleteAuthSession(env: Env, request: Request): Promise<void> {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) {
    return;
  }
  await env.DB.prepare('DELETE FROM cloudflare_auth_sessions WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .run();
}

export function clearAuthSessionCookie(request?: Request): string {
  return serializeSessionCookie('', 0, isHttps(request));
}

export async function upsertCloudflareUser(
  db: D1Database,
  identity: CloudflareOAuthIdentity,
  accountName: string | null,
  now = Date.now(),
): Promise<CloudflareAuthUser> {
  const existingBySubject = await db
    .prepare('SELECT id, name, email, image, email_proven_at FROM "user" WHERE cloudflare_subject = ?')
    .bind(identity.subject)
    .first<CloudflareAuthUserRow>();
  const reportedEmail = identity.email ?? `${identity.subject}@users.cloudflare.invalid`;
  const name = identity.name ?? accountName ?? 'Cloudflare user';
  const image = identity.picture;
  if (existingBySubject) {
    // An email CloudChef proved (a link or Google) is how invites and email sign-in find this person;
    // Cloudflare's reported email never replaces it.
    // Nor does it take back an address someone else has since proven (their email was detached from
    // this user then); this user keeps the placeholder they were given.
    const reportedTaken = await db
      .prepare('SELECT 1 AS taken FROM "user" WHERE email = ? COLLATE NOCASE AND id <> ?')
      .bind(reportedEmail, existingBySubject.id)
      .first<{ taken: number }>();
    const email =
      existingBySubject.email_proven_at === null && !reportedTaken ? reportedEmail : existingBySubject.email;
    await updateUser(db, existingBySubject.id, identity.subject, name, email, image, now);
    return { id: existingBySubject.id, name, email, image };
  }

  const existingByEmail = await findAdoptableCloudflareUserByEmail(db, identity);
  if (existingByEmail) {
    await updateUser(db, existingByEmail.id, identity.subject, name, reportedEmail, image, now);
    return { id: existingByEmail.id, name, email: reportedEmail, image };
  }
  const email = reportedEmail;

  const id = crypto.randomUUID();
  const emailVerified = identity.email ? 1 : 0;
  try {
    await db
      .prepare(
        `INSERT INTO "user"
          (id, name, email, emailVerified, image, createdAt, updatedAt, cloudflare_subject)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, name, email, emailVerified, image, now, now, identity.subject)
      .run();
  } catch (error) {
    const committed = await isExactCloudflareUser(db, {
      id,
      subject: identity.subject,
      name,
      email,
      emailVerified,
      image,
      createdAt: now,
      updatedAt: now,
    }).catch((readError) => {
      console.warn('Unable to verify Cloudflare user commit', readError);
      return false;
    });
    if (committed) {
      return { id, name, email, image };
    }
    const racedUser = await findCloudflareUserBySubjectOrEmail(db, identity).catch((readError) => {
      console.warn('Unable to read raced Cloudflare user', readError);
      return null;
    });
    if (!racedUser) {
      throw error;
    }
    await updateUser(db, racedUser.id, identity.subject, name, email, image, now);
    return { id: racedUser.id, name, email, image };
  }
  return { id, name, email, image };
}

/**
 * The user for an email address its holder just proved (an emailed link, or Google with a verified
 * email): the user with that email, whichever way they first signed in, or a new one. A Google
 * sign-in also records the Google account, so a later change of email at Google finds the same user.
 */
export async function upsertVerifiedEmailUser(
  db: D1Database,
  identity: { email: string; name?: string | null; image?: string | null; googleSubject?: string | null },
  now = Date.now(),
  /** Who was signed in when the email was proven, if anyone. */
  signedInUserId: string | null = null,
): Promise<CloudflareAuthUser> {
  const email = normalizeEmail(identity.email);
  const googleSubject = identity.googleSubject ?? null;
  if (googleSubject) {
    const byGoogle = await db
      .prepare('SELECT id, name, email, image FROM "user" WHERE google_subject = ?')
      .bind(googleSubject)
      .first<CloudflareAuthUser>();
    if (byGoogle) {
      return byGoogle;
    }
  }
  const found = await db
    .prepare(
      `SELECT id, name, email, image, google_subject, cloudflare_subject, email_proven_at
       FROM "user" WHERE email = ? COLLATE NOCASE`,
    )
    .bind(email)
    .first<
      CloudflareAuthUser & {
        google_subject: string | null;
        cloudflare_subject: string | null;
        email_proven_at: number | null;
      }
    >();
  // A user known only through Cloudflare carries an email CloudChef never checked: anyone can make
  // their Cloudflare login report someone else's. Proving that email doesn't sign into that user,
  // unless they are the one signed in and proving it now. Otherwise the unchecked email is taken off
  // them and the person who proved it gets their own account.
  let byEmail = found;
  if (found && found.cloudflare_subject !== null && found.email_proven_at === null && found.id !== signedInUserId) {
    await db
      .prepare('UPDATE "user" SET email = ?, emailVerified = 0, updatedAt = ? WHERE id = ? AND email_proven_at IS NULL')
      .bind(`${found.cloudflare_subject}@users.cloudflare.invalid`, now, found.id)
      .run();
    byEmail = null;
  }
  if (byEmail) {
    if (googleSubject && byEmail.google_subject !== null && byEmail.google_subject !== googleSubject) {
      throw new IdentityConflictError('This email is already linked to a different Google account.');
    }
    await db
      .prepare(
        `UPDATE "user" SET emailVerified = 1, email_proven_at = ?, google_subject = COALESCE(google_subject, ?),
           updatedAt = ?
         WHERE id = ?`,
      )
      .bind(now, googleSubject, now, byEmail.id)
      .run();
    return { id: byEmail.id, name: byEmail.name, email: byEmail.email, image: byEmail.image };
  }
  const id = crypto.randomUUID();
  const name = identity.name?.trim() || email.split('@')[0];
  const image = identity.image ?? null;
  try {
    await db
      .prepare(
        `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt, google_subject, email_proven_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .bind(id, name, email, image, now, now, googleSubject, now)
      .run();
  } catch (error) {
    // Two sign-ins for one new email raced: the other created the user.
    const raced = await db
      .prepare('SELECT id, name, email, image FROM "user" WHERE email = ? COLLATE NOCASE')
      .bind(email)
      .first<CloudflareAuthUser>();
    if (!raced) {
      throw error;
    }
    return raced;
  }
  return { id, name, email, image };
}

/**
 * Attaches a Cloudflare login to a user who is already signed in (by email or Google), so the
 * connection made next is theirs. Refused if that Cloudflare login already belongs to someone else.
 */
export async function attachCloudflareIdentity(
  db: D1Database,
  userId: string,
  subject: string,
  now = Date.now(),
): Promise<CloudflareAuthUser> {
  const owner = await db
    .prepare('SELECT id FROM "user" WHERE cloudflare_subject = ?')
    .bind(subject)
    .first<{ id: string }>();
  if (owner && owner.id !== userId) {
    throw new IdentityConflictError(
      'This Cloudflare login already belongs to another CloudChef account. Sign in with Cloudflare to use it.',
    );
  }
  const result = await db
    .prepare(
      `UPDATE "user" SET cloudflare_subject = ?, updatedAt = ?
       WHERE id = ? AND (cloudflare_subject IS NULL OR cloudflare_subject = ?)`,
    )
    .bind(subject, now, userId, subject)
    .run();
  if (result.meta.changes !== 1) {
    throw new IdentityConflictError('Your CloudChef account is already linked to a different Cloudflare login.');
  }
  const user = await db
    .prepare('SELECT id, name, email, image FROM "user" WHERE id = ?')
    .bind(userId)
    .first<CloudflareAuthUser>();
  if (!user) {
    throw new Error('The signed-in user no longer exists.');
  }
  return user;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findCloudflareUserBySubjectOrEmail(
  db: D1Database,
  identity: CloudflareOAuthIdentity,
): Promise<CloudflareAuthUser | null> {
  const bySubject = await db
    .prepare('SELECT id, name, email, image FROM "user" WHERE cloudflare_subject = ?')
    .bind(identity.subject)
    .first<CloudflareAuthUser>();
  if (bySubject) {
    return bySubject;
  }
  return findAdoptableCloudflareUserByEmail(db, identity);
}

/**
 * A user Cloudflare sign-in may take over by email: only one known through Cloudflare alone (from
 * before sign-in stored the subject). CloudChef never checked the email Cloudflare reports, so a user
 * whose email CloudChef proved, by a link or Google, is never adopted: they sign in their own way and
 * connect Cloudflare from there.
 */
async function findAdoptableCloudflareUserByEmail(
  db: D1Database,
  identity: CloudflareOAuthIdentity,
): Promise<CloudflareAuthUser | null> {
  if (!identity.email) {
    return null;
  }
  const row = await db
    .prepare(
      'SELECT id, name, email, image, cloudflare_subject, email_proven_at FROM "user" WHERE email = ? COLLATE NOCASE',
    )
    .bind(identity.email)
    .first<CloudflareAuthUserRow>();
  if (row && row.cloudflare_subject !== null && row.cloudflare_subject !== identity.subject) {
    throw new Error('This verified email is already linked to a different Cloudflare identity.');
  }
  if (row && row.cloudflare_subject === null && row.email_proven_at !== null) {
    throw new IdentityConflictError(
      'This email already has a CloudChef account. Sign in with Google or an emailed link, then connect Cloudflare in Settings.',
    );
  }
  return row;
}

async function updateUser(
  db: D1Database,
  id: string,
  subject: string,
  name: string,
  email: string,
  image: string | null,
  now: number,
) {
  const emailVerified = email.endsWith('@users.cloudflare.invalid') ? 0 : 1;
  try {
    const result = await db
      .prepare(
        `UPDATE "user"
         SET cloudflare_subject = ?, name = ?, email = ?, emailVerified = ?, image = ?, updatedAt = ?
         WHERE id = ? AND (cloudflare_subject IS NULL OR cloudflare_subject = ?)`,
      )
      .bind(subject, name, email, emailVerified, image, now, id, subject)
      .run();
    if (result.meta.changes === 1) {
      return;
    }
  } catch (error) {
    const committed = await isExactCloudflareUser(db, {
      id,
      subject,
      name,
      email,
      emailVerified,
      image,
      updatedAt: now,
    }).catch((readError) => {
      console.warn('Unable to verify Cloudflare user update', readError);
      return false;
    });
    if (!committed) {
      throw error;
    }
    return;
  }
  if (
    await isExactCloudflareUser(db, {
      id,
      subject,
      name,
      email,
      emailVerified,
      image,
      updatedAt: now,
    })
  ) {
    return;
  }
  throw new Error('Cloudflare user changed while authentication was being persisted.');
}

async function isExactCloudflareUser(
  db: D1Database,
  expected: {
    id: string;
    subject: string;
    name: string;
    email: string;
    emailVerified: number;
    image: string | null;
    createdAt?: number;
    updatedAt: number;
  },
): Promise<boolean> {
  const createdAtClause = expected.createdAt === undefined ? '' : ' AND createdAt = ?';
  const statement = db
    .prepare(
      `SELECT 1 AS found FROM "user"
       WHERE id = ? AND cloudflare_subject = ? AND name = ? AND email = ?
         AND emailVerified = ? AND image IS ? AND updatedAt = ?${createdAtClause}`,
    )
    .bind(
      expected.id,
      expected.subject,
      expected.name,
      expected.email,
      expected.emailVerified,
      expected.image,
      expected.updatedAt,
      ...(expected.createdAt === undefined ? [] : [expected.createdAt]),
    );
  const row = await statement.first<{ found: number }>();
  return row?.found === 1;
}

function serializeSessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax; Max-Age=${maxAge}`;
}

function isHttps(request?: Request): boolean {
  return !request || new URL(request.url).protocol === 'https:';
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const [candidate, ...value] = part.trim().split('=');
    if (candidate === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function isExactAuthSessionCommitted(db: D1Database, session: PreparedAuthSession): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS found
       FROM cloudflare_auth_sessions
       WHERE id = ? AND user_id = ? AND token_hash = ? AND expires_at = ?
         AND created_at = ? AND updated_at = ?`,
    )
    .bind(session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt, session.createdAt)
    .first<{ found: number }>();
  return row?.found === 1;
}

function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
