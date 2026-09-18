import { toolFailure, toolSuccess } from 'cloudchef-agent/tool-result';
import { MODEL_TOOL_INPUT_SCHEMAS } from 'cloudchef-agent/model-tool-inputs';
import type { Tool } from 'cloudchef-agent/tool';

/**
 * Cloudflare's own documentation search, the single useful tool exposed by the
 * public docs MCP server. The server is stateless under the 2026-07-28 spec, so
 * one request answers a query — no session, no OAuth, no MCP client.
 */
const DOCS_SEARCH_ENDPOINT = 'https://docs.mcp.cloudflare.com/mcp';
const DOCS_SEARCH_TOOL = 'search_cloudflare_documentation';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Transport guard only. Upstream bounds the answer itself by returning a fixed
 * number of ranked chunks — observed at 6 to 9 results, well under this — so the
 * excerpt is never trimmed. A trimmed excerpt would read as a whole one.
 */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUERY_CHARS = 512;
/** Upstream retries its own search; this covers the network in between. */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 150;

export function cloudflareDocsSearchTool(request: typeof fetch = fetch): Tool {
  return {
    description:
      "Search Cloudflare's documentation. Returns ranked excerpts with their source URLs; prefer it to recall for Workers, Wrangler, D1, R2, KV, Durable Objects, Workers AI, and any other Cloudflare question.",
    inputSchema: MODEL_TOOL_INPUT_SCHEMAS.search_cloudflare_docs,
    execute: async (input, options) => {
      const { query } = MODEL_TOOL_INPUT_SCHEMAS.search_cloudflare_docs.parse(input);
      options.abortSignal?.throwIfAborted();
      const trimmed = query.trim();
      if (!trimmed || trimmed.length > MAX_QUERY_CHARS) {
        return toolFailure(`Query must be 1 to ${MAX_QUERY_CHARS} characters.`);
      }
      try {
        const text = await searchWithRetries(request, trimmed, options.abortSignal);
        return text
          ? toolSuccess('Cloudflare documentation excerpts.', { content: text })
          : toolFailure('Cloudflare documentation search returned no match for that query.');
      } catch (error) {
        // The docs service is external and optional; a failure must not end the turn.
        return toolFailure(`Cloudflare documentation search is unavailable: ${errorMessage(error)}`);
      }
    },
  };
}

async function searchWithRetries(
  request: typeof fetch,
  query: string,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await callDocsSearch(request, query, abortSignal);
    } catch (error) {
      abortSignal?.throwIfAborted();
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
        throw error;
      }
      await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), abortSignal);
    }
  }
}

async function callDocsSearch(
  request: typeof fetch,
  query: string,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  const response = await request(DOCS_SEARCH_ENDPOINT, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: DOCS_SEARCH_TOOL, arguments: { query } },
    }),
  });
  if (!response.ok) {
    throw new DocsSearchHttpError(response.status);
  }
  return readContentText(await readBoundedText(response));
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    throw new Error('the service returned an empty body.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error('the response exceeded its size limit.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // The body is abandoned on the size guard and on an aborted turn; neither cares why the cancel failed.
    await reader.cancel().catch(() => undefined);
  }
  return `${chunks.join('')}${decoder.decode()}`;
}

/**
 * The endpoint answers a single JSON-RPC call as either JSON or a one-message
 * SSE stream, so both framings carry the same envelope.
 */
function readContentText(body: string): string {
  const payloads = body.startsWith('event:') || body.startsWith('data:') ? sseDataLines(body) : [body];
  for (const payload of payloads) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    if (parsed.error) {
      const message = isRecord(parsed.error) ? parsed.error.message : undefined;
      throw new Error(typeof message === 'string' ? message : 'the service reported an error.');
    }
    const content = isRecord(parsed.result) ? parsed.result.content : undefined;
    if (Array.isArray(content)) {
      return content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            isRecord(block) && block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .join('\n')
        .trim();
    }
  }
  throw new Error('the service returned an unrecognized response.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sseDataLines(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
}

class DocsSearchHttpError extends Error {
  constructor(readonly status: number) {
    super(`the service answered ${status}.`);
  }
}

/** Retry what the service may recover from; never a rejected query. */
function isRetryable(error: unknown): boolean {
  if (error instanceof DocsSearchHttpError) {
    return error.status >= 500 || error.status === 429;
  }
  // A timeout, a dropped connection, or a DNS failure — but not a refused redirect or a bad envelope.
  return error instanceof Error && error.name === 'TypeError';
}

function delay(ms: number, abortSignal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal?.reason);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
