import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudflareDocsSearchTool } from './cloudflare-docs-search';

const options = { toolCallId: 'call-1' };

function sse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function excerpt(text: string) {
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cloudflare documentation search', () => {
  it('sends one stateless tools/call and returns the excerpt', async () => {
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        sse(excerpt('<result><url>https://developers.cloudflare.com/d1/</url></result>')),
      );
    const tool = cloudflareDocsSearchTool();

    const result = await tool.execute!({ query: 'D1 batch limits' }, options);

    expect(result).toEqual({
      version: 1,
      ok: true,
      summary: 'Cloudflare documentation excerpts.',
      data: { content: '<result><url>https://developers.cloudflare.com/d1/</url></result>' },
    });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('https://docs.mcp.cloudflare.com/mcp');
    // A redirect means the request did not land where it was aimed, so its body cannot be trusted.
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: 'tools/call',
      params: { name: 'search_cloudflare_documentation', arguments: { query: 'D1 batch limits' } },
    });
  });

  it('reads a plain JSON body as well as an SSE frame', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(excerpt('plain json excerpt')));
    const tool = cloudflareDocsSearchTool();

    await expect(tool.execute!({ query: 'kv ttl' }, options)).resolves.toMatchObject({
      ok: true,
      data: { content: 'plain json excerpt' },
    });
  });

  it('surfaces a JSON-RPC error as a failed result', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      sse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad query' } }),
    );
    const tool = cloudflareDocsSearchTool();

    const result = (await tool.execute!({ query: 'x' }, options)) as { ok: boolean; summary: string };
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('bad query');
  });

  it('refuses a body that exceeds its transport limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('d'.repeat(2 * 1024 * 1024)));
    const tool = cloudflareDocsSearchTool();

    const result = (await tool.execute!({ query: 'huge' }, options)) as { ok: boolean; summary: string };
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('maximum allowed size');
  });

  it('retries a 503 and succeeds', async () => {
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(sse(excerpt('recovered')));
    const tool = cloudflareDocsSearchTool();

    await expect(tool.execute!({ query: 'retry me' }, options)).resolves.toMatchObject({
      ok: true,
      data: { content: 'recovered' },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('gives up after three attempts on a persistent 429', async () => {
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('slow down', { status: 429 }));
    const tool = cloudflareDocsSearchTool();

    await expect(tool.execute!({ query: 'rate limited' }, options)).resolves.toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 400, which the service will reject again', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad', { status: 400 }));
    const tool = cloudflareDocsSearchTool();

    await expect(tool.execute!({ query: 'bad request' }, options)).resolves.toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('honours an abort signal from the turn', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const tool = cloudflareDocsSearchTool();

    await expect(tool.execute!({ query: 'x' }, { ...options, abortSignal: AbortSignal.abort() })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
