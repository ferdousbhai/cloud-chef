import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CloudflareApiRequest } from 'cloudchef-agent/cloudflare-api';
import {
  CLOUDFLARE_API_PROXY_BASE_URL,
  CLOUDFLARE_API_PROXY_TOKEN,
  handleCloudflareApiProxyRequest,
  sendCloudflareRequest,
  type CloudflareAccountAccess,
  type CloudflareApiProxyDependencies,
  type CloudflareChangeAnswer,
} from './cloudflare-api-proxy';

const ACCOUNT = 'account-1';
const COMMAND = { agentName: 'chat-1', toolCallId: 'exec-1' };

const FILED: CloudflareChangeAnswer = {
  kind: 'answer',
  status: 202,
  body: '{"success":false,"errors":[{"code":10000,"message":"Not changed yet: this was sent to the team’s admins."}]}',
};

function harness(
  options: {
    access?: CloudflareAccountAccess;
    command?: typeof COMMAND | null;
    answers?: CloudflareChangeAnswer[];
    send?: (request: CloudflareApiRequest) => Response;
  } = {},
) {
  const answers = [...(options.answers ?? [{ kind: 'answer', status: 200, body: '{"success":true}' }])];
  const deps = {
    accountId: ACCOUNT,
    access: vi.fn(async (): Promise<CloudflareAccountAccess> => options.access ?? { kind: 'account' }),
    send: vi.fn(async (request: CloudflareApiRequest) =>
      options.send ? options.send(request) : Response.json({ success: true, result: [] }),
    ),
    command: vi.fn(async () => (options.command === undefined ? COMMAND : options.command)),
    propose: vi.fn(async () => answers.shift()!),
    outcome: vi.fn(async () => answers.shift()!),
    withdraw: vi.fn(async () => undefined),
    fileForTeamAdmins: vi.fn(async () => FILED),
    recordTerminalChange: vi.fn(),
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
      send: () =>
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
    expect(deps.send).toHaveBeenCalledWith(
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
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('refuses a method the API is not used with', async () => {
    const deps = harness();
    const response = await handleCloudflareApiProxyRequest(fromContainer('HEAD', `/accounts/${ACCOUNT}`), deps);

    expect(response.status).toBe(405);
    expect(deps.send).not.toHaveBeenCalled();
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
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.propose).not.toHaveBeenCalled();
  });

  it("refuses a team member's read, since only a team's admins read its account", async () => {
    const deps = harness({ access: { kind: 'team_member' } });
    const response = await handleCloudflareApiProxyRequest(
      fromContainer('GET', `/accounts/${ACCOUNT}/workers/scripts`),
      deps,
    );

    expect(response.status).toBe(403);
    expect(await errorMessage(response)).toContain('only its admins read');
    expect(deps.send).not.toHaveBeenCalled();
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
    // The agent's change is never sent from here: only the agent sends it, once it is approved.
    expect(deps.send).not.toHaveBeenCalled();
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

  it("sends a change typed in the person's own terminal at once, as the account, and notes it", async () => {
    const deps = harness({
      command: null,
      send: () =>
        new Response('{"success":true,"result":{"uuid":"db-1"}}', {
          status: 200,
          headers: { 'content-type': 'application/json', 'cf-ray': 'ray-2', 'set-cookie': 'session=secret' },
        }),
    });
    const response = await handleCloudflareApiProxyRequest(
      fromContainer('POST', `/accounts/${ACCOUNT}/d1/database`, { body: '{"name":"db"}', type: 'application/json' }),
      deps,
    );

    const sent = {
      method: 'POST',
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database`,
      body: { name: 'db' },
    };
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"success":true,"result":{"uuid":"db-1"}}');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(deps.send).toHaveBeenCalledWith(sent, expect.any(AbortSignal));
    expect(deps.recordTerminalChange).toHaveBeenCalledWith({ request: sent, status: 200, rayId: 'ray-2' });
    // The person typed it themselves: nothing waits for an approval.
    expect(deps.propose).not.toHaveBeenCalled();
    expect(deps.fileForTeamAdmins).not.toHaveBeenCalled();
  });

  it("files a team member's change typed in the terminal with the team's admins, sending nothing", async () => {
    const deps = harness({ command: null, access: { kind: 'team_member' } });
    const response = await handleCloudflareApiProxyRequest(
      fromContainer('DELETE', `/accounts/${ACCOUNT}/workers/scripts/site`),
      deps,
    );

    expect(response.status).toBe(202);
    expect(await errorMessage(response)).toContain('sent to the team’s admins');
    expect(deps.fileForTeamAdmins).toHaveBeenCalledWith({
      method: 'DELETE',
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/site`,
    });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.recordTerminalChange).not.toHaveBeenCalled();
  });

  it('refuses a change in a workspace that may not use the account', async () => {
    const deps = harness({ command: null, access: { kind: 'refused', reason: 'This workspace is not connected.' } });
    const response = await handleCloudflareApiProxyRequest(
      fromContainer('POST', `/accounts/${ACCOUNT}/d1/database`, { body: '{"name":"db"}', type: 'application/json' }),
      deps,
    );

    expect(response.status).toBe(403);
    expect(await errorMessage(response)).toBe('This workspace is not connected.');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.fileForTeamAdmins).not.toHaveBeenCalled();
  });

  it("queues a command's next change behind the one still waiting, then holds it for its own decision", async () => {
    const deps = harness({
      answers: [
        { kind: 'queued' },
        { kind: 'queued' },
        { kind: 'waiting', executionId: 'execution-2' },
        { kind: 'answer', status: 200, body: '{"success":true,"result":null}' },
      ],
    });

    const response = await handleCloudflareApiProxyRequest(
      fromContainer('DELETE', `/accounts/${ACCOUNT}/workers/scripts/older`),
      deps,
    );

    expect(response.status).toBe(200);
    expect(deps.propose).toHaveBeenCalledTimes(3);
    expect(deps.outcome).toHaveBeenCalledWith(COMMAND, 'execution-2');
    expect(deps.send).not.toHaveBeenCalled();
  });

  it('sends nothing for a queued change whose command ended before its turn', async () => {
    const deps = harness({ answers: [{ kind: 'queued' }] });
    deps.command.mockResolvedValueOnce(COMMAND).mockResolvedValue(null);

    const response = await handleCloudflareApiProxyRequest(
      fromContainer('DELETE', `/accounts/${ACCOUNT}/workers/scripts/older`),
      deps,
    );

    expect(response.status).toBe(403);
    expect(await errorMessage(response)).toContain('nothing was sent');
    expect(deps.propose).toHaveBeenCalledTimes(1);
    expect(deps.withdraw).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'name=db', 'application/x-www-form-urlencoded', 'only JSON can be'],
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
    expect(deps.send).not.toHaveBeenCalled();
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

describe('sendCloudflareRequest', () => {
  const read = {
    method: 'GET' as const,
    url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`,
  };

  it('adds the account’s token outside the container and follows no redirect', async () => {
    const { fetcher, calls } = fakeFetch(async () => Response.json({ success: true }));
    await sendCloudflareRequest(read, new AbortController().signal, async () => 'real-token', fetcher);

    expect(calls).toEqual([{ url: read.url, init: expect.objectContaining({ method: 'GET', redirect: 'manual' }) }]);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer real-token');
  });

  it('sends a change with its JSON body', async () => {
    const { fetcher, calls } = fakeFetch(async () => Response.json({ success: true }));
    await sendCloudflareRequest(
      { method: 'POST', url: read.url.replace('/workers/scripts', '/d1/database'), body: { name: 'db' } },
      new AbortController().signal,
      async () => 'real-token',
      fetcher,
    );

    expect(calls[0]?.init).toMatchObject({ method: 'POST', body: '{"name":"db"}' });
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json');
  });

  it('asks for a fresh token once when Cloudflare refuses the one it had', async () => {
    const tokens = ['stale-token', 'fresh-token'];
    const accessToken = vi.fn(async () => tokens.shift()!);
    const answers = [new Response('unauthorized', { status: 401 }), Response.json({ success: true })];
    const { fetcher, calls } = fakeFetch(async () => answers.shift()!);

    const response = await sendCloudflareRequest(read, new AbortController().signal, accessToken, fetcher);

    expect(response.status).toBe(200);
    expect(accessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe('Bearer fresh-token');
  });

  it('answers in Cloudflare’s error shape when the authorization can’t be had, sending nothing', async () => {
    const { fetcher, calls } = fakeFetch(async () => Response.json({ success: true }));
    const response = await sendCloudflareRequest(
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
