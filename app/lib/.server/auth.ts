const SESSION_COOKIE = 'cloudchef_session';
import { bytesToBase64Url, sha256Hex } from '~/lib/hex-digest';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type CloudflareAuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export type CloudflareAuthSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: number;
    createdAt: number;
  };
  user: CloudflareAuthUser;
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
};

type CloudflareAuthUserRow = CloudflareAuthUser & {
  cloudflare_subject: string | null;
};

export async function getAuthSession(env: Env, request: Request): Promise<CloudflareAuthSession | null> {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT auth.id AS session_id, auth.user_id, auth.expires_at, auth.created_at,
            users.name, users.email, users.image
     FROM cloudflare_auth_sessions AS auth
     JOIN "user" AS users ON users.id = auth.user_id
     JOIN cloudflare_connections AS connections
       ON connections.user_id = auth.user_id AND connections.status = 'active'
     WHERE auth.token_hash = ? AND auth.expires_at > ?`,
  )
    .bind(tokenHash, now)
    .first<SessionRow>();
  if (!row) {
    return null;
  }
  return {
    session: { id: row.session_id, userId: row.user_id, expiresAt: row.expires_at, createdAt: row.created_at },
    user: { id: row.user_id, name: row.name, email: row.email, image: row.image },
  };
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
    .prepare('SELECT id, name, email, image FROM "user" WHERE cloudflare_subject = ?')
    .bind(identity.subject)
    .first<CloudflareAuthUser>();
  const email = identity.email ?? `${identity.subject}@users.cloudflare.invalid`;
  const name = identity.name ?? accountName ?? 'Cloudflare user';
  const image = identity.picture;
  if (existingBySubject) {
    await updateUser(db, existingBySubject.id, identity.subject, name, email, image, now);
    return { id: existingBySubject.id, name, email, image };
  }

  const existingByEmail = await findAdoptableCloudflareUserByEmail(db, identity);
  if (existingByEmail) {
    await updateUser(db, existingByEmail.id, identity.subject, name, email, image, now);
    return { id: existingByEmail.id, name, email, image };
  }

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

async function findAdoptableCloudflareUserByEmail(
  db: D1Database,
  identity: CloudflareOAuthIdentity,
): Promise<CloudflareAuthUser | null> {
  if (!identity.email) {
    return null;
  }
  const row = await db
    .prepare('SELECT id, name, email, image, cloudflare_subject FROM "user" WHERE email = ?')
    .bind(identity.email)
    .first<CloudflareAuthUserRow>();
  if (row && row.cloudflare_subject !== null && row.cloudflare_subject !== identity.subject) {
    throw new Error('This verified email is already linked to a different Cloudflare identity.');
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
