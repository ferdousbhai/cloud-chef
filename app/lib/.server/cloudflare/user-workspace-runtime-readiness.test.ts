import { describe, expect, it, vi } from 'vitest';
import { waitForUserWorkspaceRuntimeReadiness } from './user-workspace-runtime-readiness';

const runtimeVersion = 'a'.repeat(64);
const controlPlaneSecret = 's'.repeat(32);

describe('user workspace runtime readiness', () => {
  it('accepts the exact healthy runtime', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        service: 'cloudchef-user-workspace-runtime',
        runtimeVersion,
      }),
    );

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret,
        runtimeVersion,
        request,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledWith(
      new URL('https://workspace-runtime.example/v1/readiness'),
      expect.objectContaining({ headers: { authorization: `Bearer ${controlPlaneSecret}` } }),
    );
  });

  it('leaves retries to the durable Workflow step', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret,
        runtimeVersion,
        request,
      }),
    ).rejects.toThrow('HTTP 503');

    expect(request).toHaveBeenCalledOnce();
  });

  it('requires the exact deployed runtime identity', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        service: 'cloudchef-user-workspace-runtime',
        runtimeVersion: 'b'.repeat(64),
      }),
    );

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret,
        runtimeVersion,
        request,
      }),
    ).rejects.toThrow('invalid health response');
  });
});
