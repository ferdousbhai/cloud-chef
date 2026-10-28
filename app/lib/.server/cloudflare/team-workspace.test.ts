import { afterEach, describe, expect, it, vi } from 'vitest';
import { D1CloudflareCredentialVault } from './cloudflare-credential-vault';
import { verifyRuntimeCapability } from '~/lib/cloudflare/runtime-capability';
import { deriveUserWorkspaceRuntimeSecret } from './user-workspace-runtime-secret';
import { ORG, teamFixture } from '~/test/project-fixture';
import { deleteTeamWorkspace } from './team-workspace';

const RUNTIME = 'https://cloudchef-workspace-sara.example.workers.dev';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deleting a member’s team workspace', () => {
  it('first has their runtime delete the branches their workspaces saved, as them, then deletes the runtime', async () => {
    const team = await teamFixture();
    const env = { ...team.env, CLOUDFLARE_OAUTH_CLIENT_ID: 'client', CLOUDFLARE_OAUTH_CLIENT_SECRET: 'secret' };
    const handle = await D1CloudflareCredentialVault.fromEnv(env).storeOAuthCredential({
      accessToken: 'team-token',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
    });
    team.database
      .prepare(`UPDATE cloudflare_authorizations SET credential_handle = ? WHERE account_id = 'account-team'`)
      .run(handle);
    team.database
      .prepare(
        `INSERT INTO user_computer_runtimes (user_id, connection_id, connection_generation, worker_name, endpoint,
           runtime_version, status, created_at, updated_at)
         VALUES (?, 'team-connection', 2, 'cloudchef-workspace-sara', ?, 'v', 'ready', 1, 1)`,
      )
      .run(team.sara.userId, RUNTIME);
    const calls: { url: string; method: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization') });
        return request.url.startsWith(RUNTIME)
          ? Response.json({ workspaces: 1, failed: 0 })
          : Response.json({ success: true, result: [] });
      }),
    );

    await deleteTeamWorkspace(env, ORG, team.sara.userId);

    expect(calls[0]).toMatchObject({ url: `${RUNTIME}/v1/workspaces/forget-saved-branches`, method: 'POST' });
    const secret = await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY ?? '',
      userId: team.sara.userId,
      accountId: 'account-team',
      connectionGeneration: 2,
      organizationConnectionId: 'team-connection',
    });
    const capability = await verifyRuntimeCapability(secret, calls[0]?.authorization?.replace('Bearer ', '') ?? '', {
      origin: 'https://cloudchef.build',
    });
    expect(capability?.subject).toBe(team.sara.userId);
    // Then the runtime itself goes, with the team's authorization.
    expect(calls.slice(1).every((call) => call.url.startsWith('https://api.cloudflare.com/'))).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });
});
