import { describe, expect, it } from 'vitest';
import { versionAction } from './version';

describe('versionAction', () => {
  it('returns deployment identifiers without allowing the response to be cached', async () => {
    const response = versionAction({
      env: {
        COMMIT_SHA: 'test-commit-sha',
        CLOUDFLARE_OAUTH_CLIENT_ID: 'client-id',
        CLOUDFLARE_OAUTH_CLIENT_SECRET: 'client-secret',
        CF_VERSION_METADATA: {
          id: '11111111-2222-3333-4444-555555555555',
          tag: '',
          timestamp: '2026-07-17T16:53:51.784Z',
        },
      } as unknown as Env,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      sha: 'test-commit-sha',
      versionId: '11111111-2222-3333-4444-555555555555',
      oauthConfigured: true,
    });
  });

  it('reports incomplete OAuth configuration without exposing binding values', async () => {
    const response = versionAction({ env: {} as Env });

    expect(await response.json()).toEqual({ sha: null, versionId: null, oauthConfigured: false });
  });
});
