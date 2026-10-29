import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CloudflareApiRequest } from 'cloudchef-agent/cloudflare-api';
import {
  CLOUDFLARE_API_PROXY_BASE_URL,
  CLOUDFLARE_API_PROXY_TOKEN,
  handleCloudflareApiProxyRequest,
  sendCloudflareRead,
  type CloudflareApiProxyDependencies,
  type CloudflareChangeAnswer,
} from './cloudflare-api-proxy';

const ACCOUNT = 'account-1';
const COMMAND = { agentName: 'chat-1', toolCallId: 'exec-1' };

function harness(
  options: {
    readRefusal?: string | null;
    command?: typeof COMMAND | null;
    answers?: CloudflareChangeAnswer[];
    read?: (request: CloudflareApiRequest) => Response;
  } = {},
) {
  const answers = [...(options.answers ?? [{ kind: 'answer', status: 200, body: '{"success":true}' }])];
  const deps = {
    accountId: ACCOUNT,
    readRefusal: vi.fn(async () => options.readRefusal ?? null),
    read: vi.fn(async (request: CloudflareApiRequest) =>
      options.read ? options.read(request) : Response.json({ success: true, result: [] }),
    ),
    command: vi.fn(async () => (options.command === undefined ? COMMAND : options.command)),
    propose: vi.fn(async () => answers.shift()!),
    outcome: vi.fn(async () => answers.shift()!),
    withdraw: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
  } satisfies CloudflareApiProxyDependencies;
  return deps;
}

/** A request as `cf` in the container sends it: to the proxy's address, with the stand-in token. */
function fromContainer(
  method: string,
  path: string,
  init: { body?: string; type?: string; signal?: AbortSignal } = {},
) {
  const headers = new Headers({ authorization: `Bearer ${CLOUDFLARE_API_PROXY_TOKEN}` });
  if (init.type) {
    headers.set('content-type', init.type);
  }
  return new Request(`${CLOUDFLARE_API_PROXY_BASE_URL}${path}`, {
    method,
    headers,
    body: init.body,
    signal: init.signal,
  });
}

const cloudflareErrorSchema = z.object({
  success: z.literal(false),
  errors: z.array(z.object({ message: z.string() })),
});

async function errorMessage(response: Response): Promise<string> {
  return cloudflareErrorSchema.parse(await response.json()).errors[0]!.message;
}

/** A stand-in for `fetch` that answers what each test says; only the calls it is given are read. */
function fakeFetch(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return answer();
  };
  return { fetcher, calls };
}

describe('Cloudflare API proxy', () => {
  it("sends a read of the connected account as the account itself, with nothing of the container's", async () => {
    const deps = harness({
      read: () =>
        new Response('{"success":true,"result":[{"id":"w"}]}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'cf-ray': 'ray-1', 'set-cookie': 'session=secret' },
        }),
    });

    const response = await handleCloudflareApiProxyRequest(
      fromContainer('GET', `/accounts/${ACCOUNT}/workers/scripts?per_page=50`),
      deps,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"success":true,"result":[{"id":"w"}]}');
    expect(response.headers.get('cf-ray')).toBe('ray-1');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(deps.read).toHaveBeenCalledWith(
      { method: 'GET', url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts?per_page=50` },
      expect.any(AbortSignal),
    );
    // A read never reaches the agent, and nothing waits for anyone.
    expect(deps.propose).not.toHaveBeenCalled();
    expect(deps.command).not.toHaveBeenCalled();
  });

  it.each([
    ['another host', 'https://api.cloudflare.com/client/v4/accounts'],
    ['a path outside the API', `${CLOUDFLARE_API_PROXY_BASE_URL.replace('/client/v4', '')}/admin`],
  ])('answers only for the API on its own address, not %s', async (_name, url) => {
    const deps = harness();
    const response = await handleCloudflareApiProxyRequest(new Request(url), deps);

    expect(response.status).toBe(404);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('refuses a method the API is not used with', async () => {
    const deps = harness();
    const response = await handleCloudflareApiProxyRequest(fromContainer('HEAD', `/accounts/${ACCOUNT}`), deps);

    expect(response.status).toBe(405);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', `/accounts/someone-else/workers/scripts`],
    ['GET', `/accounts/${ACCOUNT}/../someone-else/workers/scripts`],
    ['DELETE', `/accounts/someone-else/workers/scripts/site`],
  ])('refuses %s %s, which names another account, before anything is sent', async (method, path) => {
    const deps = harness();
    const response = await handleCloudflareApiProxyRequest(fromContainer(method, path), deps);

    expect(response.status).toBe(403);
    expect(await errorMessage(response)).toContain('another Cloudflare account');
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.propose).not.toHaveBeenCalled();
  });

  it("refuses a team member's read, since only a team's admins read its account", async () => {
    const deps = harness({ readRefusal: 'In a team’s account only its admins read the account directly.' });
    const response = await handleCloudflareApiProxyRequest(
      fromContainer('GET', `/accounts/${ACCOUNT}/workers/scripts`),
      deps,
    );

    expect(response.status).toBe(403);
    expect(await errorMessage(response)).toContain('only its admins read');
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('holds a change until the person decides, then answers with what Cloudflare said', async () => {
    const deps = harness({
      answers: [
        { kind: 'waiting', executionId: 'execution-1' },
        { kind: 'waiting', executionId: 'execution-1' },
        { kind: 'answer', status: 200, body: '{"success":true,"result":{"id":"domain-1"}}' },
      ],
    });
    const body = JSON.stringify({ hostname: 'shop.example.com', service: 'site' });

    const response = await handleCloudflareApiProxyRequest(
      fromContainer('PUT', `/accounts/${ACCOUNT}/workers/domains`, { body, type: 'application/json' }),
      deps,
    );

    expect(deps.propose).toHaveBeenCalledWith(COMMAND, {
      method: 'PUT',
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/domains`,
      body: { hostname: 'shop.example.com', service: 'site' },
    });
    expect(deps.outcome).toHaveBeenCalledTimes(2);
    expect(deps.outcome).toHaveBeenCalledWith(COMMAND, 'execution-1');
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"success":true,"result":{"id":"domain-1"}}');
    // A change is never sent from here: only the agent sends it, once it is approved.
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('passes on why a change was not made, as the agent says it', async () => {
    const deps = harness({
      answers: [
        { kind: 'waiting', executionId: 'execution-1' },
        {
          kind: 'answer',
          status: 403,
          body: '{"success":false,"errors":[{"code":10000,"message":"The person declined this change."}]}',
        },
      ],
    });

    const response = await handleCloudflareApiProxyRequest(
      fromContainer('DELETE', `/accounts/${ACCOUNT}/workers/scripts/site`),
      deps,
    );

    expect(response.status).toBe(403);
    expect(await errorMessage(response)).toBe('The person declined this change.');
    expect(deps.propose).toHaveBeenCalledWith(COMMAND, {
      method: 'DELETE',
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/site`,
    });
  });

  it('refuses a change that no agent command asked for, such as one typed in the terminal', async () => {
    const deps = harness({ command: null });
    const response = await handleCloudflareApiProxyRequest(
      fromContainer('POST', `/accounts/${ACCOUNT}/d1/database`, { body: '{"name":"db"}', type: 'application/json' }),
      deps,
    );

    expect(response.status).toBe(403);
    expect(await errorMessage(response)).toContain('only from a command the agent runs');
    expect(deps.propose).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'name=db', 'application/x-www-form-urlencoded', 'only JSON can'],
    ['malformed JSON', '{"name":', 'application/json', 'not valid JSON'],
    ['a body too large to record', JSON.stringify({ script: 'x'.repeat(61 * 1024) }), 'application/json', 'too large'],
  ])('refuses a change with %s before it is recorded', async (_name, body, type, message) => {
    const deps = harness();
    const response = await handleCloudflareApiProxyRequest(
      fromContainer('POST', `/accounts/${ACCOUNT}/d1/database`, { body, type }),
      deps,
    );

    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toContain(message);
    expect(deps.propose).not.toHaveBeenCalled();
  });

  it('withdraws a waiting change when the command that asked stops', async () => {
    const stop = new AbortController();
    const deps = harness({ answers: [{ kind: 'waiting', executionId: 'execution-1' }] });
    deps.sleep.mockImplementation(async () => {
      stop.abort();
      return undefined;
    });
    deps.outcome.mockResolvedValue({ kind: 'waiting', executionId: 'execution-1' });

    const response = await handleCloudflareApiProxyRequest(
      fromContainer('DELETE', `/accounts/${ACCOUNT}/workers/scripts/site`, { signal: stop.signal }),
      deps,
    );

    expect(deps.withdraw).toHaveBeenCalledWith(COMMAND, 'execution-1');
    expect(response.status).toBe(499);
    expect(await errorMessage(response)).toContain('nothing was sent');
  });
});

describe('sendCloudflareRead', () => {
  const read = {
    method: 'GET' as const,
    url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`,
  };

  it('adds the account’s token outside the container and follows no redirect', async () => {
    const { fetcher, calls } = fakeFetch(async () => Response.json({ success: true }));
    await sendCloudflareRead(read, new AbortController().signal, async () => 'real-token', fetcher);

    expect(calls).toEqual([
      {
        url: read.url,
        init: expect.objectContaining({
          method: 'GET',
          redirect: 'manual',
          headers: expect.objectContaining({ authorization: 'Bearer real-token' }),
        }),
      },
    ]);
  });

  it('asks for a fresh token once when Cloudflare refuses the one it had', async () => {
    const tokens = ['stale-token', 'fresh-token'];
    const accessToken = vi.fn(async () => tokens.shift()!);
    const answers = [new Response('unauthorized', { status: 401 }), Response.json({ success: true })];
    const { fetcher, calls } = fakeFetch(async () => answers.shift()!);

    const response = await sendCloudflareRead(read, new AbortController().signal, accessToken, fetcher);

    expect(response.status).toBe(200);
    expect(accessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(calls[1]?.init.headers).toMatchObject({ authorization: 'Bearer fresh-token' });
  });

  it('answers in Cloudflare’s error shape when the authorization can’t be had, sending nothing', async () => {
    const { fetcher, calls } = fakeFetch(async () => Response.json({ success: true }));
    const response = await sendCloudflareRead(
      read,
      new AbortController().signal,
      async () => {
        throw new Error('broker down');
      },
      fetcher,
    );

    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
  });
});
