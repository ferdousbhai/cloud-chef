import {
  CloudflareApiRequestRejectedError,
  normalizeCloudflareApiRequest,
  type CloudflareApiRequest,
} from 'cloudchef-agent/cloudflare-api';
import { readBodyTextPrefix } from '~/lib/bounded-body';

/**
 * `cf` in the workspace container sends its Cloudflare API requests to this address (its
 * `CLOUDFLARE_API_BASE_URL`), and the runtime's CloudflareApiProxy answers them. The container holds no
 * credential: the proxy puts the account's own in place of the stand-in token `cf` sends, reads pass, and
 * every change waits for the person's approval in the chat (a team member's goes to the team's admins).
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

/** What the agent says of a change: its answer for `cf`, or that it still waits for a decision. */
export type CloudflareChangeAnswer =
  { kind: 'answer'; status: number; body: string } | { kind: 'waiting'; executionId: string };

export type CloudflareApiProxyDependencies = {
  accountId: string;
  /** Why this person may not read the account directly, or null when they may (its owner, or a team's admin). */
  readRefusal(): Promise<string | null>;
  /** Sends a read with the account's credential, which stays outside the container. */
  read(request: CloudflareApiRequest, signal: AbortSignal): Promise<Response>;
  /** The agent's command running in the container now, if one is. */
  command(): Promise<WorkspaceAgentCommand | null>;
  propose(command: WorkspaceAgentCommand, request: CloudflareApiRequest): Promise<CloudflareChangeAnswer>;
  outcome(command: WorkspaceAgentCommand, executionId: string): Promise<CloudflareChangeAnswer>;
  /** The command stopped while its change waited: nothing is sent. */
  withdraw(command: WorkspaceAgentCommand, executionId: string): Promise<void>;
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

const NOT_FROM_AGENT =
  'Changes to the Cloudflare account are made only from a command the agent runs, after the person approves them.';

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

  if (method === 'GET') {
    const refusal = await deps.readRefusal();
    if (refusal) {
      return cloudflareApiError(403, refusal);
    }
    return passThrough(await deps.read(canonical, request.signal));
  }

  const command = await deps.command();
  if (!command) {
    return cloudflareApiError(403, NOT_FROM_AGENT);
  }
  let answer = await deps.propose(command, canonical);
  while (answer.kind === 'waiting') {
    if (request.signal.aborted) {
      await deps.withdraw(command, answer.executionId);
      return cloudflareApiError(499, 'The command stopped before the change was approved, so nothing was sent.');
    }
    await deps.sleep(CLOUDFLARE_CHANGE_POLL_MS);
    answer = await deps.outcome(command, answer.executionId);
  }
  return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
}

/** A change's body: JSON, as every change CloudChef records for approval is, and no larger than one may be. */
async function changeBody(request: Request): Promise<{ value: unknown } | { refusal: string }> {
  const { text, truncated } = await readBodyTextPrefix(request, MAX_CHANGE_BODY_BYTES + 1);
  if (truncated || new TextEncoder().encode(text).byteLength > MAX_CHANGE_BODY_BYTES) {
    return { refusal: 'The change is too large to send for approval.' };
  }
  if (text.trim() === '') {
    return { value: undefined };
  }
  const type = request.headers.get('content-type') ?? '';
  if (type !== '' && !/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
    return { refusal: `A ${type.split(';')[0]} request body can't be sent for approval; only JSON can.` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { refusal: 'The request body is not valid JSON.' };
  }
}

/** Cloudflare's answer to a read, with only the headers `cf` reads: nothing of the account's session reaches it. */
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
 * Sends a read with a fresh access token, asking for a new one once if Cloudflare refuses it. The token never
 * leaves this Worker: it is not in the answer, and redirects are not followed.
 */
export async function sendCloudflareRead(
  request: CloudflareApiRequest,
  signal: AbortSignal,
  accessToken: (options?: { forceRefresh?: boolean }) => Promise<string>,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const send = async (token: string) =>
    fetcher(request.url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      signal,
    });
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
