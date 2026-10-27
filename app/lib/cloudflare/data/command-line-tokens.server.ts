import { bytesToBase64Url, sha256Hex } from '~/lib/hex-digest';

/** How long a command-line token lasts. A person makes a new one when it runs out. */
const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
/** Enough for a few computers and tools at once; more would be ones forgotten about. */
const MAX_TOKENS_PER_PERSON = 10;
/** A token's last use is noted at most this often, so every git request doesn't write. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1_000;
/** Tokens are recognisable at a glance, and by secret scanners. */
const TOKEN_PREFIX = 'cct_';

type CommandLineToken = {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
};

type TokenRow = { id: string; label: string; created_at: number; last_used_at: number | null; expires_at: number };

export class TooManyCommandLineTokensError extends Error {
  constructor() {
    super(`You can have up to ${MAX_TOKENS_PER_PERSON} command-line tokens. Remove one you no longer use first.`);
    this.name = 'TooManyCommandLineTokensError';
  }
}

/** A new token for `userId`: its record, and the token itself, which is never kept and so shown only now. */
export async function createCommandLineToken(
  db: D1Database,
  userId: string,
  label: string,
): Promise<{ token: string; record: CommandLineToken }> {
  const now = Date.now();
  const live = await db
    .prepare('SELECT COUNT(*) AS count FROM command_line_tokens WHERE user_id = ? AND expires_at > ?')
    .bind(userId, now)
    .first<{ count: number }>();
  if ((live?.count ?? 0) >= MAX_TOKENS_PER_PERSON) {
    throw new TooManyCommandLineTokensError();
  }
  const token = `${TOKEN_PREFIX}${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const record: CommandLineToken = {
    id: crypto.randomUUID(),
    label,
    createdAt: now,
    lastUsedAt: null,
    expiresAt: now + TOKEN_LIFETIME_MS,
  };
  await db
    .prepare(
      `INSERT INTO command_line_tokens (id, user_id, token_hash, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(record.id, userId, await sha256Hex(token), label, record.createdAt, record.expiresAt)
    .run();
  return { token, record };
}

/** The person's tokens that haven't expired, newest first. */
export async function listCommandLineTokens(db: D1Database, userId: string): Promise<CommandLineToken[]> {
  const { results } = await db
    .prepare(
      `SELECT id, label, created_at, last_used_at, expires_at FROM command_line_tokens
       WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC`,
    )
    .bind(userId, Date.now())
    .all<TokenRow>();
  return results.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  }));
}

/** Ends one of the person's tokens; whether there was one to end. */
export async function revokeCommandLineToken(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM command_line_tokens WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run();
  return result.meta.changes > 0;
}

/** Whose a token is, while it is live; null for any other string. */
export async function commandLineTokenUser(db: D1Database, token: string): Promise<string | null> {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  const now = Date.now();
  const row = await db
    .prepare('SELECT id, user_id, last_used_at FROM command_line_tokens WHERE token_hash = ? AND expires_at > ?')
    .bind(await sha256Hex(token), now)
    .first<{ id: string; user_id: string; last_used_at: number | null }>();
  if (!row) {
    return null;
  }
  if (row.last_used_at === null || now - row.last_used_at > LAST_USED_RESOLUTION_MS) {
    await db.prepare('UPDATE command_line_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return row.user_id;
}

/** How long the command line waits for the person to approve its sign-in. */
const LOGIN_LIFETIME_MS = 10 * 60 * 1_000;
/** Letters a person reads and types without confusing them (no 0/O, 1/I/L). */
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short code to approve in the browser, in two groups of four: `WDJB-MJHT`, as gh shows it. */
function userCode(): string {
  const letters = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => USER_CODE_ALPHABET[byte % 31]);
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`;
}

/** Makes a code shown on a screen comparable to one typed in: capitals, one dash. */
function normalizeUserCode(code: string): string {
  const letters = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : '';
}

/** A sign-in for the command line to wait on: the code it keeps, and the code the person approves. */
export async function startCommandLineLogin(
  db: D1Database,
  label: string,
): Promise<{ deviceCode: string; userCode: string; expiresAt: number }> {
  const now = Date.now();
  await db.prepare('DELETE FROM command_line_logins WHERE expires_at <= ?').bind(now).run();
  const deviceCode = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const code = userCode();
  const expiresAt = now + LOGIN_LIFETIME_MS;
  await db
    .prepare(
      `INSERT INTO command_line_logins (id, device_code_hash, user_code, label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), await sha256Hex(deviceCode), code, label, now, expiresAt)
    .run();
  return { deviceCode, userCode: code, expiresAt };
}

/** What a sign-in waiting for approval is for, so the person sees what they approve; null when there is none. */
export async function pendingCommandLineLogin(db: D1Database, code: string): Promise<{ label: string } | null> {
  return db
    .prepare('SELECT label FROM command_line_logins WHERE user_code = ? AND user_id IS NULL AND expires_at > ?')
    .bind(normalizeUserCode(code), Date.now())
    .first<{ label: string }>();
}

/** The person approves the sign-in showing `code`; whether there was one waiting. */
export async function approveCommandLineLogin(db: D1Database, code: string, userId: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE command_line_logins SET user_id = ? WHERE user_code = ? AND user_id IS NULL AND expires_at > ?')
    .bind(userId, normalizeUserCode(code), Date.now())
    .run();
  return result.meta.changes > 0;
}

/**
 * The command line asks whether its sign-in was approved: once it was, its token, made now and handed over once
 * (the sign-in is removed with it); `pending` while it waits; `expired` when there's none to wait for.
 */
export async function pollCommandLineLogin(
  db: D1Database,
  deviceCode: string,
): Promise<{ token: string; userId: string } | 'pending' | 'expired'> {
  const hash = await sha256Hex(deviceCode);
  const row = await db
    .prepare('SELECT id, label, user_id FROM command_line_logins WHERE device_code_hash = ? AND expires_at > ?')
    .bind(hash, Date.now())
    .first<{ id: string; label: string; user_id: string | null }>();
  if (!row) {
    return 'expired';
  }
  if (!row.user_id) {
    return 'pending';
  }
  // Taken once: only the poll that removes it makes the token.
  const taken = await db.prepare('DELETE FROM command_line_logins WHERE id = ?').bind(row.id).run();
  if (taken.meta.changes === 0) {
    return 'expired';
  }
  const { token } = await createCommandLineToken(db, row.user_id, row.label);
  return { token, userId: row.user_id };
}
