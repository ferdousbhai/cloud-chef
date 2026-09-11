/**
 * Read-only operational report for the Ghostbuild platform.
 *
 * This replaces the deployed `admin.ghostbuild.dev` dashboard. It reads the production
 * control-plane D1 database and the control-plane Worker's own invocation analytics through the
 * operator's own Wrangler authentication, so there is nothing to deploy and no secret to hold.
 * Every statement it issues is a `SELECT` and every API call it makes is a read.
 *
 * The primary reader is a coding agent, so the report leads with what is wrong, says which
 * parts it could not read instead of printing a reassuring zero, and offers `--json`.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DATABASE_NAME = 'ghostbuild';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_BUNDLE_PATH = resolve(ROOT, 'app/generated/user-workspace-runtime.generated.ts');
const RUNTIME_SHA_PATTERN = /USER_WORKSPACE_RUNTIME_SHA256 = "([a-f0-9]{64})"/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** How many connected accounts one report inspects. */
const RUNTIME_ROW_LIMIT = 200;

/** The control-plane Worker this repository deploys, as named in `wrangler.jsonc`. */
const WORKER_SCRIPT_NAME = 'ghostbuild';
/** How far back the invocation read looks. */
const WORKER_INVOCATION_WINDOW_MS = DAY;
/**
 * Invocation outcomes that are not the Worker failing: it answered, or the caller went away.
 * The list is deliberately the benign one rather than the failing one, so an outcome Cloudflare
 * adds later is counted as a fault and named, instead of quietly dropping out of the total.
 */
const BENIGN_INVOCATION_STATUSES = ['success', 'clientDisconnected', 'canceled', 'responseStreamDisconnected'];
/** A fault share at or above this is an outage rather than the occasional bad request. */
const INVOCATION_FAULT_ERROR_RATE = 0.01;
/** Below this the adaptive dataset counted every invocation, so calling the counts sampled would mislead. */
const INVOCATION_SAMPLE_NOTE_THRESHOLD = 1.05;

/** Worst first. A report whose headline is "healthy" must have nothing above `ok` in it. */
const STATUS_RANK = { error: 3, attention: 2, unknown: 1, ok: 0 };

/**
 * Render a timestamp as prose relative to `now`.
 *
 * The dashboard this replaces printed "0m ago" for anything under 90 seconds and "-5m ago"
 * whenever a stored clock ran ahead of the reader's. Both cases are named here instead:
 * sub-minute is "just now", a small lead is treated as clock skew, and a large lead is
 * reported as the future value it is.
 *
 * @param {unknown} value epoch milliseconds, or anything else
 * @param {number} now epoch milliseconds
 * @param {{ missing?: string | null }} [options] what to say when there is no usable timestamp
 * @returns {string | null}
 */
export function formatRelativeTime(value, now, options = {}) {
  // `?? 'never'` would swallow a caller that deliberately wants `null` for "no timestamp".
  const missing = 'missing' in options ? options.missing : 'never';
  if (!Number.isFinite(value) || !Number.isFinite(now) || value <= 0) {
    return missing;
  }
  const elapsed = now - value;
  if (elapsed >= 0) {
    return elapsed < MINUTE ? 'just now' : `${formatDuration(elapsed)} ago`;
  }
  // A stored clock a little ahead of this one is skew, not a scheduled future event.
  const ahead = -elapsed;
  return ahead < MINUTE ? 'just now' : `${formatDuration(ahead)} from now`;
}

/**
 * A non-negative span as a single coarse unit. Deliberately stops at days: "1mo" and "1m"
 * are one glance apart, and no operational answer here needs months.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return 'an unknown span';
  }
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(ms / HOUR);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(ms / DAY)}d`;
}

/** Collapse whitespace and bound a provider string before it reaches a terminal. */
export function bounded(value, limit = 240) {
  return String(value).replaceAll(/\s+/g, ' ').trim().slice(0, limit);
}

/** A generation or content hash is unreadable in full and unambiguous at twelve characters. */
export function shortHash(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 12) : 'unknown';
}

function number(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function describeValue(value) {
  if (value === null) {
    return 'null';
  }
  return typeof value === 'string' ? `the string "${bounded(value, 40)}"` : `the ${typeof value} ${bounded(value, 40)}`;
}

/**
 * One connected account's workspace runtime, as a status and a sentence.
 *
 * @param {Record<string, unknown>} row
 * @param {{ now: number; desiredRuntimeVersion: string | null }} context
 */
export function describeWorkspaceRuntime(row, { now, desiredRuntimeVersion }) {
  const who = typeof row.email === 'string' && row.email ? row.email : 'an unidentified account';
  const at = Number.isFinite(row.updated_at) ? Number(row.updated_at) : null;
  const when = formatRelativeTime(at, now, { missing: 'at an unrecorded time' });
  const version = typeof row.runtime_version === 'string' ? row.runtime_version : null;
  const base = { email: who, status: row.status ?? null, runtimeVersion: version, at };

  if (!row.status) {
    return { ...base, level: 'attention', sentence: `${who} has an active connection but no workspace runtime yet.` };
  }
  if (desiredRuntimeVersion === null) {
    return {
      ...base,
      level: 'unknown',
      sentence: `${who} is ready on runtime ${shortHash(version)}; there is no local build to compare it against.`,
    };
  }
  if (version !== desiredRuntimeVersion) {
    return {
      ...base,
      level: 'attention',
      sentence: `${who} is on runtime ${shortHash(version)}, not this checkout's ${shortHash(desiredRuntimeVersion)} (updated ${when}).`,
    };
  }
  return { ...base, level: 'ok', sentence: `${who} is on the current workspace runtime (updated ${when}).` };
}

/**
 * Connection statuses rolled into one health classification.
 * @param {ReadonlyArray<Record<string, unknown>>} rows grouped `status`/`count` rows
 */
export function classifyConnections(rows) {
  const byStatus = {};
  let total = 0;
  let missingCredential = 0;
  for (const row of rows) {
    const status = String(row.status ?? 'unknown');
    const count = number(row.count);
    byStatus[status] = (byStatus[status] ?? 0) + count;
    total += count;
    if (status === 'active') {
      missingCredential += number(row.missing_credential);
    }
  }
  const active = byStatus.active ?? 0;
  const broken = (byStatus.revoked ?? 0) + (byStatus.error ?? 0);
  const linking = byStatus.linking ?? 0;

  if (total === 0) {
    return {
      level: 'attention',
      sentence: 'No Cloudflare account is connected, so nothing can be built.',
      detail: { total, active, byStatus, missingCredential },
    };
  }
  const trailer = [
    broken > 0 ? `${broken} revoked or errored` : null,
    linking > 0 ? `${linking} still linking` : null,
    missingCredential > 0 ? `${missingCredential} active without a stored credential` : null,
  ].filter(Boolean);
  const level = broken > 0 || missingCredential > 0 ? 'error' : linking > 0 ? 'attention' : 'ok';
  const sentence =
    trailer.length > 0
      ? `${active} of ${total} Cloudflare ${plural(total, 'connection')} ${plural(active, 'is', 'are')} active; ${trailer.join(', ')}.`
      : `All ${total} Cloudflare ${plural(total, 'connection')} ${plural(total, 'is', 'are')} active.`;
  return { level, sentence, detail: { total, active, byStatus, missingCredential } };
}

/**
 * Strict read of one `workersInvocationsAdaptive` group. The analytics schema is not ours, so a
 * shape that does not match is reported as drift rather than counted as zero invocations.
 * @param {Record<string, unknown>} row
 */
function readInvocationGroup(row) {
  const status = row?.dimensions?.status;
  if (typeof status !== 'string' || status === '') {
    throw new Error('workersInvocationsAdaptive groups have no `dimensions.status`, so this report cannot read them.');
  }
  const requests = row?.sum?.requests;
  if (!Number.isFinite(requests)) {
    throw new Error(`workersInvocationsAdaptive.sum.requests holds ${describeValue(requests)}, not a number.`);
  }
  const sampleInterval = row?.avg?.sampleInterval;
  return {
    status,
    requests: Number(requests),
    sampleInterval: Number.isFinite(sampleInterval) ? Number(sampleInterval) : null,
  };
}

/**
 * The control-plane Worker's own invocations, as a status and a sentence.
 *
 * This is the one part of the platform Ghostbuild can observe without asking anybody for
 * anything: `ghostbuild` is its own Worker in its own account. It answers "is it serving, and is
 * it throwing" from invocation outcomes. It deliberately does not claim to answer "what did it
 * throw" — the message text lives in Workers Logs, which needs an observability grant this
 * credential does not carry, so the sentence says that out loud rather than implying the counts
 * are the whole story.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows one group per invocation status
 * @param {{ windowMs?: number }} [options]
 */
export function describeWorkerInvocations(rows, { windowMs = WORKER_INVOCATION_WINDOW_MS } = {}) {
  const window = formatDuration(windowMs);
  const groups = rows.map((row) => readInvocationGroup(row));
  const byStatus = {};
  for (const group of groups) {
    byStatus[group.status] = (byStatus[group.status] ?? 0) + group.requests;
  }
  const total = groups.reduce((sum, group) => sum + group.requests, 0);
  const faults = groups.filter((group) => !BENIGN_INVOCATION_STATUSES.includes(group.status));
  const faulted = faults.reduce((sum, group) => sum + group.requests, 0);
  // The interval is per group, and the largest one bounds how coarse the whole count is.
  const sampleInterval = groups.reduce(
    (max, group) => (group.sampleInterval !== null && group.sampleInterval > max ? group.sampleInterval : max),
    0,
  );
  const sampled = sampleInterval >= INVOCATION_SAMPLE_NOTE_THRESHOLD;
  const detail = {
    script: WORKER_SCRIPT_NAME,
    windowMs,
    invocations: total,
    faulted,
    byStatus,
    sampleInterval: sampleInterval || null,
    // Named here because the analytics answer and the logs answer are different questions, and
    // an operator reading "no faults" should know which one they were given.
    logsAvailable: false,
  };

  if (groups.length === 0) {
    return {
      level: 'attention',
      // Zero groups is not zero traffic: this Worker serves ghostbuild.dev and fires a cron
      // every 15 minutes, so an empty window means it stopped or the dataset is behind.
      sentence: `${WORKER_SCRIPT_NAME} recorded no invocations at all in the last ${window}, though it serves ghostbuild.dev and runs a cron every 15 minutes.`,
      detail,
    };
  }

  const note = sampled ? ` Counts are extrapolated from roughly 1 invocation in ${sampleInterval.toFixed(1)}.` : '';
  if (faulted === 0) {
    return {
      level: 'ok',
      sentence: `${WORKER_SCRIPT_NAME} served ${total} ${plural(total, 'invocation')} in the last ${window} and none of them failed inside the Worker.${note}`,
      detail,
    };
  }
  const named = faults
    .slice()
    .sort((a, b) => b.requests - a.requests)
    .map((group) => `${group.status} ${group.requests}`)
    .join(', ');
  return {
    level: faulted >= total * INVOCATION_FAULT_ERROR_RATE ? 'error' : 'attention',
    sentence: `${WORKER_SCRIPT_NAME} failed inside the Worker on ${faulted} of ${total} ${plural(total, 'invocation')} in the last ${window} (${named}).${note} Workers Logs holds the exception text, and reading it needs an observability grant this credential does not carry.`,
    detail,
  };
}

/**
 * The statements read in one batch. They target tables that have existed since the first
 * migration, so a failure here means Wrangler or the network, not a schema gap.
 * @param {number} now
 */
export function coreStatements(now) {
  return [
    `SELECT COUNT(*) AS total,
        SUM(CASE WHEN createdAt >= ${now - WEEK} THEN 1 ELSE 0 END) AS joined_this_week,
        SUM(CASE WHEN createdAt >= ${now - 2 * WEEK} AND createdAt < ${now - WEEK} THEN 1 ELSE 0 END) AS joined_last_week
      FROM "user"`,
    `SELECT status, COUNT(*) AS count,
        SUM(CASE WHEN credential_handle IS NULL THEN 1 ELSE 0 END) AS missing_credential
      FROM cloudflare_connections GROUP BY status`,
    `SELECT COUNT(*) AS unexpired FROM cloudflare_auth_sessions WHERE expires_at > ${now}`,
    `SELECT users.email AS email, runtimes.status AS status, runtimes.runtime_version AS runtime_version,
        runtimes.updated_at AS updated_at
      FROM "user" AS users
      JOIN cloudflare_connections AS connections ON connections.user_id = users.id
      LEFT JOIN user_computer_runtimes AS runtimes ON runtimes.user_id = users.id
      WHERE connections.status = 'active'
      ORDER BY users.createdAt
      LIMIT ${RUNTIME_ROW_LIMIT}`,
  ];
}

/**
 * Run read-only SQL against production D1 as the authenticated operator.
 *
 * @param {string} sql one or more `;`-separated SELECT statements
 * @param {{ run?: typeof execFileAsync }} [options]
 * @returns {Promise<Array<Array<Record<string, unknown>>>>} rows per statement
 */
export async function queryProduction(sql, { run = execFileAsync } = {}) {
  let stdout;
  try {
    ({ stdout } = await run(
      'pnpm',
      ['exec', 'wrangler', 'd1', 'execute', DATABASE_NAME, '--remote', '--json', '--command', sql],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
    ));
  } catch (error) {
    throw new Error(describeWranglerFailure(error));
  }
  return parseD1Response(stdout);
}

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

/**
 * One day of the control-plane Worker's invocations, grouped by outcome.
 *
 * `workersInvocationsAdaptive` is the Workers analytics dataset, not Workers Logs. It is read
 * here because it is what the operator's existing Wrangler grant can already see: the same
 * credential is refused by `workers/observability/telemetry/query`, which needs an observability
 * permission Wrangler's OAuth grant does not include.
 */
export const WORKER_INVOCATIONS_QUERY = `query GhostbuildInvocations($account: string!, $script: string!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(
        limit: 100
        filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }
      ) {
        dimensions { status }
        sum { requests }
        avg { sampleInterval }
      }
    }
  }
}`;

/**
 * The account holding the control-plane Worker.
 *
 * Wrangler picks an account per command from the same two places, so this follows it rather than
 * inventing a third: `CLOUDFLARE_ACCOUNT_ID` wins, and otherwise a single authenticated account
 * is unambiguous. More than one is a question only the operator can answer, so it is asked
 * instead of guessed.
 *
 * @param {{ run: typeof execFileAsync; env: Record<string, string | undefined> }} options
 * @returns {Promise<string>}
 */
async function resolveAnalyticsAccount({ run, env }) {
  const configured = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (configured) {
    return configured;
  }
  let stdout;
  try {
    ({ stdout } = await run('pnpm', ['exec', 'wrangler', 'whoami', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    }));
  } catch (error) {
    throw new Error(describeWranglerFailure(error));
  }
  const accounts = (extractJson(stdout)?.accounts ?? []).filter((account) => typeof account?.id === 'string');
  if (accounts.length === 1) {
    return accounts[0].id;
  }
  if (accounts.length === 0) {
    throw new Error('Wrangler is not authenticated against any Cloudflare account, so the Worker cannot be read.');
  }
  const names = accounts.map((account) => account.name ?? account.id).join(', ');
  throw new Error(
    `Wrangler is authenticated against ${accounts.length} accounts (${names}); set CLOUDFLARE_ACCOUNT_ID to say which one runs the control-plane Worker.`,
  );
}

/**
 * The operator's own Cloudflare credential, borrowed for one read and never stored.
 *
 * `wrangler auth token` is the supported accessor for whatever Wrangler is already using —
 * an API token from the environment, an OAuth token from the login state, or a global API key —
 * so this keeps the report's posture intact: no secret of its own, no secret to deploy.
 *
 * @param {{ run: typeof execFileAsync }} options
 * @returns {Promise<Record<string, string>>} request headers
 */
async function readOperatorCredential({ run }) {
  let stdout;
  try {
    ({ stdout } = await run('pnpm', ['exec', 'wrangler', 'auth', 'token', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    }));
  } catch (error) {
    // This command writes the credential itself to stdout, so only stderr is ever quoted back.
    const reason = bounded(error?.stderr, 200) || 'Wrangler gave no reason.';
    throw new Error(`Wrangler could not produce a credential for the Worker read: ${reason}`);
  }
  const credential = extractJson(stdout);
  if (credential?.type === 'api_key') {
    if (typeof credential.key !== 'string' || typeof credential.email !== 'string') {
      throw new Error('Wrangler reported a global API key without an email, which cannot be used to authenticate.');
    }
    return { 'x-auth-key': credential.key, 'x-auth-email': credential.email };
  }
  if (typeof credential?.token !== 'string' || credential.token === '') {
    throw new Error('Wrangler returned no usable credential; run `wrangler login`.');
  }
  return { authorization: `Bearer ${credential.token}` };
}

/**
 * Read the control-plane Worker's invocations as the authenticated operator.
 *
 * @param {{
 *   now?: number;
 *   run?: typeof execFileAsync;
 *   fetchImpl?: typeof fetch;
 *   env?: Record<string, string | undefined>;
 * }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>} one group per invocation status
 */
export async function readWorkerInvocations({
  now = Date.now(),
  run = execFileAsync,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const [account, headers] = await Promise.all([
    resolveAnalyticsAccount({ run, env }),
    readOperatorCredential({ run }),
  ]);
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: WORKER_INVOCATIONS_QUERY,
      variables: {
        account,
        script: WORKER_SCRIPT_NAME,
        from: new Date(now - WORKER_INVOCATION_WINDOW_MS).toISOString(),
        to: new Date(now).toISOString(),
      },
    }),
  });
  return readInvocationGroups(response.ok ? await response.json().catch(() => null) : null, response.status);
}

/**
 * The rows out of one GraphQL answer, or the reason there are none.
 *
 * GraphQL answers a refused read with HTTP 200 and an `errors` array, so the envelope is checked
 * before the payload: an account this credential may not read must not arrive as an empty window.
 *
 * @param {unknown} payload
 * @param {number} httpStatus
 */
export function readInvocationGroups(payload, httpStatus) {
  if (payload === null) {
    throw new Error(`Cloudflare analytics answered HTTP ${httpStatus} with no readable body.`);
  }
  const messages = (Array.isArray(payload?.errors) ? payload.errors : [])
    .map((entry) => entry?.message)
    .filter((message) => typeof message === 'string');
  if (messages.length > 0) {
    throw new Error(bounded(`Cloudflare analytics refused the read: ${messages.join('; ')}`, 400));
  }
  const groups = payload?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(groups)) {
    throw new Error('Cloudflare analytics returned no `workersInvocationsAdaptive` result for this account.');
  }
  return groups;
}

/** Turn a failed `wrangler d1 execute --json` into the one sentence an operator can act on. */
export function describeWranglerFailure(error) {
  const output = [error?.stdout, error?.stderr].filter((value) => typeof value === 'string').join('\n');
  const envelope = extractJson(output);
  const notes = Array.isArray(envelope?.error?.notes)
    ? envelope.error.notes.map((note) => note?.text).filter((text) => typeof text === 'string')
    : [];
  const message = [envelope?.error?.text, ...notes].filter(Boolean).join(' ');
  if (message) {
    return bounded(notes.length > 0 ? notes.join('; ') : message, 400);
  }
  const raw = bounded(output, 400);
  if (raw) {
    return raw;
  }
  return bounded(error?.message ?? 'Wrangler produced no output.', 400);
}

/** `wrangler --json` returns one envelope per statement; this keeps only the rows. */
export function parseD1Response(stdout) {
  const parsed = extractJson(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('Wrangler did not return a D1 result array.');
  }
  return parsed.map((result) => (Array.isArray(result?.results) ? result.results : []));
}

/** Wrangler occasionally prefixes its JSON with a blank line or a banner. */
function extractJson(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const start = text.search(/[[{]/);
  if (start < 0) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/**
 * The workspace runtime build this checkout would provision, used as the staleness reference.
 * Generated by `pnpm run generate:artifacts`, so it can legitimately be absent.
 */
export async function readDesiredRuntimeVersion(readFileImpl = readFile) {
  try {
    const source = await readFileImpl(RUNTIME_BUNDLE_PATH, 'utf8');
    return RUNTIME_SHA_PATTERN.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the platform and build the report.
 *
 * @param {{
 *   query: (sql: string) => Promise<Array<Array<Record<string, unknown>>>>;
 *   readInvocations?: (options: { now: number }) => Promise<Array<Record<string, unknown>>>;
 *   now?: number;
 *   desiredRuntimeVersion?: string | null;
 * }} options
 */
export async function collectReport({
  query,
  // Not optional in effect: a caller that supplies no reader gets a check that says so, because
  // a Worker nobody looked at must not be absent from a report that claims to cover the platform.
  readInvocations = () => {
    throw new Error('No Workers analytics reader was supplied to this report.');
  },
  now = Date.now(),
  desiredRuntimeVersion = null,
}) {
  const statements = coreStatements(now);
  const [core, invocations] = await Promise.all([
    attempt(() => query(statements.join(';\n'))),
    attempt(() => readInvocations({ now })),
  ]);
  const checks = [
    buildWorkerCheck(invocations, now),
    buildAccountsCheck(core),
    buildRuntimesCheck(core, { now, desiredRuntimeVersion }),
    buildUsersCheck(core),
    buildSessionsCheck(core),
  ];

  const status = checks.reduce(
    (worst, check) => (STATUS_RANK[check.status] > STATUS_RANK[worst] ? check.status : worst),
    'ok',
  );
  return {
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    database: DATABASE_NAME,
    source: 'wrangler d1 execute --remote (read-only)',
    desiredRuntimeVersion,
    controlPlaneReadable: core.ok,
    status,
    headline: headlineFor(checks, core),
    checks,
  };
}

/** Run one read and record why it failed instead of letting the failure look like emptiness. */
async function attempt(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A row this report cannot read is a third thing: the table is there and the query worked, but
 * what came back is not what the schema declares. Marked so the check says that rather than
 * blaming the connection, and so it can never be mistaken for an empty table.
 */
function schemaFailure(error) {
  return {
    ok: false,
    schemaMismatch: true,
    error: error instanceof Error ? error.message : String(error),
  };
}

function unknownCheck(id, title, attemptResult, hint) {
  const missingTable = /no such table:\s*([\w.]+)/i.exec(attemptResult.error ?? '')?.[1] ?? null;
  const schemaMismatch = attemptResult.schemaMismatch === true;
  return {
    id,
    title,
    status: 'unknown',
    sentence: missingTable
      ? `\`${missingTable}\` does not exist in production yet, so this is unknown.`
      : schemaMismatch
        ? `This could not be read: ${attemptResult.error} The schema this report expects and the one production holds have diverged.`
        : `This could not be read: ${attemptResult.error}`,
    at: null,
    relative: null,
    detail: { error: attemptResult.error, missingTable, schemaMismatch, hint: hint ?? null },
  };
}

function check(id, title, status, sentence, { at = null, now = null, detail = {} } = {}) {
  return {
    id,
    title,
    status,
    sentence,
    at,
    relative: now === null ? null : formatRelativeTime(at, now, { missing: null }),
    detail,
  };
}

/** The hint every unreadable Worker check carries, since the read is not a D1 one. */
const WORKER_CHECK_HINT = `Read from the Workers analytics GraphQL API for the "${WORKER_SCRIPT_NAME}" script with the operator's own Wrangler authentication.`;

function buildWorkerCheck(invocationsAttempt, now) {
  if (!invocationsAttempt.ok) {
    return unknownCheck('control-plane-worker', 'Control-plane Worker', invocationsAttempt, WORKER_CHECK_HINT);
  }
  let described;
  try {
    described = describeWorkerInvocations(invocationsAttempt.value);
  } catch (error) {
    return unknownCheck('control-plane-worker', 'Control-plane Worker', schemaFailure(error), WORKER_CHECK_HINT);
  }
  return check('control-plane-worker', 'Control-plane Worker', described.level, described.sentence, {
    now,
    detail: described.detail,
  });
}

function buildUsersCheck(core) {
  if (!core.ok) {
    return unknownCheck('users', 'Users', core);
  }
  const row = core.value[0]?.[0] ?? {};
  const total = number(row.total);
  const thisWeek = number(row.joined_this_week);
  const lastWeek = number(row.joined_last_week);
  const delta = thisWeek - lastWeek;
  return check(
    'users',
    'Users',
    'ok',
    `${total} ${plural(total, 'user')} in total; ${thisWeek} joined in the last 7 days (${delta >= 0 ? '+' : ''}${delta} versus the 7 days before).`,
    { detail: { total, joinedThisWeek: thisWeek, joinedPreviousWeek: lastWeek, delta } },
  );
}

function buildAccountsCheck(core) {
  if (!core.ok) {
    return unknownCheck('cloudflare-accounts', 'Cloudflare accounts', core);
  }
  const { level, sentence, detail } = classifyConnections(core.value[1] ?? []);
  return check('cloudflare-accounts', 'Cloudflare accounts', level, sentence, { detail });
}

function buildSessionsCheck(core) {
  if (!core.ok) {
    return unknownCheck('sessions', 'Sign-in sessions', core);
  }
  const unexpired = number(core.value[2]?.[0]?.unexpired);
  return check(
    'sessions',
    'Sign-in sessions',
    'ok',
    `${unexpired} unexpired sign-in ${plural(unexpired, 'session')}.`,
    { detail: { unexpired } },
  );
}

function buildRuntimesCheck(core, { now, desiredRuntimeVersion }) {
  if (!core.ok) {
    return unknownCheck('workspace-runtimes', 'Workspace runtimes', core);
  }
  const rows = core.value[3] ?? [];
  const described = rows.map((row) => describeWorkspaceRuntime(row, { now, desiredRuntimeVersion }));
  const level = described.reduce(
    (worst, entry) => (STATUS_RANK[entry.level] > STATUS_RANK[worst] ? entry.level : worst),
    'ok',
  );
  const healthy = described.filter((entry) => entry.level === 'ok').length;
  const newest = described.reduce((max, entry) => (entry.at && entry.at > max ? entry.at : max), 0);
  const sentence =
    rows.length === 0
      ? 'No connected account has a workspace runtime to report on.'
      : desiredRuntimeVersion === null
        ? `${rows.length} connected ${plural(rows.length, 'runtime')}; no local runtime build exists to measure staleness against (run \`pnpm run generate:artifacts\`).`
        : `${healthy} of ${rows.length} workspace ${plural(rows.length, 'runtime')} ${plural(healthy, 'is', 'are')} on this checkout's current build ${shortHash(desiredRuntimeVersion)}.`;
  return check('workspace-runtimes', 'Workspace runtimes', level, sentence, {
    at: newest || null,
    now,
    detail: {
      connected: rows.length,
      current: healthy,
      desiredRuntimeVersion,
      entries: described,
    },
  });
}

/** One line that is true whether the platform is fine, broken, or partly unreadable. */
export function headlineFor(checks, core) {
  if (!core.ok) {
    return `The control plane could not be read: ${core.error}`;
  }
  const counts = { error: 0, attention: 0, unknown: 0, ok: 0 };
  for (const item of checks) {
    counts[item.status] += 1;
  }
  if (counts.error === 0 && counts.attention === 0 && counts.unknown === 0) {
    return `Everything is healthy: all ${counts.ok} checks passed.`;
  }
  // Every clause names its own noun, so any one of them can lead the sentence.
  const parts = [
    counts.error > 0 ? `${countOfChecks(counts.error)} ${plural(counts.error, 'is', 'are')} broken` : null,
    counts.attention > 0
      ? `${countOfChecks(counts.attention)} ${plural(counts.attention, 'needs', 'need')} attention`
      : null,
    counts.unknown > 0 ? `${countOfChecks(counts.unknown)} could not be read` : null,
  ].filter(Boolean);
  return `${parts.join(', ')}.`;
}

function countOfChecks(count) {
  return `${count} ${plural(count, 'check')}`;
}

const GROUPS = [
  { status: 'error', heading: 'BROKEN' },
  { status: 'attention', heading: 'NEEDS ATTENTION' },
  { status: 'unknown', heading: 'COULD NOT BE READ' },
  { status: 'ok', heading: 'HEALTHY' },
];

/**
 * The default terminal report. Broken first, healthy last, no legend required.
 * @param {ReturnType<typeof collectReport> extends Promise<infer T> ? T : never} report
 */
export function renderReport(report) {
  const lines = [
    `Ghostbuild platform — ${report.generatedAtIso.replace('T', ' ').slice(0, 16)} UTC`,
    `read-only from control-plane D1 "${report.database}" and Workers analytics, via wrangler`,
    '',
    report.headline,
  ];
  for (const { status, heading } of GROUPS) {
    const group = report.checks.filter((item) => item.status === status);
    if (group.length === 0) {
      continue;
    }
    lines.push('', heading);
    for (const item of group) {
      // The stamp only earns its place when the sentence does not already carry the same age.
      const stamp = item.relative && !item.sentence.includes(item.relative) ? ` (${item.relative})` : '';
      if (status === 'ok') {
        // Nothing to do about these, so they get one line each and stay out of the way.
        lines.push(`  ${item.title} — ${item.sentence}${stamp}`);
        continue;
      }
      lines.push(`  ${item.title}${stamp}`);
      lines.push(`    ${item.sentence}`);
      for (const extra of expandCheck(item)) {
        lines.push(`      - ${extra}`);
      }
    }
  }
  lines.push('', 'Machine-readable: pnpm run ops:json');
  return lines.join('\n');
}

/** Per-entry detail worth printing, and only for the entries that are what is wrong. */
function expandCheck(item) {
  if (item.status === 'ok' || !Array.isArray(item.detail.entries)) {
    return [];
  }
  return item.detail.entries.filter((entry) => entry.level !== 'ok').map((entry) => entry.sentence);
}

const USAGE = `Usage: pnpm run ops [-- --json]

Reports the operational state of the Ghostbuild platform by reading production
control-plane D1 and the control-plane Worker's own invocation analytics with the
operator's own Wrangler authentication. Read-only.

  --json   emit the structured report instead of the terminal one
  --help   show this message

Exit status is 0 whenever a report was produced, including an unhealthy one, and
1 when the control plane could not be read at all.`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const report = await collectReport({
    query: (sql) => queryProduction(sql),
    readInvocations: ({ now }) => readWorkerInvocations({ now }),
    desiredRuntimeVersion: await readDesiredRuntimeVersion(),
  });
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
  return report.controlPlaneReadable ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
