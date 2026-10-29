import { z } from 'zod';

/**
 * How long a change waits for the person inside the command that asked: just under that command's own deadline
 * (exec's 35 minutes), so `cf` is answered before the command is stopped. A change still undecided then stays
 * waiting in the chat, with no deadline, and the command goes on.
 */
export const CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS = 34 * 60_000;
/** What `cf` is told of a change its command no longer waits for: it waits in the chat instead. */
export const CLOUDFLARE_CHANGE_WAITING_IN_CHAT =
  'Not changed yet: waiting for your approval in the chat. It will be sent when you approve it.';
/** How long a team member's change waits for one of the team's admins on the Approvals page. */
export const TEAM_APPROVAL_TTL_MS = 7 * 24 * 60 * 60_000;

const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
const CLOUDFLARE_API_PATH_PREFIX = '/client/v4/';
const CLOUDFLARE_API_MAX_REQUEST_BODY_BYTES = 60 * 1024;

const CLOUDFLARE_API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type CloudflareApiMethod = (typeof CLOUDFLARE_API_METHODS)[number];

/** One canonical Cloudflare API request: the exact method, URL, and JSON body the owner approves. */
export type CloudflareApiRequest = {
  method: CloudflareApiMethod;
  url: string;
  body?: unknown;
};

export const cloudflareApiRequestSchema = z
  .object({
    method: z.enum(CLOUDFLARE_API_METHODS),
    url: z.string().min(1).max(4_096),
    body: z.unknown().optional(),
  })
  .strict() satisfies z.ZodType<CloudflareApiRequest>;

/** A tolerant view of a stored or streamed request, for rendering it without re-validating policy. */
export const cloudflareApiRequestDisplaySchema = z.looseObject({
  method: z.string(),
  url: z.string(),
  body: z.unknown().optional(),
});
export type CloudflareApiRequestDisplay = z.infer<typeof cloudflareApiRequestDisplaySchema>;

export class CloudflareApiRequestRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareApiRequestRejectedError';
  }
}

/**
 * Canonicalize a request and hold it to the connected account. Only the public v4 API is reachable,
 * and an `/accounts/{id}` path must name the account CloudChef is connected to; every other account
 * is rejected before a credential is resolved.
 */
export function normalizeCloudflareApiRequest(request: CloudflareApiRequest, accountId: string): CloudflareApiRequest {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new CloudflareApiRequestRejectedError('The Cloudflare API request URL is not a valid absolute URL.');
  }
  if (
    url.origin !== CLOUDFLARE_API_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(CLOUDFLARE_API_PATH_PREFIX)
  ) {
    throw new CloudflareApiRequestRejectedError(
      `Only ${CLOUDFLARE_API_ORIGIN}${CLOUDFLARE_API_PATH_PREFIX} is reachable.`,
    );
  }
  const segments = url.pathname.slice(CLOUDFLARE_API_PATH_PREFIX.length).split('/');
  if (segments[0] === 'accounts' && segments[1] !== undefined && segments[1] !== '' && segments[1] !== accountId) {
    throw new CloudflareApiRequestRejectedError(
      'The request names another Cloudflare account. CloudChef only acts on the connected account.',
    );
  }
  if (request.body !== undefined && request.method === 'GET') {
    throw new CloudflareApiRequestRejectedError('A GET request cannot carry a body.');
  }
  if (request.body === undefined) {
    return { method: request.method, url: url.href };
  }
  const bodyBytes = new TextEncoder().encode(JSON.stringify(request.body)).byteLength;
  if (bodyBytes > CLOUDFLARE_API_MAX_REQUEST_BODY_BYTES) {
    throw new CloudflareApiRequestRejectedError('The Cloudflare API request body is too large.');
  }
  return { method: request.method, url: url.href, body: request.body };
}

/** Reads run immediately; every other method changes account state and needs the owner's approval. */
export function cloudflareApiRequestIsRead(request: { method: string }): boolean {
  return request.method === 'GET';
}

export type CloudflareExecutionStatus =
  'awaiting_approval' | 'approved' | 'rejected' | 'executing' | 'succeeded' | 'failed' | 'indeterminate' | 'expired';

export type CloudflareExecutionSafeOutcome = {
  status: 'success' | 'failure' | 'insufficient_scope' | 'indeterminate' | 'denied';
  summary: string;
  content?: string;
  requestId?: string | null;
  httpStatus?: number | null;
  truncated?: boolean;
  sensitiveContentWithheld?: boolean;
};

/**
 * Browser-safe projection of a durable approval record: the exact request to approve and what became of it. It
 * never contains credentials.
 */
export type CloudflareExecutionPublicState = {
  executionId: string;
  /** The agent command that asked for the change, in whose place in the chat it is approved. */
  toolCallId: string;
  accountId: string;
  proposalSha256: string;
  status: CloudflareExecutionStatus;
  createdAt: number;
  decidedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  /**
   * When the command that asked stopped waiting for it (its time ran out, `cf` stopped, or the command ended) while
   * it still waited for the person: from then on it waits in the chat with no deadline, and what the person decides
   * reaches the agent in that command's output. Null while the command still waits for it.
   */
  leftWaitingAt: number | null;
  outcome: CloudflareExecutionSafeOutcome | null;
  request: CloudflareApiRequest;
  riskNote: string;
};

export type CloudflareExecutionDecisionResult = { execution: CloudflareExecutionPublicState };

export type CloudflareExecutionDecisionHandler = (
  executionId: string,
  decision: 'approve' | 'reject',
) => Promise<CloudflareExecutionDecisionResult>;

/**
 * A team member's change, filed for the team's admins: one of them approves or rejects it on the Approvals page,
 * and CloudChef itself sends it. The command that asked keeps it in its output, and its result replaces it there
 * once it is decided.
 */
export type CloudflareRequestFiled = {
  kind: 'cloudflare_request_filed';
  status: 'awaiting_team_admin';
  approvalId: string;
  accountId: string;
  request: CloudflareApiRequest;
  riskNote: string;
  expiresAt: number;
  note: string;
};

/**
 * A change in the person's own account that the command ended without: it waits in the chat for the person, and
 * what they decide replaces it in the command's output.
 */
export type CloudflareChangeWaitingInChat = {
  kind: 'cloudflare_change_waiting_in_chat';
  executionId: string;
  accountId: string;
  request: CloudflareApiRequest;
  note: string;
};

/** The changes a finished command asked for, in its output: each one waiting, or what was decided. */
export type CloudflareCommandChange =
  CloudflareRequestFiled | CloudflareChangeWaitingInChat | CloudflareRequestFinalResult;

export type CloudflareRequestFinalResult = {
  kind: 'cloudflare_request_final_result';
  executionId: string;
  accountId: string;
  proposalSha256: string;
  status: Exclude<CloudflareExecutionStatus, 'awaiting_approval' | 'approved' | 'executing'>;
  outcome: CloudflareExecutionSafeOutcome;
};
