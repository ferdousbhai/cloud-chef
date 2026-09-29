import { describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_API_MAX_CONTENT_BYTES, CloudflareApiClient } from './cloudflare-api-client';

const url = 'https://api.cloudflare.com/client/v4/accounts/account-1/workers/scripts';
const signal = new AbortController().signal;

function client(responses: Array<Response | Error>, tokens = ['token-1', 'token-2']) {
  const resolveAccessToken = vi.fn(
    async (options?: { forceRefresh?: boolean }) => tokens[options?.forceRefresh ? 1 : 0],
  );
  const request = vi.fn(async () => {
    const next = responses.shift();
    if (!next || next instanceof Error) {
      throw next ?? new Error('no response');
    }
    return next;
  });
  // SAFETY: the stub implements the only fetch call shape the client uses.
  return {
    api: new CloudflareApiClient({ resolveAccessToken, request: request as typeof fetch }),
    request,
    resolveAccessToken,
  };
}

describe('CloudflareApiClient', () => {
  it('sends the exact request with a bearer token and returns the response', async () => {
    const { api, request } = client([
      new Response('{"success":true}', { status: 200, headers: { 'cf-ray': 'ray-1' } }),
    ]);

    await expect(api.send({ method: 'POST', url, body: { name: 'x' } }, signal)).resolves.toEqual({
      status: 'success',
      content: '{"success":true}',
      requestId: 'ray-1',
      httpStatus: 200,
      truncated: false,
    });
    expect(request).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: 'POST',
        body: '{"name":"x"}',
        redirect: 'manual',
        headers: expect.objectContaining({ authorization: 'Bearer token-1', 'content-type': 'application/json' }),
      }),
    );
  });

  it('refreshes the token once after a 401', async () => {
    const { api, resolveAccessToken } = client([
      new Response('', { status: 401 }),
      new Response('{}', { status: 200 }),
    ]);

    await expect(api.send({ method: 'GET', url }, signal)).resolves.toMatchObject({ status: 'success' });
    expect(resolveAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it('reports 403 as an insufficient scope and redacts the token from content', async () => {
    const { api } = client([new Response('denied for token-1', { status: 403 })]);

    await expect(api.send({ method: 'GET', url }, signal)).resolves.toMatchObject({
      status: 'insufficient_scope',
      content: 'denied for [REDACTED]',
    });
  });

  it('reports an unobserved result as indeterminate for the caller to classify', async () => {
    await expect(client([new TypeError('network')]).api.send({ method: 'DELETE', url }, signal)).resolves.toMatchObject(
      {
        status: 'indeterminate',
      },
    );
  });

  it('refuses redirects and truncates large content', async () => {
    await expect(
      client([new Response(null, { status: 302, headers: { location: 'https://example.com' } })]).api.send(
        { method: 'GET', url },
        signal,
      ),
    ).resolves.toMatchObject({ status: 'failure', httpStatus: 302 });
    const large = await client([new Response('x'.repeat(CLOUDFLARE_API_MAX_CONTENT_BYTES * 2))]).api.send(
      { method: 'GET', url },
      signal,
    );
    expect(large.truncated).toBe(true);
    expect(new TextEncoder().encode(large.content).byteLength).toBeLessThanOrEqual(CLOUDFLARE_API_MAX_CONTENT_BYTES);
  });

  it('keeps a truncated prefix of a response too large to read in full', async () => {
    const huge = await client([new Response('y'.repeat(4 * 1024 * 1024))]).api.send({ method: 'GET', url }, signal);
    expect(huge).toMatchObject({ status: 'success', truncated: true });
  });
});
