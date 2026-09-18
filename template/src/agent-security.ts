const AGENT_SESSION_COOKIE = "__Host-cloudchef_agent_session";
const AGENT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DAILY_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_INFERENCE_LIMIT = 10;
const GLOBAL_INFERENCE_LIMIT = 60;
export const GLOBAL_DAILY_INFERENCE_LIMIT = 500;
const SESSION_CREATION_LIMIT = 10;
const GLOBAL_SESSION_CREATION_LIMIT = 100;
export const GLOBAL_DAILY_SESSION_CREATION_LIMIT = 2_000;
const AGENT_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_EXPIRED_SESSION_DELETES = 5_000;
const MAX_STALE_RATE_LIMIT_DELETES = 10_000;

type AgentSessionRow = { agent_name: string; expires_at: number };

export type AgentSession = { agentName: string; expiresAt: number };

export type InferenceBudget =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function handleAgentSessionBootstrap(
  request: Request,
  db: D1Database,
  now = Date.now(),
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin !== new URL(request.url).origin) {
    return new Response("Forbidden", { status: 403 });
  }
  if (await resolveAgentSession(request, db, now)) {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const clientAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const clientKey = await sha256(clientAddress);
  const clientAllowed = await consumeRateLimit(
    db,
    `session-create:client:${clientKey}`,
    SESSION_CREATION_LIMIT,
    now,
  );
  if (!clientAllowed) {
    return rateLimitedResponse();
  }
  const globalAllowed = await consumeRateLimit(
    db,
    "session-create:global",
    GLOBAL_SESSION_CREATION_LIMIT,
    now,
  );
  if (!globalAllowed) {
    return rateLimitedResponse();
  }
  const dailyAllowed = await consumeRateLimit(
    db,
    "session-create:global:daily",
    GLOBAL_DAILY_SESSION_CREATION_LIMIT,
    now,
    DAILY_RATE_LIMIT_WINDOW_MS,
  );
  if (!dailyAllowed) {
    return rateLimitedResponse(
      retryAfterSeconds(now, DAILY_RATE_LIMIT_WINDOW_MS),
    );
  }
  const token = randomToken();
  const tokenHash = await sha256(token);
  const agentName = `session-${crypto.randomUUID()}`;
  const expiresAt = now + AGENT_SESSION_TTL_MS;
  await db
    .prepare(
      "INSERT INTO app_agent_sessions (token_hash, agent_name, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(tokenHash, agentName, expiresAt, now)
    .run();

  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": agentSessionCookie(token),
      "Cache-Control": "no-store",
    },
  });
}

export async function resolveAgentSession(
  request: Request,
  db: D1Database,
  now = Date.now(),
): Promise<AgentSession | null> {
  const token = readCookie(request.headers.get("Cookie"), AGENT_SESSION_COOKIE);
  if (!token || !AGENT_SESSION_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const row = await db
    .prepare(
      "SELECT agent_name, expires_at FROM app_agent_sessions WHERE token_hash = ?1 AND expires_at > ?2 LIMIT 1",
    )
    .bind(await sha256(token), now)
    .first<AgentSessionRow>();
  return row ? { agentName: row.agent_name, expiresAt: row.expires_at } : null;
}

export async function consumeAppAgentInferenceBudget(
  db: D1Database,
  agentName: string,
  now = Date.now(),
): Promise<InferenceBudget> {
  const sessionAllowed = await consumeRateLimit(
    db,
    `inference:session:${agentName}`,
    SESSION_INFERENCE_LIMIT,
    now,
  );
  if (!sessionAllowed) {
    return inferenceLimitExceeded(now);
  }
  const globalAllowed = await consumeRateLimit(
    db,
    "inference:global",
    GLOBAL_INFERENCE_LIMIT,
    now,
  );
  if (!globalAllowed) {
    return inferenceLimitExceeded(now, RATE_LIMIT_WINDOW_MS);
  }
  const dailyAllowed = await consumeRateLimit(
    db,
    "inference:global:daily",
    GLOBAL_DAILY_INFERENCE_LIMIT,
    now,
    DAILY_RATE_LIMIT_WINDOW_MS,
  );
  return dailyAllowed
    ? { allowed: true }
    : inferenceLimitExceeded(now, DAILY_RATE_LIMIT_WINDOW_MS);
}

function inferenceLimitExceeded(
  now: number,
  windowMs = RATE_LIMIT_WINDOW_MS,
): InferenceBudget {
  return {
    allowed: false,
    retryAfterSeconds: retryAfterSeconds(now, windowMs),
  };
}

function retryAfterSeconds(now: number, windowMs: number): number {
  const elapsed = now % windowMs;
  return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
}

async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  now: number,
  windowMs = RATE_LIMIT_WINDOW_MS,
): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO app_agent_rate_limits (bucket, window_start, count)
       VALUES (?1, ?2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  return Boolean(row && row.count <= limit);
}

export async function cleanupExpiredAgentSecurityState(
  db: D1Database,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM app_agent_sessions
       WHERE rowid IN (
         SELECT rowid FROM app_agent_sessions
         WHERE expires_at <= ?1
         ORDER BY expires_at
         LIMIT ?2
       )`,
    )
    .bind(now, MAX_EXPIRED_SESSION_DELETES)
    .run();
  await db
    .prepare(
      `DELETE FROM app_agent_rate_limits
       WHERE rowid IN (
         SELECT rowid FROM app_agent_rate_limits
         WHERE window_start < ?1
         ORDER BY window_start
         LIMIT ?2
       )`,
    )
    .bind(now - DAILY_RATE_LIMIT_WINDOW_MS, MAX_STALE_RATE_LIMIT_DELETES)
    .run();
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function agentSessionCookie(token: string): string {
  return `${AGENT_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(AGENT_SESSION_TTL_MS / 1000)}`;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function rateLimitedResponse(retryAfter = 60): Response {
  return Response.json(
    { error: "Too many agent sessions. Try again later." },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-store",
      },
    },
  );
}
