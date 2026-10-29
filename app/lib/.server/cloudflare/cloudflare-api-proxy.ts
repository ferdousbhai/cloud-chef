import {
  CloudflareApiRequestRejectedError,
  normalizeCloudflareApiRequest,
  type CloudflareApiRequest,
} from 'cloudchef-agent/cloudflare-api';
import { readBodyTextPrefix } from '~/lib/bounded-body';

/**
 * `cf` in the workspace container sends its Cloudflare API requests to this address (its
 * `CLOUDFLARE_API_BASE_URL`), and the runtime's CloudflareApiProxy answers them. The container holds no
 * credential: the proxy puts the account's own in place of the stand-in token `cf` sends, and reads pass. A change
 * the agent's command asks for waits for the person's approval in the chat; one typed in the person's own terminal
 * is theirs and is sent at once. A team member's changes, from either, go to the team's admins.
 */
export const CLOUDFLARE_API_PROXY_HOST = 'cloudflare-api.internal';
export const CLOUDFLARE_API_PROXY_BASE_URL = `http://${CLOUDFLARE_API_PROXY_HOST}/client/v4`;
/** What `cf` sends as its token, so it runs unattended; never a credential. */
export const CLOUDFLARE_API_PROXY_TOKEN = 'cloudchef-proxy';

const API_PATH_PREFIX = '/client/v4/';
const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const satisfies readonly CloudflareApiRequest['method'][];

function apiMethod(method: string): CloudflareApiRequest['method'] | null {
  return METHODS.find((known) => known === method) ?? null;
}
/** As large as a change CloudChef records for approval may be. */
const MAX_CHANGE_BODY_BYTES = 60 * 1024;
/** How often a change waiting for the person is asked about again. */
const CLOUDFLARE_CHANGE_POLL_MS = 1_500;

/** The agent's command running in the container: a change is approved in that command's place in the chat. */
export type WorkspaceAgentCommand = { agentName: string; toolCallId: string };

/**
 * What the agent says of a change: its answer for `cf`, that it still waits for a decision, or that it is queued
 * behind an earlier change of the same command that is still waiting, to be asked for again.
 */
export type CloudflareChangeAnswer =
  { kind: 'answer'; status: number; body: string } | { kind: 'waiting'; executionId: string } | { kind: 'queued' };

/**
 * Who the person is to the account, asked afresh for each request: its owner or one of a team's admins (who read it
 * and change it), one of a team's other members (whose changes go to the team's admins), or someone this
 * workspace can't act for.
 */
export type CloudflareAccountAccess =
  { kind: 'account' } | { kind: 'team_member' } | { kind: 'refused'; reason: string };

/** A change typed in the person's own terminal and sent at once, for the workspace's log of what it changed. */
type TerminalCloudflareChange = {
  request: CloudflareApiRequest;
  status: number;
  rayId: string | null;
};

export type CloudflareApiProxyDependencies = {
  accountId: string;
  access(): Promise<CloudflareAccountAccess>;
  /** Sends a request with the account's credential, which stays outside the container. */
  send(request: CloudflareApiRequest, signal: AbortSignal): Promise<Response>;
  /** The agent's command running in the container now, if one is. */
  command(): Promise<WorkspaceAgentCommand | null>;
  propose(command: WorkspaceAgentCommand, request: CloudflareApiRequest): Promise<CloudflareChangeAnswer>;
  outcome(command: WorkspaceAgentCommand, executionId: string): Promise<CloudflareChangeAnswer>;
  /** The command stopped while its change waited: nothing is sent. */
  withdraw(command: WorkspaceAgentCommand, executionId: string): Promise<void>;
  /** A team member's change typed in the terminal, filed for the team's admins as the agent's are. */
  fileForTeamAdmins(request: CloudflareApiRequest): Promise<CloudflareChangeAnswer>;
  /** Notes a change typed in the terminal and sent at once, so what changed the account can be traced. */
  recordTerminalChange(change: TerminalCloudflareChange): void;
  sleep(ms: number): Promise<void>;
};

/** Cloudflare's own error shape, so `cf` prints the message as it prints any API error. */
function cloudflareApiError(status: number, message: string): Response {
  return new Response(cloudflareApiErrorBody(message), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function cloudflareApiErrorBody(message: string): string {
  return JSON.stringify({ success: false, errors: [{ code: 10000, message }], messages: [], result: null });
}

/** In a team's account only its admins read it directly: its authorization reaches every member's work. */
const TEAM_READ_REFUSAL =
  'In a team’s account only its admins read the account directly. Make the change itself: it goes to the ' +
  'team’s admins to approve.';

/** One request `cf` (or anything else in the container) sends to the Cloudflare API address. */
export async function handleCloudflareApiProxyRequest(
  request: Request,
  deps: CloudflareApiProxyDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== CLOUDFLARE_API_PROXY_HOST || !url.pathname.startsWith(API_PATH_PREFIX)) {
    return cloudflareApiError(404, `Only Cloudflare's API (${API_PATH_PREFIX}) is reached through this address.`);
  }
  const method = apiMethod(request.method.toUpperCase());
  if (!method) {
    return cloudflareApiError(405, `${request.method} requests are not sent to Cloudflare's API from the workspace.`);
  }
  const body = method === 'GET' ? { value: undefined } : await changeBody(request);
  if ('refusal' in body) {
    return cloudflareApiError(400, body.refusal);
  }
  const asked: CloudflareApiRequest = { method, url: `${CLOUDFLARE_API_ORIGIN}${url.pathname}${url.search}` };
  if (body.value !== undefined) {
    asked.body = body.value;
  }
  let canonical: CloudflareApiRequest;
  try {
    canonical = normalizeCloudflareApiRequest(asked, deps.accountId);
  } catch (error) {
    if (error instanceof CloudflareApiRequestRejectedError) {
      return cloudflareApiError(403, error.message);
    }
    throw error;
  }

  const access = await deps.access();
  if (access.kind === 'refused') {
    return cloudflareApiError(403, access.reason);
  }
  if (method === 'GET') {
    return access.kind === 'account'
      ? passThrough(await deps.send(canonical, request.signal))
      : cloudflareApiError(403, TEAM_READ_REFUSAL);
  }

  const command = await deps.command();
  if (!command) {
    // No agent command is running, so the person typed this in their own terminal: it is theirs to make.
    return access.kind === 'account'
      ? sendTerminalChange(canonical, request.signal, deps)
      : answerFor(await deps.fileForTeamAdmins(canonical));
  }
  return answerFor(await waitForDecision(command, canonical, request.signal, deps));
}

/**
 * A change the agent's command asked for, held while the person decides: each change of a command waits in that
 * command's card in turn, so one asked for while an earlier one still waits is queued behind it.
 */
async function waitForDecision(
  command: WorkspaceAgentCommand,
  canonical: CloudflareApiRequest,
  signal: AbortSignal,
  deps: CloudflareApiProxyDependencies,
): Promise<CloudflareChangeAnswer> {
  let answer = await deps.propose(command, canonical);
  while (answer.kind !== 'answer') {
    if (signal.aborted) {
      if (answer.kind === 'waiting') {
        await deps.withdraw(command, answer.executionId);
      }
      return refused(499, 'The command stopped before the change was approved, so nothing was sent.');
    }
    await deps.sleep(CLOUDFLARE_CHANGE_POLL_MS);
    if (answer.kind === 'waiting') {
      answer = await deps.outcome(command, answer.executionId);
      continue;
    }
    // Its turn comes once the change before it is decided, provided the command that asked still runs.
    const running = await deps.command();
    if (running?.agentName !== command.agentName || running.toolCallId !== command.toolCallId) {
      return refused(403, 'The command ended before this change could be approved, so nothing was sent.');
    }
    answer = await deps.propose(command, canonical);
  }
  return answer;
}

/** A change typed in the person's own terminal, sent at once with the account's credential and noted. */
async function sendTerminalChange(
  canonical: CloudflareApiRequest,
  signal: AbortSignal,
  deps: CloudflareApiProxyDependencies,
): Promise<Response> {
  const response = passThrough(await deps.send(canonical, signal));
  deps.recordTerminalChange({
    request: canonical,
    status: response.status,
    rayId: response.headers.get('cf-ray'),
  });
  return response;
}

function refused(status: number, message: string): CloudflareChangeAnswer {
  return { kind: 'answer', status, body: cloudflareApiErrorBody(message) };
}

function answerFor(answer: CloudflareChangeAnswer): Response {
  if (answer.kind !== 'answer') {
    return cloudflareApiError(502, 'The change was not settled, so nothing was sent.');
  }
  return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
}

/**
 * A change's body: JSON, as every change CloudChef records for approval is, and no larger than one may be. The
 * same rule holds for a change typed in the terminal, so what reaches the account is always a request CloudChef
 * can show and record.
 */
async function changeBody(request: Request): Promise<{ value: unknown } | { refusal: string }> {
  const { text, truncated } = await readBodyTextPrefix(request, MAX_CHANGE_BODY_BYTES + 1);
  if (truncated || new TextEncoder().encode(text).byteLength > MAX_CHANGE_BODY_BYTES) {
    return { refusal: 'The change is too large: CloudChef sends changes of up to 60 KiB.' };
  }
  if (text.trim() === '') {
    return { value: undefined };
  }
  const type = request.headers.get('content-type') ?? '';
  if (type !== '' && !/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
    return { refusal: `A ${type.split(';')[0]} request body isn't sent from the workspace; only JSON can be.` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { refusal: 'The request body is not valid JSON.' };
  }
}

/** Cloudflare's answer, with only the headers `cf` reads: nothing of the account's session reaches it. */
function passThrough(response: Response): Response {
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    return cloudflareApiError(502, 'Cloudflare answered with a redirect, which is not followed.');
  }
  const headers = new Headers();
  for (const name of ['content-type', 'cf-ray']) {
    const value = response.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Sends a request with a fresh access token, asking for a new one once if Cloudflare refuses it (a refused token
 * changes nothing, so the request is sent again as it was). The token never leaves this Worker: it is not in the
 * answer, and redirects are not followed.
 */
export async function sendCloudflareRequest(
  request: CloudflareApiRequest,
  signal: AbortSignal,
  accessToken: (options?: { forceRefresh?: boolean }) => Promise<string>,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const send = async (token: string) => {
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json' });
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
    }
    return fetcher(request.url, { method: request.method, headers, body, redirect: 'manual', signal });
  };
  let token: string;
  try {
    token = await accessToken();
  } catch {
    return cloudflareApiError(503, 'The Cloudflare account’s authorization is unavailable right now.');
  }
  const first = await send(token);
  if (first.status !== 401) {
    return first;
  }
  await first.body?.cancel().catch(() => undefined);
  try {
    token = await accessToken({ forceRefresh: true });
  } catch {
    return cloudflareApiError(503, 'The Cloudflare account’s authorization is unavailable right now.');
  }
  return send(token);
}
