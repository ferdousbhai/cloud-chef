const SESSION_COOKIE = 'cloudchef_session';
import { bytesToBase64Url, sha256Hex } from '~/lib/hex-digest';
import { IdentityConflictError } from '~/lib/.server/identity-conflict-error';
import { readCookie, serializeCookie } from '~/lib/.server/request-guards';
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
  /** With their username (`<username>/<project>` addresses), null until they choose one. */
  user: CloudflareAuthUser & { username: string | null };
  context: WorkspaceContext | null;
  /** Every account this person can switch to, `context` among them. */
  contexts: WorkspaceContext[];
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
  username: string | null;
  context_connection_id: string | null;
};

type CloudflareAuthUserRow = CloudflareAuthUser & {
  cloudflare_subject?: string | null;
  email_proven_at: number | null;
};

export async function getAuthSession(env: Env, request: Request): Promise<CloudflareAuthSession | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT auth.id AS session_id, auth.user_id, auth.expires_at, auth.created_at, auth.context_connection_id,
            users.name, users.email, users.image, users.username
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
    user: { id: row.user_id, name: row.name, email: row.email, image: row.image, username: row.username },
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

/** Starts a session for `userId`: the new session's id, and the cookie that carries it. */
export async function createAuthSession(
  env: Env,
  userId: string,
  request: Request,
): Promise<{ id: string; cookie: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO cloudflare_auth_sessions (id, user_id, token_hash, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, await sha256Hex(token), now + SESSION_MAX_AGE_SECONDS * 1_000, now, now)
    .run();
  return { id, cookie: serializeSessionCookie(token, SESSION_MAX_AGE_SECONDS, request) };
}

export async function deleteAuthSession(env: Env, request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) {
    return;
  }
  await env.DB.prepare('DELETE FROM cloudflare_auth_sessions WHERE token_hash = ?')
    .bind(await sha256Hex(token))
    .run();
}

export function clearAuthSessionCookie(request: Request): string {
  return serializeSessionCookie('', 0, request);
}

export async function upsertCloudflareUser(
  db: D1Database,
  identity: CloudflareOAuthIdentity,
  accountName: string | null,
): Promise<CloudflareAuthUser> {
  const now = Date.now();
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

  // A Cloudflare login never takes over an existing account by the email Cloudflare reports, which
  // CloudChef never checked: one already holding it is refused.
  await refuseReportedEmailOfAnotherUser(db, identity);
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
    // Two sign-ins with one new Cloudflare login raced: the other created the user.
    const racedUser = await findCloudflareUserBySubject(db, identity).catch((readError) => {
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
  /** Who was signed in when the email was proven, if anyone. */
  signedInUserId: string | null = null,
): Promise<CloudflareAuthUser> {
  const now = Date.now();
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
): Promise<CloudflareAuthUser> {
  const now = Date.now();
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

/**
 * The user a racing sign-in with the same Cloudflare identity created. A user created meanwhile with
 * the same email is never adopted: the insert's own failure stands.
 */
async function findCloudflareUserBySubject(
  db: D1Database,
  identity: CloudflareOAuthIdentity,
): Promise<CloudflareAuthUser | null> {
  return db
    .prepare('SELECT id, name, email, image FROM "user" WHERE cloudflare_subject = ?')
    .bind(identity.subject)
    .first<CloudflareAuthUser>();
}

/**
 * Refuses a Cloudflare sign-in whose reported email belongs to another CloudChef user. CloudChef never
 * checked the email Cloudflare reports, so it never adopts an account by it: a user known by another
 * Cloudflare identity keeps it, and one who signs in with Google or an emailed link signs in that way
 * and connects Cloudflare from there.
 */
async function refuseReportedEmailOfAnotherUser(db: D1Database, identity: CloudflareOAuthIdentity): Promise<void> {
  if (!identity.email) {
    return;
  }
  const row = await db
    .prepare('SELECT cloudflare_subject FROM "user" WHERE email = ? COLLATE NOCASE')
    .bind(identity.email)
    .first<{ cloudflare_subject: string | null }>();
  if (!row || row.cloudflare_subject === identity.subject) {
    return;
  }
  if (row.cloudflare_subject !== null) {
    throw new Error('This verified email is already linked to a different Cloudflare identity.');
  }
  throw new IdentityConflictError(
    'This email already has a CloudChef account. Sign in with Google or an emailed link, then connect Cloudflare in Settings.',
  );
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
  const result = await db
    .prepare(
      `UPDATE "user"
       SET cloudflare_subject = ?, name = ?, email = ?, emailVerified = ?, image = ?, updatedAt = ?
       WHERE id = ? AND (cloudflare_subject IS NULL OR cloudflare_subject = ?)`,
    )
    .bind(subject, name, email, emailVerified, image, now, id, subject)
    .run();
  if (result.meta.changes !== 1) {
    throw new Error('Cloudflare user changed while authentication was being persisted.');
  }
}

function serializeSessionCookie(token: string, maxAge: number, request: Request): string {
  return serializeCookie({ name: SESSION_COOKIE, value: token, path: '/', maxAge, request });
}

function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
