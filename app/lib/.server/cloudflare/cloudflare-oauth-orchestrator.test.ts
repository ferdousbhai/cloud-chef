import { describe, expect, test, vi } from 'vitest';
import { CORE_CLOUDFLARE_OAUTH_SCOPES } from './cloudflare-oauth-scope-manifest';
import { CloudflareOAuthError, CloudflareOAuthOrchestrator } from './cloudflare-oauth-orchestrator';

const scopes = CORE_CLOUDFLARE_OAUTH_SCOPES.join(' ');
const config = { clientId: 'client-1', clientSecret: 'client-secret', scopes };

describe('CloudflareOAuthOrchestrator', () => {
  test('starts authorization code + PKCE with server-owned state and no secret in the browser URL', async () => {
    const orchestrator = new CloudflareOAuthOrchestrator(config);
    const result = await orchestrator.startConnection({
      returnUrl:
        'https://cloudchef.build/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('response_mode')).toBeNull();
    expect(url.searchParams.get('state')).toBe('00000000-0000-4000-8000-000000000001');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cloudchef.build/api/cloudflare/connection/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(`${scopes} offline_access`);
    expect(url.searchParams.get('scope')).not.toContain('openid');
    expect(url.searchParams.get('scope')).not.toContain('profile');
    expect(url.searchParams.get('scope')).not.toContain('email');
    expect(result.authorizationUrl).not.toContain('client-secret');
    expect(JSON.parse(result.sessionId)).toMatchObject({
      redirectUri: 'https://cloudchef.build/api/cloudflare/connection/callback',
    });
  });

  test('fails closed when a required resource scope is not configured', async () => {
    const orchestrator = new CloudflareOAuthOrchestrator({
      ...config,
      scopes: CORE_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => scope !== 'workers-r2.write').join(' '),
    });
    await expect(
      orchestrator.startConnection({
        returnUrl:
          'https://cloudchef.build/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toThrow('workers-r2.write');
  });

  test('exchanges the callback code and requires exactly one authorized account', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token', expires_in: 3600 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { id: 'cf-user-1', email: 'person@example.com', first_name: 'Person' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'account-1', name: 'User account' }] }));
    const orchestrator = new CloudflareOAuthOrchestrator(config, request);
    const challenge = await orchestrator.startConnection({
      returnUrl:
        'https://cloudchef.build/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
    });
    await expect(
      orchestrator.completeConnection({
        providerSessionId: challenge.sessionId,
        callbackUrl:
          'https://cloudchef.build/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001&code=code-1',
      }),
    ).resolves.toEqual({
      user: {
        subject: 'cf-user-1',
        email: 'person@example.com',
        name: 'Person',
        picture: null,
      },
      accountId: 'account-1',
      accountName: 'User account',
      accessToken: 'oauth-access-token',
      refreshToken: 'oauth-refresh-token',
      accessTokenExpiresAt: expect.any(Number),
      // Derived from the confirmed grant, not echoed from the request: the core scopes cover
      // every product capability.
      grantedCapabilities: ['workers', 'containers', 'd1', 'r2', 'kv', 'durable_objects', 'workers_ai'],
      requestedOAuthScopes: [...CORE_CLOUDFLARE_OAUTH_SCOPES],
      grantedOAuthScopes: [...CORE_CLOUDFLARE_OAUTH_SCOPES],
      oauthScopeProfileVersion: 'core-v1',
      oauthScopeGrantStatus: 'core',
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      'https://dash.cloudflare.com/oauth2/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: `Basic ${btoa('client-1:client-secret')}` }),
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/user',
      expect.objectContaining({ headers: { authorization: 'Bearer oauth-access-token' } }),
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'https://api.cloudflare.com/client/v4/accounts?per_page=2',
      expect.objectContaining({ headers: { authorization: 'Bearer oauth-access-token' } }),
    );
    expect(request.mock.contexts).toEqual([undefined, undefined, undefined]);
  });

  test('rejects multiple-account grants instead of guessing which account pays', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token' }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, result: { id: 'cf-user-1' } }))
      .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'one' }, { id: 'two' }] }));
    const orchestrator = new CloudflareOAuthOrchestrator(config, request);
    const challenge = await orchestrator.startConnection({
      returnUrl:
        'https://cloudchef.build/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
    });
    await expect(
      orchestrator.completeConnection({
        providerSessionId: challenge.sessionId,
        callbackUrl: 'https://cloudchef.build/api/cloudflare/connection/callback?code=code-1',
      }),
    ).rejects.toBeInstanceOf(CloudflareOAuthError);
  });

  test('rejects an access-only grant that cannot be refreshed', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: 'oauth-access-token' }));
    const orchestrator = new CloudflareOAuthOrchestrator(config, request);
    const challenge = await orchestrator.startConnection({
      returnUrl:
        'https://cloudchef.build/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
    });
    await expect(
      orchestrator.completeConnection({
        providerSessionId: challenge.sessionId,
        callbackUrl: 'https://cloudchef.build/api/cloudflare/connection/callback?code=code-1',
      }),
    ).rejects.toThrow('refresh token');
  });

  test('rejects a failed Cloudflare user details response', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token' }),
      )
      .mockResolvedValueOnce(Response.json({ success: false, result: null }, { status: 403 }));
    const orchestrator = new CloudflareOAuthOrchestrator(config, request);
    const challenge = await orchestrator.startConnection({
      returnUrl:
        'https://cloudchef.build/api/cloudflare/connection/callback?state=00000000-0000-4000-8000-000000000001',
    });

    await expect(
      orchestrator.completeConnection({
        providerSessionId: challenge.sessionId,
        callbackUrl: 'https://cloudchef.build/api/cloudflare/connection/callback?code=code-1',
      }),
    ).rejects.toBeInstanceOf(CloudflareOAuthError);
  });
});
