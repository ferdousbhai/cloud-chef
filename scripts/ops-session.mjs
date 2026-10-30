/**
 * Read-only reconstruction of one member's recent CloudChef session, for the operator.
 *
 * `pnpm run ops:session -- <chat id | user email | user id>` puts together what an operator otherwise
 * gathers by hand when someone reports a problem:
 *
 * - control-plane D1: the person, their workspace runtimes (Worker name, release, last session), and
 *   their organization's daily usage
 * - the workspace's own D1 (`cloudchef-data-<suffix>`, found with `cf d1 list` in the runtime's account):
 *   the chat and its transcripts
 * - Workers Logs for the workspace Worker over the conversation's time span (a dry-run query that saves
 *   nothing, paged by `$metadata.id`): turns, turn budgets, model finishes, warnings, and errors
 * - AI Gateway logs filed under the chat (`metadata.chat`): every model request, and the conversation
 *   as the latest request and response carried it (user messages, assistant text, tool calls and errors)
 * - for a chat on a project: its Artifacts repository (or the GitHub repository it is still to be imported
 *   from), and the latest Workers Builds builds of its Worker
 *
 * Everything goes through the operator's existing `cf` login. Every D1 statement is a `SELECT`, and every
 * `cf` command is on a read-only allowlist. No secret is read or printed; conversation content appears
 * only where the person kept AI Gateway logging on.
 */
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { attempt, bounded, cfReader, DAY, MINUTE, resolveControlPlaneDatabaseId } from './lib/ops-cf.mjs';

const GATEWAY_ID = 'default';
const GATEWAY_PAGE_SIZE = 50;
const GATEWAY_MAX_PAGES = 10;
const EVENTS_PAGE_SIZE = 100;
const EVENTS_MAX_PAGES = 20;
/** Logs are read from a little before the conversation's first request to a little after its last. */
const WINDOW_LEAD_MS = 10 * MINUTE;
/** Without a request to anchor on, the last day of the chat's activity. */
const DEFAULT_WINDOW_MS = DAY;
const MAX_WINDOW_MS = 7 * DAY;
const CHATS_PER_WORKSPACE = 5;
const USAGE_DAYS = 14;
/** How many of a project Worker's latest builds are read, and of those, how many shown. */
const BUILDS_READ = 25;
const BUILDS_SHOWN = 8;

/**
 * @typedef {import('./lib/ops-cf.mjs').CfReader} CfReader
 */

/**
 * Accept only identifier-shaped input: it reaches SQL only as a bound parameter, but is echoed too.
 * @param {string | undefined} value
 * @returns {{ value: string; kind: 'email' | 'id' }}
 */
export function parseTarget(value) {
  const target = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._%+@-]{3,254}$/.test(target)) {
    throw new Error('Pass a chat id, a user id, or a user email.');
  }
  return { value: target, kind: target.includes('@') ? 'email' : 'id' };
}

/** The workspace D1 database a runtime Worker is provisioned with (`workspaceRuntimeNames`). */
export function workspaceDatabaseName(workerName) {
  return String(workerName).replace(/^cloudchef-workspace-/, 'cloudchef-data-');
}

function d1Args(databaseId, sql, params = []) {
  return ['d1', 'query', databaseId, '--body', JSON.stringify({ sql, params })];
}

async function select(cf, databaseId, sql, params, options) {
  const answer = await cf(d1Args(databaseId, sql, params), options);
  const first = Array.isArray(answer) ? answer[0] : undefined;
  return Array.isArray(first?.results) ? first.results : [];
}

/** Run a read, keeping its failure as the reason a section is unknown instead of aborting the rest. */
function attemptRead(read) {
  return attempt(read, { limit: 400 });
}

/** The Workers Logs query for one page of a Worker's events, newest first, before `to`. */
function workspaceEventsQuery({ workerName, from, to }) {
  return {
    queryId: 'cloudchef-ops-session-events',
    dry: true,
    view: 'events',
    limit: EVENTS_PAGE_SIZE,
    timeframe: { from, to },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: workerName }],
    },
  };
}

/**
 * Every event of the workspace Worker in the window, newest first. Each page ends the window at the
 * oldest event it returned, and `$metadata.id` drops the events that boundary repeats.
 * @param {CfReader} cf
 * @param {{ workerName: string; from: number; to: number; accountId?: string }} window
 */
export async function readWorkspaceEvents(cf, { workerName, from, to, accountId }) {
  const seen = new Set();
  const events = [];
  let end = to;
  for (let page = 0; page < EVENTS_MAX_PAGES; page += 1) {
    const answer = await cf(
      ['o11y', 'telemetry', 'query', '--body', JSON.stringify(workspaceEventsQuery({ workerName, from, to: end }))],
      { accountId },
    );
    const status = answer?.run?.status;
    if (status !== undefined && status !== 'COMPLETED') {
      throw new Error(`The Workers Logs query finished as ${bounded(status, 40)}, not COMPLETED.`);
    }
    const batch = Array.isArray(answer?.events?.events) ? answer.events.events : [];
    const fresh = batch.filter((event) => {
      const id = event?.$metadata?.id;
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
    events.push(...fresh);
    if (batch.length < EVENTS_PAGE_SIZE || fresh.length === 0) {
      return { events, complete: true };
    }
    end = Math.min(...fresh.map((event) => Number(event.timestamp))) + 1;
  }
  return { events, complete: false };
}

/** What a turn looked like from the workspace Worker's logs. */
export function summarizeWorkspaceEvents(events) {
  const counts = {};
  const turns = [];
  const budgets = [];
  const finishes = [];
  const problems = [];
  for (const event of [...events].sort((a, b) => Number(a.timestamp) - Number(b.timestamp))) {
    const source = event?.source ?? {};
    const level = event?.$metadata?.level ?? source.level;
    const name =
      source.event ??
      (event?.$metadata?.type === 'cf-worker-event' ? `${event.$workers?.eventType} invocation` : 'log line');
    counts[name] = (counts[name] ?? 0) + 1;
    const at = Number(event.timestamp);
    if (source.event === 'builder_chat_turn_started') {
      turns.push({
        at,
        continuation: source.continuation === true,
        firstUserMessage: source.firstUserMessage === true,
      });
    } else if (source.event === 'cloudchef_pi_turn_budget') {
      const { event: _event, level: _level, ...budget } = source;
      budgets.push({ at, ...budget });
    } else if (source.event === 'workers_ai_finished') {
      finishes.push({
        at,
        model: source.model,
        finishReason: source.finishReason,
        inputTokens: source.usage?.inputTokens,
        outputTokens: source.usage?.outputTokens,
        durationMs: source.durationMs,
        contextReduced: source.contextReduced,
      });
    }
    const outcome = event?.$workers?.outcome;
    if (level === 'warn' || level === 'error' || (outcome && outcome !== 'ok' && outcome !== 'canceled')) {
      problems.push({
        at,
        level: level ?? 'info',
        what: source.event ?? (outcome && outcome !== 'ok' ? `${event.$workers?.eventType} ${outcome}` : 'log'),
        detail: bounded(source.message ?? source.reason ?? source.errorCode ?? event?.$metadata?.message ?? '', 200),
        entrypoint: event?.$workers?.entrypoint ?? null,
      });
    }
  }
  return { counts, turns, budgets, finishes, problems };
}

/** Every AI Gateway log filed under the chat, oldest first. */
async function readGatewayLogs(cf, { chatKey, accountId }) {
  const logs = [];
  const filters = JSON.stringify([{ key: 'metadata.value', operator: 'eq', value: [chatKey] }]);
  for (let page = 1; page <= GATEWAY_MAX_PAGES; page += 1) {
    const batch = await cf(
      [
        'ai-gateway',
        'logs',
        'list',
        '--gateway-id',
        GATEWAY_ID,
        '--filters',
        filters,
        '--order-by',
        'created_at',
        '--order-by-direction',
        'asc',
        '--per-page',
        String(GATEWAY_PAGE_SIZE),
        '--page',
        String(page),
      ],
      { accountId },
    );
    const rows = Array.isArray(batch) ? batch : [];
    // `metadata.value` matches any key; keep the requests filed under this chat.
    logs.push(...rows.filter((row) => row?.metadata?.chat === chatKey || row?.metadata?.agent === chatKey));
    if (rows.length < GATEWAY_PAGE_SIZE) {
      return { logs, complete: true };
    }
  }
  return { logs, complete: false };
}

function gatewayLogSummary(log) {
  return {
    id: log.id,
    at: Date.parse(log.created_at),
    model: log.model,
    success: log.success === true,
    statusCode: log.status_code ?? null,
    tokensIn: log.tokens_in ?? null,
    tokensOut: log.tokens_out ?? null,
    cachedTokens: log.usage_metadata?.input_cached_tokens ?? null,
    durationMs: log.duration ?? null,
    user: log.metadata?.user ?? null,
  };
}

/** A chat message's content: a string, or parts of which the text parts count. Anything else is empty. */
const messageContentSchema = z
  .union([
    z.string(),
    z.array(
      z.union([z.string(), z.object({ text: z.string() }).transform((part) => part.text), z.any().transform(() => '')]),
    ),
  ])
  .catch('');

function messageText(content) {
  const parsed = messageContentSchema.parse(content);
  return Array.isArray(parsed) ? parsed.filter(Boolean).join('\n') : parsed;
}

/** A string, or the empty string for anything else. */
const textOrEmpty = z.string().catch('');

/** A tool result the model saw as a failure: an `error`, or a report that is not `ok`. */
export function toolFailure(content) {
  const text = messageText(content);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return /^(?:error|failed)\b/i.test(text.trim()) ? bounded(text, 240) : null;
  }
  if (!parsed || Array.isArray(parsed) || !Object.keys(parsed).length) {
    return null;
  }
  if (parsed.error) {
    return bounded(parsed.error?.message ?? parsed.error, 240);
  }
  const report = parsed.ok === false ? parsed : Object.values(parsed).find((value) => value?.ok === false);
  return report ? bounded(report.summary ?? report.message ?? 'not ok', 240) : null;
}

/** An OpenAI-style streamed answer, joined back into text and tool calls. */
function joinStreamedResponse(response) {
  const choices = Array.isArray(response?.choices) ? response.choices : [];
  let text = '';
  const calls = new Map();
  let finishReason = null;
  for (const choice of choices) {
    const delta = choice?.delta ?? choice?.message ?? {};
    text += textOrEmpty.parse(delta.content);
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = call.index ?? call.id ?? calls.size;
      const current = calls.get(key) ?? { name: '', arguments: '' };
      current.name += call.function?.name ?? '';
      current.arguments += call.function?.arguments ?? '';
      calls.set(key, current);
    }
    finishReason = choice?.finish_reason ?? finishReason;
  }
  return { text, toolCalls: [...calls.values()], finishReason };
}

/**
 * The conversation as the chat's latest model request carried it, and that request's answer. Each
 * request holds the whole conversation so far, so the latest one is the most complete record.
 */
export function conversationFromGateway(request, response, { textLimit = 600 } = {}) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const entries = [];
  const callNames = new Map();
  for (const message of messages) {
    if (message?.role === 'system') {
      entries.push({ role: 'system', text: `(${messageText(message.content).length} characters)` });
    } else if (message?.role === 'user') {
      entries.push({ role: 'user', text: bounded(messageText(message.content), textLimit) });
    } else if (message?.role === 'assistant') {
      const text = messageText(message.content);
      if (text.trim()) {
        entries.push({ role: 'assistant', text: bounded(text, textLimit) });
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        callNames.set(call.id, call.function?.name ?? 'tool');
        entries.push({
          role: 'tool call',
          text: `${call.function?.name ?? 'tool'}(${bounded(call.function?.arguments ?? '', 160)})`,
        });
      }
    } else if (message?.role === 'tool') {
      const failure = toolFailure(message.content);
      if (failure) {
        entries.push({ role: 'tool error', text: `${callNames.get(message.tool_call_id) ?? 'tool'}: ${failure}` });
      }
    }
  }
  if (response) {
    const answer = joinStreamedResponse(response);
    if (answer.text.trim()) {
      entries.push({ role: 'assistant', text: bounded(answer.text, textLimit) });
    }
    for (const call of answer.toolCalls) {
      entries.push({ role: 'tool call', text: `${call.name}(${bounded(call.arguments, 160)})` });
    }
    if (answer.finishReason) {
      entries.push({ role: 'finish', text: answer.finishReason });
    }
  }
  return { messageCount: messages.length, tools: Array.isArray(request?.tools) ? request.tools.length : 0, entries };
}

const RUNTIME_SQL = `SELECT runtimes.user_id, users.email, runtimes.connection_id, runtimes.connection_generation,
    runtimes.worker_name, runtimes.runtime_version, runtimes.protocol_version, runtimes.status,
    runtimes.last_session_at, runtimes.updated_at, connections.account_id, connections.org_id,
    organizations.name AS org_name
  FROM user_computer_runtimes AS runtimes
  JOIN "user" AS users ON users.id = runtimes.user_id
  JOIN cloudflare_connections AS connections ON connections.id = runtimes.connection_id
  LEFT JOIN organizations ON organizations.id = connections.org_id`;

/**
 * Put the session together. Each source that cannot be read becomes a reason in `unknown`, and the
 * sources after it are still read.
 *
 * @param {{ value: string; kind: 'email' | 'id' }} target
 * @param {{ cf: CfReader; controlPlaneDatabaseId: string; now?: number; textLimit?: number }} options
 */
export async function collectSession(target, { cf, controlPlaneDatabaseId, now = Date.now(), textLimit }) {
  const unknown = [];
  const note = (source, result) => {
    if (!result.ok) {
      unknown.push({ source, reason: result.error });
    }
    return result.ok ? result.value : null;
  };
  const users = await select(
    cf,
    controlPlaneDatabaseId,
    `SELECT id, email, name, createdAt, ai_gateway_content_logging FROM "user" WHERE id = ?1 OR lower(email) = lower(?1)`,
    [target.value],
  );
  const user = users[0] ?? null;
  const runtimes = user
    ? await select(
        cf,
        controlPlaneDatabaseId,
        `${RUNTIME_SQL} WHERE runtimes.user_id = ?1 ORDER BY runtimes.last_session_at DESC`,
        [user.id],
      )
    : await select(cf, controlPlaneDatabaseId, `${RUNTIME_SQL} ORDER BY runtimes.last_session_at DESC LIMIT 50`, []);
  if (!user && target.kind === 'email') {
    return { target: target.value, found: false, reason: 'No CloudChef user has that email.', unknown };
  }

  // The chat lives in a workspace's own D1, in the runtime's Cloudflare account.
  const databasesByAccount = new Map();
  const candidates = [];
  for (const runtime of runtimes) {
    if (!databasesByAccount.has(runtime.account_id)) {
      databasesByAccount.set(
        runtime.account_id,
        await attemptRead(async () => {
          const list = await cf(['d1', 'list'], { accountId: runtime.account_id });
          return new Map((Array.isArray(list) ? list : []).map((database) => [database.name, database.uuid]));
        }),
      );
    }
    const databases = note(`D1 databases of account ${runtime.account_id}`, databasesByAccount.get(runtime.account_id));
    const databaseId = databases?.get(workspaceDatabaseName(runtime.worker_name));
    if (!databases) {
      continue;
    }
    if (!databaseId) {
      unknown.push({
        source: runtime.worker_name,
        reason: `No ${workspaceDatabaseName(runtime.worker_name)} database in its account.`,
      });
      continue;
    }
    const chats = note(
      `chats of ${runtime.worker_name}`,
      await attemptRead(() =>
        select(
          cf,
          databaseId,
          user
            ? `SELECT workspaces.*, (SELECT MAX(updated_at) FROM conversations WHERE workspace_id = workspaces.id) AS last_activity_at
               FROM workspaces WHERE is_deleted = 0 ORDER BY COALESCE(last_activity_at, 0) DESC, timestamp DESC LIMIT ${CHATS_PER_WORKSPACE}`
            : `SELECT workspaces.*, (SELECT MAX(updated_at) FROM conversations WHERE workspace_id = workspaces.id) AS last_activity_at
               FROM workspaces WHERE id = ?1 OR initial_id = ?1`,
          user ? [] : [target.value],
          { accountId: runtime.account_id },
        ),
      ),
    );
    for (const chat of chats ?? []) {
      candidates.push({ chat, runtime, databaseId });
    }
  }
  const latest = (entry) => Number(entry.chat.last_activity_at) || Date.parse(entry.chat.timestamp) || 0;
  candidates.sort((a, b) => latest(b) - latest(a));
  const chosen = candidates[0];
  if (!chosen) {
    return {
      target: target.value,
      found: false,
      reason: user
        ? 'The person has no chat in a workspace this login can read.'
        : 'No user or chat with that id in a readable workspace.',
      user,
      runtimes,
      unknown,
    };
  }
  const { chat, runtime, databaseId } = chosen;
  const accountId = runtime.account_id;
  const owner =
    user ??
    (
      await select(
        cf,
        controlPlaneDatabaseId,
        `SELECT id, email, name, createdAt, ai_gateway_content_logging FROM "user" WHERE id = ?1`,
        [runtime.user_id],
      )
    )[0] ??
    null;
  const ownerRuntimes = user ? runtimes : runtimes.filter((row) => row.user_id === runtime.user_id);

  const usage = note(
    'organization usage',
    await attemptRead(() =>
      select(
        cf,
        controlPlaneDatabaseId,
        `SELECT day, turns, input_tokens, output_tokens, cached_tokens FROM organization_usage_daily
         WHERE user_id = ?1 AND day >= ?2 ORDER BY day DESC`,
        [runtime.user_id, new Date(now - USAGE_DAYS * DAY).toISOString().slice(0, 10)],
      ),
    ),
  );
  const transcripts = note(
    'chat transcripts',
    await attemptRead(() =>
      select(
        cf,
        databaseId,
        `SELECT conversation_index, agent_name, description, created_at, updated_at FROM conversations
         WHERE workspace_id = ?1 ORDER BY conversation_index`,
        [chat.id],
        { accountId },
      ),
    ),
  );
  const gateway = note(
    'AI Gateway logs',
    await attemptRead(() => readGatewayLogs(cf, { chatKey: chat.initial_id, accountId })),
  );
  const requests = (gateway?.logs ?? []).map(gatewayLogSummary);
  let conversation = null;
  const last = gateway?.logs.at(-1);
  if (last) {
    const request = note(
      'the latest model request',
      await attemptRead(() =>
        cf(['ai-gateway', 'logs', 'get-request', last.id, '--gateway-id', GATEWAY_ID], { accountId }),
      ),
    );
    const response = note(
      'the latest model response',
      await attemptRead(() =>
        cf(['ai-gateway', 'logs', 'get-response', last.id, '--gateway-id', GATEWAY_ID], { accountId }),
      ),
    );
    if (request) {
      conversation = conversationFromGateway(request, response, { textLimit });
    }
  }

  const activity = [
    ...requests.map((request) => request.at),
    ...(transcripts ?? []).flatMap((row) => [Number(row.created_at), Number(row.updated_at)]),
    Date.parse(chat.timestamp),
  ].filter(Number.isFinite);
  const lastActivity = activity.length ? Math.max(...activity) : now;
  const firstActivity = requests.length
    ? Math.min(...requests.map((request) => request.at))
    : lastActivity - DEFAULT_WINDOW_MS;
  const window = {
    from: Math.max(firstActivity - WINDOW_LEAD_MS, lastActivity - MAX_WINDOW_MS),
    to: Math.min(lastActivity + WINDOW_LEAD_MS, now),
  };
  const events = note(
    `Workers Logs for ${runtime.worker_name}`,
    await attemptRead(() => readWorkspaceEvents(cf, { workerName: runtime.worker_name, ...window, accountId })),
  );

  let project = null;
  if (chat.org_project_id) {
    project = await readProject({ cf, controlPlaneDatabaseId, projectId: chat.org_project_id, accountId, note });
  }

  return {
    target: target.value,
    found: true,
    user: owner,
    runtimes: ownerRuntimes,
    usage,
    chat: { ...chat, workerName: runtime.worker_name, accountId, orgName: runtime.org_name ?? null },
    transcripts,
    window,
    events: events ? { complete: events.complete, ...summarizeWorkspaceEvents(events.events) } : null,
    gateway: gateway
      ? { complete: gateway.complete, contentLogging: owner?.ai_gateway_content_logging !== 0, requests }
      : null,
    conversation,
    project,
    unknown,
  };
}

/** What a project was made from (`org_projects.created_from`), in words. */
const CREATED_FROM = { github: 'imported from GitHub', zip: 'uploaded as a ZIP', draft: 'an approved draft' };

async function readProject({ cf, controlPlaneDatabaseId, projectId, accountId, note }) {
  const project = (
    await select(
      cf,
      controlPlaneDatabaseId,
      `SELECT id, name, created_from, artifact_repo, import_repo_full_name, import_branch, workers_builds_script_tag
       FROM org_projects WHERE id = ?1`,
      [projectId],
    )
  )[0];
  if (!project) {
    return { project: null };
  }
  if (!project.workers_builds_script_tag) {
    return { project, builds: null };
  }
  // The latest builds of every branch: main is production, and the agent names its preview branches itself.
  const builds = note(
    `Workers Builds for ${project.name}`,
    await attemptRead(async () => {
      const rows = await cf(
        [
          'builds',
          'list',
          '--external-script-id',
          project.workers_builds_script_tag,
          '--per-page',
          String(BUILDS_READ),
        ],
        { accountId },
      );
      return (Array.isArray(rows) ? rows : [])
        .map((row) => ({
          branch: String(row.build_trigger_metadata?.branch ?? ''),
          commit: String(row.build_trigger_metadata?.commit_hash ?? ''),
          status: row.status ?? null,
          outcome: row.build_outcome ?? null,
          at: row.created_on ?? null,
          message: bounded(String(row.build_trigger_metadata?.commit_message ?? '').split('\n')[0], 120),
        }))
        .slice(0, BUILDS_SHOWN);
    }),
  );
  return { project, builds };
}

function time(value) {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString().replace('.000Z', 'Z') : 'unknown';
}

/** The terminal report. */
export function renderSession(session) {
  const lines = [];
  const push = (...items) => lines.push(...items);
  if (!session.found) {
    push(`No session found for ${session.target}: ${session.reason}`);
  } else {
    const { user, chat } = session;
    push(`CloudChef session for ${user?.email ?? 'an unknown user'} (${user?.id ?? 'no id'})`);
    push(
      `Workspace ${chat.id} "${bounded(chat.description ?? '', 80)}" in ${chat.workerName}` +
        `${chat.orgName ? ` (organization ${chat.orgName})` : ''}, created ${chat.timestamp}`,
    );
    push(`Window read: ${time(session.window.from)} to ${time(session.window.to)}`, '');
    push('Runtimes');
    for (const runtime of session.runtimes ?? []) {
      push(
        `  ${runtime.worker_name}  release ${String(runtime.runtime_version).slice(0, 12)}  protocol ${runtime.protocol_version ?? 1}` +
          `  last session ${time(runtime.last_session_at)}${runtime.org_name ? `  org ${runtime.org_name}` : ''}`,
      );
    }
    if (session.usage?.length) {
      push('Usage (organization, per day)');
      for (const day of session.usage) {
        push(
          `  ${day.day}  ${day.turns} turns  ${day.input_tokens} in  ${day.output_tokens} out  ${day.cached_tokens} cached`,
        );
      }
    }
    push('');
    if (session.events) {
      const { counts, turns, budgets, finishes, problems } = session.events;
      push(`Workspace Worker logs${session.events.complete ? '' : ' (truncated)'}`);
      push(
        `  ${
          Object.entries(counts)
            .map(([name, count]) => `${name} ${count}`)
            .join(', ') || 'no events'
        }`,
      );
      for (const turn of turns) {
        push(
          `  ${time(turn.at)} turn started${turn.continuation ? ' (continuation)' : ''}${turn.firstUserMessage ? ' (first message)' : ''}`,
        );
      }
      for (const finish of finishes) {
        push(
          `  ${time(finish.at)} model finished ${finish.finishReason} ${finish.inputTokens} in ${finish.outputTokens} out` +
            ` ${Math.round(Number(finish.durationMs) / 1000)}s${finish.contextReduced ? ' (context reduced)' : ''}`,
        );
      }
      for (const budget of budgets.slice(-3)) {
        const { at, ...rest } = budget;
        push(`  ${time(at)} turn budget ${bounded(JSON.stringify(rest), 200)}`);
      }
      for (const problem of problems) {
        push(
          `  ${time(problem.at)} ${problem.level.toUpperCase()} ${problem.what}${problem.entrypoint ? ` [${problem.entrypoint}]` : ''} ${problem.detail}`,
        );
      }
      push('');
    }
    if (session.gateway) {
      push(
        `AI Gateway: ${session.gateway.requests.length} model requests${session.gateway.complete ? '' : ' (truncated)'}` +
          `${session.gateway.contentLogging ? '' : ' (the person turned content logging off)'}`,
      );
      for (const request of session.gateway.requests) {
        push(
          `  ${time(request.at)} ${request.model} ${request.success ? 'ok' : `failed ${request.statusCode}`}` +
            ` ${request.tokensIn} in (${request.cachedTokens ?? 0} cached) ${request.tokensOut} out ${Math.round(Number(request.durationMs) / 1000)}s`,
        );
      }
      push('');
    }
    if (session.conversation) {
      push(
        `Conversation (from the latest request: ${session.conversation.messageCount} messages, ${session.conversation.tools} tools)`,
      );
      for (const entry of session.conversation.entries) {
        push(`  [${entry.role}] ${entry.text}`);
      }
      push('');
    }
    if (session.project?.project) {
      const { project, builds } = session.project;
      const repository = project.artifact_repo
        ? `Artifacts repository ${project.artifact_repo}`
        : `not imported yet (from ${project.import_repo_full_name ?? 'unknown'} ${project.import_branch ?? ''})`.trimEnd();
      const source = CREATED_FROM[project.created_from] ?? `made from ${project.created_from ?? 'unknown'}`;
      push(`Project ${project.name} (${source}): ${repository}`);
      if (!project.workers_builds_script_tag) {
        push('  no Workers Builds Worker found for it yet');
      }
      for (const build of builds ?? []) {
        push(
          `  ${build.commit.slice(0, 7)} ${build.at} ${build.branch}: ${build.outcome ?? build.status} ${build.message}`,
        );
      }
      push('');
    }
  }
  for (const item of session.unknown ?? []) {
    push(`Unknown: ${item.source}: ${item.reason}`);
  }
  return lines.join('\n').trimEnd();
}

const USAGE = `Usage: pnpm run ops:session -- <chat id | user email | user id> [--json] [--full]

Reconstructs a member's most recent session (or the named chat) from production, read-only:
control-plane D1, the workspace's own D1, the workspace Worker's Workers Logs, AI Gateway logs
filed under the chat, and, for a project, its repository and its Worker's latest Workers Builds
builds of its branches.
Reads through the operator's own cf login.

  --json   emit the structured session instead of the terminal one
  --full   print message text untruncated (default: 600 characters each)
  --help   show this message`;

const FLAGS = new Set(['--json', '--full', '--help', '-h']);

/**
 * The command line, read strictly: one target and the flags above. A flag it doesn't know is refused
 * by name rather than ignored, so a mistyped `--ful` doesn't quietly print a truncated session.
 * @param {readonly string[]} argv
 * @returns {{ help: true } | { error: string } | { target: string; json: boolean; full: boolean }}
 */
export function parseArguments(argv) {
  const unknown = argv.filter((arg) => arg.startsWith('-') && !FLAGS.has(arg));
  if (unknown.length > 0) {
    return { error: `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` };
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const positional = argv.filter((arg) => !arg.startsWith('-'));
  if (positional.length !== 1) {
    return { error: positional.length === 0 ? 'Name a chat id, user email, or user id.' : 'Name only one target.' };
  }
  return { target: positional[0], json: argv.includes('--json'), full: argv.includes('--full') };
}

async function main(argv) {
  const parsed = parseArguments(argv);
  if ('help' in parsed) {
    console.log(USAGE);
    return 0;
  }
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  // One cf process at a time: concurrent ones share one OAuth login, whose refresh can race.
  const session = await collectSession(parseTarget(parsed.target), {
    cf: cfReader(),
    controlPlaneDatabaseId: await resolveControlPlaneDatabaseId(),
    textLimit: parsed.full ? Number.MAX_SAFE_INTEGER : 600,
  });
  console.log(parsed.json ? JSON.stringify(session, null, 2) : renderSession(session));
  return session.found ? 0 : 1;
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
