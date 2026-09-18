import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveFreshCloudflareAccessToken } from './user-workspace-deployment-executor';

const runtimeEnv = {
  CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build',
  CONTROL_PLANE_SECRET: 'runtime-secret-that-is-long-enough',
  CLOUDCHEF_USER_ID: 'user-1',
  CLOUDCHEF_CONNECTION_ID: 'connection-1',
  CLOUDCHEF_CONNECTION_GENERATION: '3',
};

describe('resolveFreshCloudflareAccessToken', () => {
  it('requests a non-cacheable token for the exact runtime identity', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ accessToken: 'fresh-access-token' }, { headers: { 'Cache-Control': 'private, no-store' } }),
      );

    await expect(resolveFreshCloudflareAccessToken(runtimeEnv, request)).resolves.toBe('fresh-access-token');
    expect(request).toHaveBeenCalledWith(
      'https://cloudchef.build/api/cloudflare/runtime-credential',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: expect.objectContaining({
          authorization: 'Bearer runtime-secret-that-is-long-enough',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          userId: 'user-1',
          connectionId: 'connection-1',
          connectionGeneration: 3,
          forceRefresh: false,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('can force OAuth refresh at a new authenticated deployment phase', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ accessToken: 'refreshed-access-token' }, { headers: { 'Cache-Control': 'no-store' } }),
      );

    await expect(resolveFreshCloudflareAccessToken(runtimeEnv, request, true)).resolves.toBe('refreshed-access-token');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ forceRefresh: true });
  });

  it.each([
    ['a redirectable endpoint', { ...runtimeEnv, CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://attacker.example' }],
    ['a stale generation', { ...runtimeEnv, CLOUDCHEF_CONNECTION_GENERATION: '0' }],
    ['a missing runtime secret', { ...runtimeEnv, CONTROL_PLANE_SECRET: undefined }],
  ])('rejects %s before making a request', async (_label, env) => {
    const request = vi.fn<typeof fetch>();

    await expect(resolveFreshCloudflareAccessToken(env, request)).rejects.toThrow(
      'Cloudflare connection is unavailable',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['a cacheable response', Response.json({ accessToken: 'token' })],
    [
      'a provider failure',
      Response.json({ error: 'provider detail' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }),
    ],
    [
      'an oversized token',
      Response.json({ accessToken: 'a'.repeat(4_097) }, { headers: { 'Cache-Control': 'no-store' } }),
    ],
    ['an unexpected redirect', new Response(null, { status: 302, headers: { location: 'https://attacker.example' } })],
  ])('fails closed on %s', async (_label, response) => {
    await expect(
      resolveFreshCloudflareAccessToken(runtimeEnv, vi.fn<typeof fetch>().mockResolvedValue(response)),
    ).rejects.toThrow('Cloudflare connection is unavailable');
  });
});

describe('deployment credential boundary', () => {
  it('keeps provider credentials out of ProjectWorkspace input and every untrusted build command environment', () => {
    const executorSource = readFileSync(new URL('./user-workspace-deployment-executor.ts', import.meta.url), 'utf8');
    const inputStart = executorSource.indexOf('prepareDeploymentArtifact({');
    const inputEnd = executorSource.indexOf('}),\n    { revision:', inputStart);
    expect(inputStart).toBeGreaterThan(0);
    expect(inputEnd).toBeGreaterThan(inputStart);
    const projectInput = executorSource.slice(inputStart, inputEnd);
    expect(projectInput).not.toMatch(/accessToken|apiToken|CONTROL_PLANE_SECRET|authorization/i);

    const runtimeSource = readFileSync(
      new URL('../../../../user-workspace-runtime/src/index.ts', import.meta.url),
      'utf8',
    );
    const methodStart = runtimeSource.indexOf('async prepareDeploymentArtifact(');
    const methodEnd = runtimeSource.indexOf('async deleteProject(', methodStart);
    expect(methodStart).toBeGreaterThan(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const preparation = runtimeSource.slice(methodStart, methodEnd);
    const buildStart = runtimeSource.indexOf('private async buildDeploymentArtifact(');
    const buildEnd = runtimeSource.indexOf('private async collectDeploymentArtifact(', buildStart);
    const build = runtimeSource.slice(buildStart, buildEnd);
    expect(build).toContain('wrangler deploy --dry-run');
    // Materialisation now goes through the verified copy, which pushes and then proves the
    // isolated root matches the durable VFS before anything is built from it (#139).
    expect(preparation).toContain('await this.copyProjectToIsolatedRoot(PREPARED_VALIDATION_ROOT)');
    expect(preparation).toContain('await this.runTransientCommand(');
    expect(preparation).not.toMatch(/apiToken|CLOUDFLARE_API_TOKEN|authorization|env\s*:/i);

    const transientCommandStart = runtimeSource.indexOf('private async runTransientCommand(');
    const transientCommandEnd = runtimeSource.indexOf(
      'private async recycleWorkspaceContainer(',
      transientCommandStart,
    );
    expect(transientCommandStart).toBeGreaterThan(0);
    expect(transientCommandEnd).toBeGreaterThan(transientCommandStart);
    const transientCommand = runtimeSource.slice(transientCommandStart, transientCommandEnd);
    expect(transientCommand).toContain('runTrackedSandboxCommand');
    expect(transientCommand).toContain(
      "this.sandboxProcesses.exec(trackedCommand, { ...options, env: { CI: 'true' } })",
    );
    expect(transientCommand).not.toMatch(/apiToken|CLOUDFLARE_API_TOKEN|authorization/i);
    expect(runtimeSource).not.toContain("route.operation === 'deploy'");
  });
});
