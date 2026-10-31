/**
 * Read-only operational report for the CloudChef platform.
 *
 * This replaces the deployed `admin.cloudchef.build` dashboard. It reads the production
 * control-plane D1 database, the control-plane Worker's own Workers Logs, and the Workers AI
 * catalog through the operator's own `cf` CLI login (`cf auth login`, or `CLOUDFLARE_API_TOKEN`),
 * so there is nothing to deploy and no secret to hold. Every statement it issues is a `SELECT`,
 * every command it runs is a read, and the one log query is a dry run that saves nothing.
 *
 * The primary reader is a coding agent, so the report leads with what is wrong, says which
 * parts it could not read instead of printing a reassuring zero, and offers `--json`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models';
import {
  attempt,
  bounded,
  cfReader,
  DAY,
  execFileAsync,
  extractJson,
  HOUR,
  MINUTE,
  resolveControlPlaneDatabaseId,
  WEEK,
} from './lib/ops-cf.mjs';

const DATABASE_NAME = 'cloudchef';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_BUNDLE_PATH = resolve(ROOT, 'app/generated/user-workspace-runtime.generated.ts');
const RUNTIME_SHA_PATTERN = /USER_WORKSPACE_RUNTIME_SHA256 = "([a-f0-9]{64})"/;
/**
 * The builder model pin, read from the module that declares it rather than copied here. A second
 * copy of the id is exactly the drift this check exists to catch, so it must not be one more.
 */
const WORKERS_AI_MODEL_PATH = resolve(ROOT, 'app/lib/workers-ai-model.ts');
const PINNED_BUILDER_MODEL_PATTERN = /CLOUDFLARE_WORKERS_AI_MODEL = '(@cf\/[^']+)'/;
const BUILDER_CONTEXT_FLOOR_PATTERN = /MINIMUM_BUILDER_MODEL_CONTEXT_TOKENS = ([\d_]+)/;
/**
 * The Workers AI models Pi lists as chat models, from the same Pi catalog the runtime filters on
 * (`app/lib/.server/llm/pi-model-catalog.ts`): a model Pi does not list is never offered, since
 * CloudChef would have to guess its request shape, so it is never a candidate here either.
 * @type {ReadonlySet<string>}
 */
export const PI_WORKERS_AI_MODEL_IDS = new Set(
  Object.values(CLOUDFLARE_WORKERS_AI_MODELS).flatMap((model) =>
    model.api === 'openai-completions' ? [model.id] : [],
  ),
);
/** One page covers the Workers AI text-generation catalog with room to spare. */
const MODEL_CATALOG_PAGE_SIZE = 100;

/** How many connected accounts one report inspects. */
const RUNTIME_ROW_LIMIT = 200;

/** The control-plane Worker this repository deploys, as named in `cloudflare.config.ts`. */
const WORKER_SCRIPT_NAME = 'cloudchef';
/** How far back the invocation read looks. */
const WORKER_INVOCATION_WINDOW_MS = DAY;
/**
 * Invocation outcomes (`$workers.outcome` in Workers Logs) that are not the Worker failing: it
 * answered, or the caller went away. The list is deliberately the benign one rather than the
 * failing one, so an outcome Cloudflare adds later is counted as a fault and named, instead of
 * quietly dropping out of the total.
 */
const BENIGN_INVOCATION_STATUSES = ['ok', 'canceled', 'clientDisconnected', 'responseStreamDisconnected'];
/** The Workers Logs field each invocation's outcome is recorded under. */
const OUTCOME_FIELD = '$workers.outcome';
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
function formatRelativeTime(value, now, options = {}) {
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
function formatDuration(ms) {
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

/** A generation or content hash is unreadable in full and unambiguous at twelve characters. */
function shortHash(value) {
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
function describeWorkspaceRuntime(row, { now, desiredRuntimeVersion }) {
  const person = typeof row.email === 'string' && row.email ? row.email : 'an unidentified account';
  const who = row.organization ? `${person} in ${row.organization}` : person;
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
function classifyConnections(rows) {
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
 * Strict read of one Workers Logs aggregate, one per invocation outcome. The telemetry schema is
 * not ours, so a shape that does not match is reported as drift rather than counted as zero
 * invocations.
 * @param {Record<string, unknown>} row
 */
function readInvocationGroup(row) {
  const groups = Array.isArray(row?.groups) ? row.groups : [];
  const status = groups.find((group) => group?.key === OUTCOME_FIELD)?.value;
  if (typeof status !== 'string' || status === '') {
    throw new Error(`Workers Logs aggregates have no \`${OUTCOME_FIELD}\` group, so this report cannot read them.`);
  }
  const requests = row?.count;
  if (!Number.isFinite(requests)) {
    throw new Error(
      `The Workers Logs count for ${bounded(status, 40)} holds ${describeValue(requests)}, not a number.`,
    );
  }
  const sampleInterval = row?.sampleInterval;
  return {
    status,
    requests: Number(requests),
    sampleInterval: Number.isFinite(sampleInterval) ? Number(sampleInterval) : null,
  };
}

/**
 * The control-plane Worker's own invocations, as a status and a sentence.
 *
 * This is the one part of the platform CloudChef can observe without asking anybody for
 * anything: `cloudchef` is its own Worker in its own account. It answers "is it serving, and is
 * it throwing" from the outcome Workers Logs records for each invocation. Logs are head-sampled
 * (`cloudflare.config.ts`), so the counts are of logged invocations rather than every one, which
 * leaves the fault share, the thing the status is judged on, unchanged.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows one group per invocation status
 * @param {{ windowMs?: number }} [options]
 */
function describeWorkerInvocations(rows, { windowMs = WORKER_INVOCATION_WINDOW_MS } = {}) {
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
    // The counts come from Workers Logs, so the exception text is one query away.
    logsAvailable: true,
  };

  if (groups.length === 0) {
    return {
      level: 'attention',
      // Zero groups is not zero traffic: this Worker serves cloudchef.build and fires a cron
      // every 15 minutes, so an empty window means it stopped or the dataset is behind.
      sentence: `${WORKER_SCRIPT_NAME} recorded no invocations at all in the last ${window}, though it serves cloudchef.build and runs a cron every 15 minutes.`,
      detail,
    };
  }

  const note = sampled ? ` The log query sampled roughly 1 invocation in ${sampleInterval.toFixed(1)}.` : '';
  if (faulted === 0) {
    return {
      level: 'ok',
      sentence: `${WORKER_SCRIPT_NAME} logged ${total} ${plural(total, 'invocation')} in the last ${window} and none of them failed inside the Worker.${note}`,
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
    sentence: `${WORKER_SCRIPT_NAME} failed inside the Worker on ${faulted} of ${total} ${plural(total, 'invocation')} in the last ${window} (${named}).${note} Read the exception text with \`cf o11y telemetry query\` (view \`events\`, filtered on \`${OUTCOME_FIELD}\`).`,
    detail,
  };
}

/**
 * The statements read in one batch. They target tables every applied schema has, so a failure
 * here means the cf CLI, its login, or the network, not a schema gap.
 * @param {number} now
 */
export function coreStatements(now) {
  return [
    `SELECT COUNT(*) AS total,
        SUM(CASE WHEN createdAt >= ${now - WEEK} THEN 1 ELSE 0 END) AS joined_this_week,
        SUM(CASE WHEN createdAt >= ${now - 2 * WEEK} AND createdAt < ${now - WEEK} THEN 1 ELSE 0 END) AS joined_last_week,
        SUM(CASE WHEN managed_space_waitlist_at IS NOT NULL THEN 1 ELSE 0 END) AS managed_space_waitlist
      FROM "user"`,
    `SELECT connections.status AS status, COUNT(*) AS count,
        SUM(CASE WHEN authorizations.credential_handle IS NULL THEN 1 ELSE 0 END) AS missing_credential
      FROM cloudflare_connections AS connections
      LEFT JOIN cloudflare_authorizations AS authorizations ON authorizations.account_id = connections.account_id
      GROUP BY connections.status`,
    `SELECT COUNT(*) AS unexpired FROM cloudflare_auth_sessions WHERE expires_at > ${now}`,
    // A runtime is one person's in one connection: their own, or that of each organization they belong to.
    `SELECT users.email AS email, organizations.name AS organization, runtimes.status AS status,
        runtimes.runtime_version AS runtime_version, runtimes.updated_at AS updated_at
      FROM cloudflare_connections AS connections
      LEFT JOIN organizations ON organizations.id = connections.org_id
      JOIN "user" AS users
        ON users.id = connections.user_id
        OR users.id IN (SELECT user_id FROM organization_members WHERE org_id = connections.org_id)
      LEFT JOIN user_computer_runtimes AS runtimes
        ON runtimes.user_id = users.id AND runtimes.connection_id = connections.id
      WHERE connections.status = 'active'
      ORDER BY users.createdAt, organizations.name
      LIMIT ${RUNTIME_ROW_LIMIT}`,
  ];
}

/**
 * Every project: whose it is, and its Artifacts repository or the GitHub repository its first open imports
 * it from. Asked apart from the core statements, so a schema the deployed release hasn't migrated yet marks
 * only this check unknown.
 */
/** Showcase posts shown, reports waiting for an operator, and posts reports hold (migrations/0056_showcase.sql). */
export const SHOWCASE_STATEMENT = `SELECT
    (SELECT COUNT(*) FROM posts WHERE status = 'visible') AS visible_posts,
    (SELECT COUNT(*) FROM post_reports WHERE state = 'open') AS open_reports,
    (SELECT COUNT(*) FROM posts WHERE status = 'hidden' AND hidden_reason = 'reported') AS held_posts`;

export const PROJECTS_STATEMENT = `SELECT projects.name AS name, organizations.name AS organization, owners.email AS owner,
    projects.artifact_repo AS artifact_repo,
    projects.import_repo_full_name AS import_repo_full_name,
    projects.workers_builds_script_tag AS workers_builds_script_tag
  FROM org_projects AS projects
  LEFT JOIN organizations ON organizations.id = projects.org_id
  LEFT JOIN cloudflare_connections AS connections ON connections.id = projects.connection_id
  LEFT JOIN "user" AS owners ON owners.id = connections.user_id
  ORDER BY organizations.name, projects.name
  LIMIT ${RUNTIME_ROW_LIMIT}`;

/**
 * Run read-only SQL against production D1 as the authenticated operator.
 *
 * @param {string} sql one or more `;`-separated SELECT statements
 * @param {{ run?: typeof execFileAsync; env?: Record<string, string | undefined>; databaseId?: string }} [options]
 * @returns {Promise<Array<Array<Record<string, unknown>>>>} rows per statement
 */
export async function queryProduction(sql, { run = execFileAsync, env = process.env, databaseId } = {}) {
  const id = databaseId ?? (await resolveControlPlaneDatabaseId());
  return parseD1Response(await cfReader({ run, env })(['d1', 'query', id, '--body', JSON.stringify({ sql })]));
}

/**
 * One day of the control-plane Worker's invocations, counted per outcome from Workers Logs.
 *
 * Only invocation events (`cf-worker-event`) carry an outcome, so console lines are not counted as
 * invocations. `dry` runs the query without saving it or its results to the account, which keeps
 * the read a read.
 *
 * @param {number} now
 */
export function workerInvocationsQuery(now) {
  return {
    queryId: 'cloudchef-ops-report-invocations',
    dry: true,
    view: 'calculations',
    ignoreSeries: true,
    timeframe: { from: now - WORKER_INVOCATION_WINDOW_MS, to: now },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$workers.scriptName', operation: 'eq', type: 'string', value: WORKER_SCRIPT_NAME },
        { key: '$metadata.type', operation: 'eq', type: 'string', value: 'cf-worker-event' },
      ],
      calculations: [{ operator: 'count', alias: 'invocations' }],
      groupBys: [{ type: 'string', value: OUTCOME_FIELD }],
      limit: 100,
    },
  };
}

/**
 * Read the control-plane Worker's invocations as the authenticated operator.
 *
 * @param {{ now?: number; run?: typeof execFileAsync; env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>} one aggregate per invocation outcome
 */
export async function readWorkerInvocations({ now = Date.now(), run = execFileAsync, env = process.env } = {}) {
  const payload = await cfReader({ run, env })([
    'o11y',
    'telemetry',
    'query',
    '--body',
    JSON.stringify(workerInvocationsQuery(now)),
  ]);
  return readInvocationGroups(payload);
}

/**
 * The aggregates out of one telemetry answer, or the reason there are none. A query that did not
 * complete must not arrive as an empty window, which would read as a Worker that stopped serving.
 *
 * @param {unknown} payload
 */
function readInvocationGroups(payload) {
  const status = payload?.run?.status;
  if (status !== undefined && status !== 'COMPLETED') {
    throw new Error(`The Workers Logs query finished as ${bounded(status, 40)}, not COMPLETED.`);
  }
  const calculations = payload?.calculations;
  if (!Array.isArray(calculations)) {
    throw new Error('The Workers Logs query returned no `calculations`, so the invocations cannot be counted.');
  }
  const aggregates = calculations[0]?.aggregates ?? [];
  if (!Array.isArray(aggregates)) {
    throw new Error('The Workers Logs query returned `aggregates` that are not a list.');
  }
  return aggregates;
}

/** `cf d1 query` returns one envelope per statement; this keeps only the rows. */
export function parseD1Response(answer) {
  const parsed = typeof answer === 'string' ? extractJson(answer) : answer;
  if (!Array.isArray(parsed)) {
    throw new Error('cf did not return a D1 result array.');
  }
  return parsed.map((result) => (Array.isArray(result?.results) ? result.results : []));
}

/**
 * The workspace runtime build this checkout would provision, used as the staleness reference.
 * Generated by `pnpm run generate:artifacts`, so it can legitimately be absent.
 */
async function readDesiredRuntimeVersion(readFileImpl = readFile) {
  try {
    const source = await readFileImpl(RUNTIME_BUNDLE_PATH, 'utf8');
    return RUNTIME_SHA_PATTERN.exec(source)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The pinned builder model and the context floor it is judged against, both read from
 * `app/lib/workers-ai-model.ts`.
 *
 * @param {typeof readFile} [readFileImpl]
 * @returns {Promise<{ id: string; minimumContextTokens: number } | null>}
 */
export async function readPinnedBuilderModel(readFileImpl = readFile) {
  try {
    const source = await readFileImpl(WORKERS_AI_MODEL_PATH, 'utf8');
    const id = PINNED_BUILDER_MODEL_PATTERN.exec(source)?.[1];
    const floor = BUILDER_CONTEXT_FLOOR_PATTERN.exec(source)?.[1];
    return id && floor ? { id, minimumContextTokens: Number(floor.replaceAll('_', '')) } : null;
  } catch {
    return null;
  }
}

/**
 * The account-visible Workers AI text-generation catalog, read as the authenticated operator.
 *
 * @param {{ run?: typeof execFileAsync; env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function readWorkersAiCatalog({ run = execFileAsync, env = process.env } = {}) {
  const payload = await cfReader({ run, env })([
    'ai',
    'models',
    'list',
    '--task',
    'Text Generation',
    '--hide-experimental',
    '--per-page',
    String(MODEL_CATALOG_PAGE_SIZE),
  ]);
  if (!Array.isArray(payload)) {
    throw new Error('`cf ai models list` did not return a list of models.');
  }
  return payload;
}

function catalogProperty(entry, id) {
  return entry?.properties?.find((property) => property.property_id === id)?.value;
}

function catalogPublishedTime(entry) {
  const parsed = Date.parse(entry?.created_at ?? '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Whether the pinned platform default builder model is still the one to run.
 *
 * The pin (`CLOUDFLARE_WORKERS_AI_MODEL`) is the default for every account whose admin has not
 * chosen its own (`cloudflare_connections.default_builder_model`); a provider model an account runs
 * with its own key on its AI Gateway is that account's choice, not this check's concern. The filter
 * below is the one `readWorkersAiBuilderModelCatalog` applies — native source, text generation,
 * function calling, a window at or above the builder's floor, and listed in Pi's
 * `cloudflare-workers-ai` catalog — because that is the whole of what makes a Workers AI model one
 * the runtime offers. What this report deliberately does not reproduce is a ranking: candidates
 * are worth a reference build before re-pinning, not a prediction of what anyone should choose.
 *
 * @param {ReadonlySet<string>} [piModelIds] the Workers AI models Pi lists
 */
export function describeBuilderModel(catalog, pin, piModelIds = PI_WORKERS_AI_MODEL_IDS) {
  const usable = catalog.filter(
    (entry) =>
      entry.source === 1 &&
      entry.task?.name === 'Text Generation' &&
      piModelIds.has(entry.name) &&
      catalogProperty(entry, 'function_calling') === 'true' &&
      Number(catalogProperty(entry, 'context_window')) >= pin.minimumContextTokens,
  );
  const pinned = usable.find((entry) => entry.name === pin.id);
  if (!pinned) {
    const reason = piModelIds.has(pin.id)
      ? "is no longer listed as builder-capable in this account's Workers AI catalog"
      : "is not listed in Pi's Workers AI catalog";
    return {
      level: 'error',
      sentence: `The pinned default builder model ${bounded(pin.id, 120)} ${reason}, so every account without its own default model is building on the first model the runtime offers instead of the reviewed one.`,
      detail: { pinned: pin.id, listed: false, candidates: [] },
    };
  }
  const pinnedPublished = catalogPublishedTime(pinned);
  // An undated pin gives nothing to measure "since" from, and an unknown date is not a claim to be old.
  const candidates =
    pinnedPublished === Number.NEGATIVE_INFINITY
      ? []
      : usable
          .filter((entry) => entry.name !== pin.id && catalogPublishedTime(entry) > pinnedPublished)
          .map((entry) => entry.name);
  let level = 'ok';
  let sentence = `The pinned default builder model ${bounded(pin.id, 120)} is current; no newer builder-capable Workers AI model that Pi lists has been published to this account's catalog.`;
  if (candidates.length > 0) {
    level = 'attention';
    sentence = `${candidates.length} builder-capable Workers AI ${plural(candidates.length, 'model')} that Pi lists published since the pinned default ${bounded(pin.id, 120)}: ${bounded(candidates.join(', '), 400)}. Worth a reference build before re-pinning; this report ranks nothing, so being listed here is not a recommendation.`;
  }
  return { level, sentence, detail: { pinned: pin.id, listed: true, candidates } };
}

const BUILDER_MODEL_CHECK_HINT = "Read with `cf ai models list` through the operator's own cf login.";

function buildBuilderModelCheck(catalogAttempt, pin) {
  if (!pin) {
    return unknownCheck(
      'builder-model',
      'Builder model',
      { ok: false, error: 'The pinned builder model could not be read from app/lib/workers-ai-model.ts.' },
      BUILDER_MODEL_CHECK_HINT,
    );
  }
  if (!catalogAttempt.ok) {
    return unknownCheck('builder-model', 'Builder model', catalogAttempt, BUILDER_MODEL_CHECK_HINT);
  }
  const described = describeBuilderModel(catalogAttempt.value, pin);
  return check('builder-model', 'Builder model', described.level, described.sentence, {
    detail: described.detail,
  });
}

/**
 * Read the platform and build the report.
 *
 * @param {{
 *   query: (sql: string) => Promise<Array<Array<Record<string, unknown>>>>;
 *   readInvocations?: (options: { now: number }) => Promise<Array<Record<string, unknown>>>;
 *   readModelCatalog?: () => Promise<Array<Record<string, unknown>>>;
 *   now?: number;
 *   desiredRuntimeVersion?: string | null;
 *   pinnedBuilderModel?: { id: string; minimumContextTokens: number } | null;
 * }} options
 */
export async function collectReport({
  query,
  // Not optional in effect: a caller that supplies no reader gets a check that says so, because
  // a Worker nobody looked at must not be absent from a report that claims to cover the platform.
  readInvocations = () => {
    throw new Error('No Workers analytics reader was supplied to this report.');
  },
  // Same contract as `readInvocations`: a caller that supplies no reader gets a check saying so.
  readModelCatalog = () => {
    throw new Error('No Workers AI catalog reader was supplied to this report.');
  },
  now = Date.now(),
  desiredRuntimeVersion = null,
  pinnedBuilderModel = null,
}) {
  const statements = coreStatements(now);
  const [core, projects, showcase, invocations, catalog] = await Promise.all([
    attempt(() => query(statements.join(';\n'))),
    attempt(() => query(PROJECTS_STATEMENT)),
    attempt(() => query(SHOWCASE_STATEMENT)),
    attempt(() => readInvocations({ now })),
    attempt(() => readModelCatalog()),
  ]);
  const checks = [
    buildWorkerCheck(invocations, now),
    buildBuilderModelCheck(catalog, pinnedBuilderModel),
    buildAccountsCheck(core),
    buildRuntimesCheck(core, { now, desiredRuntimeVersion }),
    buildUsersCheck(core),
    buildSessionsCheck(core),
    buildProjectsCheck(projects),
    buildShowcaseCheck(showcase),
  ];

  const status = checks.reduce(
    (worst, check) => (STATUS_RANK[check.status] > STATUS_RANK[worst] ? check.status : worst),
    'ok',
  );
  return {
    generatedAt: now,
    generatedAtIso: new Date(now).toISOString(),
    database: DATABASE_NAME,
    source: 'cf d1 query (read-only)',
    desiredRuntimeVersion,
    controlPlaneReadable: core.ok,
    status,
    headline: headlineFor(checks, core),
    checks,
  };
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
  const schemaMismatch = attemptResult.schemaMismatch === true;
  return {
    id,
    title,
    status: 'unknown',
    sentence: schemaMismatch
      ? `This could not be read: ${attemptResult.error} The schema this report expects and the one production holds have diverged.`
      : `This could not be read: ${attemptResult.error}`,
    at: null,
    relative: null,
    detail: { error: attemptResult.error, schemaMismatch, hint: hint ?? null },
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
const WORKER_CHECK_HINT = `Read from Workers Logs for the "${WORKER_SCRIPT_NAME}" script with \`cf o11y telemetry query\` through the operator's own cf login.`;

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
  const waitlist = number(row.managed_space_waitlist);
  return check(
    'users',
    'Users',
    'ok',
    `${total} ${plural(total, 'user')} in total; ${thisWeek} joined in the last 7 days (${delta >= 0 ? '+' : ''}${delta} versus the 7 days before); ${waitlist} waiting for a managed space.`,
    {
      detail: {
        total,
        joinedThisWeek: thisWeek,
        joinedPreviousWeek: lastWeek,
        delta,
        managedSpaceWaitlist: waitlist,
      },
    },
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

function buildProjectsCheck(projects) {
  if (!projects.ok) {
    return unknownCheck('projects', 'Projects', projects);
  }
  const rows = projects.value[0] ?? [];
  const entries = rows.map((row) => ({
    name: String(row.name ?? ''),
    owner: row.organization ? String(row.organization) : row.owner ? String(row.owner) : null,
    repository: row.artifact_repo ? String(row.artifact_repo) : null,
    importFrom: row.artifact_repo ? null : (row.import_repo_full_name ?? null),
    workersBuildsScriptTag: row.workers_builds_script_tag ?? null,
  }));
  const waiting = entries.filter((entry) => entry.repository === null).length;
  const sentence =
    entries.length === 0
      ? 'No projects.'
      : `${entries.length} ${plural(entries.length, 'project')}: ${entries.length - waiting} in Artifacts, ${waiting} still to be imported from GitHub on first open.`;
  return check('projects', 'Projects', 'ok', sentence, { detail: { entries } });
}

/**
 * Showcase posts, and the reports waiting at /reports: any open report needs an operator, and a post held by
 * reports stays off every page until one decides.
 */
function buildShowcaseCheck(showcase) {
  if (!showcase.ok) {
    return unknownCheck('showcase', 'Showcase', showcase);
  }
  const row = showcase.value[0]?.[0] ?? {};
  const visible = number(row.visible_posts);
  const open = number(row.open_reports);
  const held = number(row.held_posts);
  const posts = `${visible} ${plural(visible, 'post')} shown`;
  const sentence =
    open === 0
      ? `${posts}; no reports waiting.`
      : `${posts}; ${open} ${plural(open, 'report')} waiting at /reports${held > 0 ? `, ${held} ${plural(held, 'post')} held until decided` : ''}.`;
  return check('showcase', 'Showcase', open === 0 ? 'ok' : 'attention', sentence, {
    detail: { visiblePosts: visible, openReports: open, heldPosts: held },
  });
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
function headlineFor(checks, core) {
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
    `CloudChef platform — ${report.generatedAtIso.replace('T', ' ').slice(0, 16)} UTC`,
    `read-only from control-plane D1 "${report.database}", Workers Logs, and the Workers AI catalog, via the cf CLI`,
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

Reports the operational state of the CloudChef platform by reading production
control-plane D1, the control-plane Worker's own Workers Logs, and the Workers AI
catalog through the operator's own cf CLI login (\`cf auth login\`, or
CLOUDFLARE_API_TOKEN). Read-only.

  --json   emit the structured report instead of the terminal one
  --help   show this message

Exit status is 0 whenever a report was produced, including an unhealthy one, and
1 when the control plane could not be read at all.`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const desiredRuntimeVersion = await readDesiredRuntimeVersion();
  const pinnedBuilderModel = await readPinnedBuilderModel();
  // One cf process at a time: concurrent ones share one OAuth login state, where one can race the
  // other's token refresh. A failed read still lands in its own check; the next one runs regardless.
  const serially = oneAtATime();
  const report = await collectReport({
    query: (sql) => serially(() => queryProduction(sql)),
    readInvocations: ({ now }) => serially(() => readWorkerInvocations({ now })),
    readModelCatalog: () => serially(() => readWorkersAiCatalog()),
    desiredRuntimeVersion,
    pinnedBuilderModel,
  });
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
  return report.controlPlaneReadable ? 0 : 1;
}

/** Run each call after the previous one settles, whether it resolved or not. */
function oneAtATime() {
  let tail = Promise.resolve();
  return (read) => {
    const result = tail.then(read);
    tail = result.catch(() => undefined);
    return result;
  };
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
