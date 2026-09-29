import { z } from 'zod';

export const CLOUDFLARE_EXECUTION_APPROVAL_TTL_MS = 15 * 60_000;

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

const queryValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The model-facing input: exactly what `cf <command> --dry-run` prints. The model discovers the
 * operation with the `cf` CLI in the credential-free workspace and passes its output through
 * unchanged; the runtime Worker alone holds the credential that sends it.
 */
/**
 * Models often re-serialize the dry-run's JSON body into a string. Sent as-is it would be encoded
 * twice and Cloudflare would reject it, so a string holding a JSON object or array is parsed back.
 */
const dryRunBodySchema = z.unknown().transform((body) => {
  if (body !== String(body)) {
    return body;
  }
  try {
    const parsed = z
      .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
      .safeParse(JSON.parse(String(body)));
    return parsed.success ? parsed.data : body;
  } catch {
    return body;
  }
});

export const cloudflareApiRequestInputSchema = cloudflareApiRequestSchema.extend({
  body: dryRunBodySchema.optional(),
  command: z.string().max(512).optional(),
  pathParams: z.record(z.string(), z.unknown()).optional(),
  query: z.record(z.string(), z.union([queryValueSchema, z.array(queryValueSchema)])).optional(),
  bodyKind: z.string().max(64).optional(),
});
export type CloudflareApiRequestInput = z.infer<typeof cloudflareApiRequestInputSchema>;

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
export function normalizeCloudflareApiRequest(
  request: CloudflareApiRequestInput,
  accountId: string,
): CloudflareApiRequest {
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
  for (const [name, value] of Object.entries(request.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item));
    }
  }
  if (request.bodyKind !== undefined && request.bodyKind !== 'none' && request.bodyKind !== 'json') {
    throw new CloudflareApiRequestRejectedError(
      `A ${request.bodyKind} request body cannot be sent; only JSON is supported.`,
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

/** Browser-safe projection of a durable approval record. It never contains credentials or raw responses. */
export type CloudflareExecutionPublicState = {
  executionId: string;
  toolCallId: string;
  accountId: string;
  proposalSha256: string;
  status: CloudflareExecutionStatus;
  createdAt: number;
  decidedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  outcome: CloudflareExecutionSafeOutcome | null;
};

export type CloudflareExecutionDecisionResult = {
  execution: CloudflareExecutionPublicState;
  resumeTurn: boolean;
};

export type CloudflareExecutionDecisionHandler = (
  executionId: string,
  decision: 'approve' | 'reject',
) => Promise<CloudflareExecutionDecisionResult>;

export type CloudflareRequestProposal = {
  kind: 'cloudflare_request_proposal';
  status: 'awaiting_approval';
  executionId: string;
  toolCallId: string;
  accountId: string;
  request: CloudflareApiRequest;
  proposalSha256: string;
  riskNote: string;
  expiresAt: number;
};

export type CloudflareRequestImmediateResult = {
  kind: 'cloudflare_request_result';
  status: 'success' | 'failure' | 'insufficient_scope';
  accountId: string;
  content?: string;
  requestId: string | null;
  httpStatus: number | null;
  truncated: boolean;
};

export type CloudflareRequestFinalResult = {
  kind: 'cloudflare_request_final_result';
  executionId: string;
  accountId: string;
  proposalSha256: string;
  status: Exclude<CloudflareExecutionStatus, 'awaiting_approval' | 'approved' | 'executing'>;
  outcome: CloudflareExecutionSafeOutcome;
};
