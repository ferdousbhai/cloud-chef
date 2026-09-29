import type { CloudflareApiRequest } from 'cloudchef-agent/cloudflare-api';

const CLOUDFLARE_API_TIMEOUT_MS = 60_000;
export const CLOUDFLARE_API_MAX_CONTENT_BYTES = 48 * 1024;
/** Read past the kept content far enough that a bearer token straddling the cut is still redacted whole. */
const CLOUDFLARE_API_READ_BYTES = CLOUDFLARE_API_MAX_CONTENT_BYTES + 8 * 1024;
const TRUNCATION_SUFFIX = '\n--- TRUNCATED: narrow the request with query parameters such as per_page ---';

const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const requestIdPattern = /^[A-Za-z0-9-]{1,128}$/u;
const textEncoder = new TextEncoder();

export interface CloudflareAccessTokenResolution {
  forceRefresh?: boolean;
}

export type CloudflareApiOutcome = {
  /**
   * `indeterminate` means the request may have reached Cloudflare without CloudChef seeing the
   * result. For a write that must be reconciled with a read rather than retried; callers decide.
   */
  status: 'success' | 'failure' | 'insufficient_scope' | 'indeterminate';
  content: string;
  requestId: string | null;
  httpStatus: number | null;
  truncated: boolean;
};

interface CloudflareApiClientDependencies {
  resolveAccessToken(options?: CloudflareAccessTokenResolution): Promise<string>;
  request?: typeof fetch;
}

/**
 * Send one validated request to the public Cloudflare API with the user's OAuth access token.
 *
 * The token is resolved per request and never leaves this Worker: it is not returned, logged, or
 * reflected into content, and redirects are refused so it cannot follow a request elsewhere.
 */
export class CloudflareApiClient {
  private readonly request: typeof fetch;

  constructor(private readonly dependencies: CloudflareApiClientDependencies) {
    this.request = dependencies.request ?? fetch;
  }

  /** `request` must already be canonical: callers normalize it with `normalizeCloudflareApiRequest` at the tool boundary. */
  async send(request: CloudflareApiRequest, signal: AbortSignal): Promise<CloudflareApiOutcome> {
    let accessToken = await this.dependencies.resolveAccessToken();
    let response: Response;
    try {
      response = await this.fetchOnce(request, accessToken, signal);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        accessToken = await this.dependencies.resolveAccessToken({ forceRefresh: true });
        response = await this.fetchOnce(request, accessToken, signal);
      }
    } catch {
      signal.throwIfAborted();
      return {
        status: 'indeterminate',
        content: 'The Cloudflare API result was not observed. Read the current state before retrying a change.',
        requestId: null,
        httpStatus: null,
        truncated: false,
      };
    }

    const requestId = responseRequestId(response);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return {
        status: 'failure',
        content: 'The Cloudflare API redirect was refused.',
        requestId,
        httpStatus: response.status,
        truncated: false,
      };
    }

    let body: { text: string; more: boolean };
    try {
      body = await readTextPrefix(response, CLOUDFLARE_API_READ_BYTES);
    } catch {
      signal.throwIfAborted();
      return {
        status: response.ok ? 'indeterminate' : 'failure',
        content: 'The Cloudflare API response could not be read.',
        requestId,
        httpStatus: response.status,
        truncated: false,
      };
    }

    const { content, truncated } = boundedContent(redactBearerTokens(body.text, accessToken), body.more);
    return {
      status: response.ok ? 'success' : response.status === 403 ? 'insufficient_scope' : 'failure',
      content,
      requestId,
      httpStatus: response.status,
      truncated,
    };
  }

  private fetchOnce(request: CloudflareApiRequest, accessToken: string, signal: AbortSignal): Promise<Response> {
    const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    const send = this.request;
    return send(request.url, {
      method: request.method,
      headers: request.body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS)]),
    });
  }
}

function responseRequestId(response: Response): string | null {
  const value = response.headers.get('cf-ray') ?? response.headers.get('x-request-id');
  return value && requestIdPattern.test(value) ? value : null;
}

function redactBearerTokens(value: string, accessToken: string): string {
  return value.replace(bearerTokenPattern, '[REDACTED]').replaceAll(accessToken, '[REDACTED]');
}

/** Read at most `limit` bytes and cancel the rest, so a large listing costs only what is kept. */
async function readTextPrefix(response: Response, limit: number): Promise<{ text: string; more: boolean }> {
  if (!response.body) {
    return { text: '', more: false };
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  let more = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const kept = Math.min(value.byteLength, limit - length);
      bytes.set(value.subarray(0, kept), length);
      length += kept;
      if (kept < value.byteLength || length === limit) {
        more = kept < value.byteLength || !(await reader.read()).done;
        break;
      }
    }
  } finally {
    if (more) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, length)), more };
}

function boundedContent(value: string, more: boolean): Pick<CloudflareApiOutcome, 'content' | 'truncated'> {
  const bytes = textEncoder.encode(value);
  if (!more && bytes.byteLength <= CLOUDFLARE_API_MAX_CONTENT_BYTES) {
    return { content: value, truncated: false };
  }
  let end = Math.min(
    bytes.byteLength,
    CLOUDFLARE_API_MAX_CONTENT_BYTES - textEncoder.encode(TRUNCATION_SUFFIX).byteLength,
  );
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { content: `${new TextDecoder().decode(bytes.subarray(0, end))}${TRUNCATION_SUFFIX}`, truncated: true };
}
