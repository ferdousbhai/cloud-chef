import { afterEach, describe, expect, it, vi } from 'vitest';
import { envWith } from '~/test/control-plane-d1';
import { NO_ACCOUNT_MODEL_SETTINGS } from '~/lib/workers-ai-model';
import {
  confirmUserWorkspaceAccess,
  modelRequestAccess,
  readAccountModelSettings,
  type ConfirmUserWorkspaceAccess,
  type UserWorkspaceAccess,
} from './user-workspace-cloudflare-credential';

function runtimeEnv(bindings: Partial<Env> = {}): Env {
  return envWith({
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_USER_ID: 'user-1',
    CLOUDFLARE_ACCOUNT_ID: 'account-1',
    CLOUDCHEF_CONNECTION_ID: 'connection-1',
    CLOUDCHEF_CONNECTION_GENERATION: '3',
    CLOUDCHEF_OAUTH_SCOPE_GRANT_STATUS: 'full',
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build',
    CONTROL_PLANE_SECRET: 'runtime-secret',
    ...bindings,
  });
}

const identity = { userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 3 };

/** A control plane that answers the access check with `answer`. */
function answering(answer: UserWorkspaceAccess | null): ConfirmUserWorkspaceAccess {
  return async () => answer;
}

const unreachable: ConfirmUserWorkspaceAccess = async () => {
  throw new Error('The CloudChef control plane could not confirm workspace access.');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('confirmUserWorkspaceAccess', () => {
  it("reads the person's AI Gateway logging choice, and an answer without it as not logged", async () => {
    const respond = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', respond);

    respond.mockResolvedValueOnce(Response.json({ organizationAdmin: false, aiGatewayContentLogging: true }));
    expect(await confirmUserWorkspaceAccess(runtimeEnv(), identity)).toEqual({
      organizationAdmin: false,
      aiGatewayContentLogging: true,
    });
    // A control plane from before the setting existed: nothing says the person allows it.
    respond.mockResolvedValueOnce(Response.json({ organizationAdmin: true }));
    expect(await confirmUserWorkspaceAccess(runtimeEnv(), identity)).toEqual({
      organizationAdmin: true,
      aiGatewayContentLogging: false,
    });
    respond.mockResolvedValueOnce(new Response('not json'));
    expect(await confirmUserWorkspaceAccess(runtimeEnv(), identity)).toEqual({
      organizationAdmin: false,
      aiGatewayContentLogging: false,
    });
    respond.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await confirmUserWorkspaceAccess(runtimeEnv(), identity)).toBeNull();

    expect(String(respond.mock.calls[0]?.[0])).toBe('https://cloudchef.build/api/cloudflare/runtime-access');
  });
});

describe('readAccountModelSettings', () => {
  it("reads the account's chosen default and its gateway's provider keys, and anything unlearnable as neither", async () => {
    const respond = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', respond);

    const gatewayKeys = [
      { provider: 'anthropic', alias: 'sg' },
      { provider: 'openrouter', alias: 'default' },
    ];
    respond.mockResolvedValueOnce(
      Response.json({ defaultModelId: 'anthropic/claude-opus-5-5', gatewayKeys, claude: true }),
    );
    expect(await readAccountModelSettings(runtimeEnv())).toEqual({
      defaultModelId: 'anthropic/claude-opus-5-5',
      gatewayKeys,
    });
    const [url, init] = respond.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://cloudchef.build/api/cloudflare/runtime-models');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer runtime-secret' });
    expect(JSON.parse(String(init?.body))).toEqual(identity);

    // A provider CloudChef does not know, or an alias that cannot be one, is no key at all.
    respond.mockResolvedValueOnce(
      Response.json({ defaultModelId: 7, gatewayKeys: [{ provider: 'fireworks', alias: 'default' }] }),
    );
    expect(await readAccountModelSettings(runtimeEnv())).toEqual(NO_ACCOUNT_MODEL_SETTINGS);
    respond.mockResolvedValueOnce(Response.json({ gatewayKeys: [{ provider: 'openai', alias: '' }] }));
    expect(await readAccountModelSettings(runtimeEnv())).toEqual(NO_ACCOUNT_MODEL_SETTINGS);
    respond.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await readAccountModelSettings(runtimeEnv())).toEqual(NO_ACCOUNT_MODEL_SETTINGS);
    respond.mockRejectedValueOnce(new Error('unreachable'));
    expect(await readAccountModelSettings(runtimeEnv())).toEqual(NO_ACCOUNT_MODEL_SETTINGS);
    // No runtime identity: nothing to ask with.
    respond.mockClear();
    expect(await readAccountModelSettings(runtimeEnv({ CLOUDCHEF_USER_ID: '' }))).toEqual(NO_ACCOUNT_MODEL_SETTINGS);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('modelRequestAccess', () => {
  const logged = { organizationAdmin: false, aiGatewayContentLogging: true };
  const optedOut = { organizationAdmin: false, aiGatewayContentLogging: false };

  it("logs a request in a person's own account only when they allow it and that can be learned", async () => {
    const env = runtimeEnv();
    expect(await modelRequestAccess(env, answering(logged))).toEqual({
      allowed: true,
      contentLogging: true,
      report: null,
    });
    expect(await modelRequestAccess(env, answering(optedOut))).toMatchObject({ allowed: true, contentLogging: false });
    // Their own account's Workers AI is theirs to use, so the request goes ahead, just unlogged.
    expect(await modelRequestAccess(env, unreachable)).toMatchObject({ allowed: true, contentLogging: false });
    expect(await modelRequestAccess(env, answering(null))).toMatchObject({ allowed: true, contentLogging: false });
    expect(await modelRequestAccess(runtimeEnv({ CLOUDCHEF_USER_ID: '' }), answering(logged))).toMatchObject({
      allowed: true,
      contentLogging: false,
    });
  });

  it("in a team's account, refuses a member it no longer admits and honors each member's own choice", async () => {
    const env = runtimeEnv({ CLOUDCHEF_SHARED_ACCOUNT: '1' });
    const access = await modelRequestAccess(env, answering(logged));
    expect(access).toMatchObject({ allowed: true, contentLogging: true, report: expect.any(Function) });
    expect(await modelRequestAccess(env, answering(optedOut))).toMatchObject({ allowed: true, contentLogging: false });
    expect(await modelRequestAccess(env, answering(null))).toEqual({ allowed: false });
    await expect(modelRequestAccess(env, unreachable)).rejects.toThrow('could not confirm');
  });
});
