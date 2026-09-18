import { describe, expect, it, vi } from 'vitest';
import { waitForUserWorkspaceRuntimeReadiness } from '../../app/lib/.server/cloudflare/user-workspace-runtime-readiness';
import { routeUserWorkspaceRuntimeControlPlaneRequest } from './readiness-route';

const runtimeVersion = 'a'.repeat(64);
const controlPlaneSecret = 's'.repeat(32);

describe('user workspace runtime control-plane readiness route', () => {
  it('accepts the provisioner raw secret and proves the ProjectWorkspace runtime end to end', async () => {
    const runReadinessProbe = vi.fn(async () => undefined);
    const idFromName = vi.fn(() => 'readiness-id');
    const get = vi.fn(() => ({ runReadinessProbe }));
    const env = runtimeEnv({ idFromName, get });
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const response = await routeUserWorkspaceRuntimeControlPlaneRequest(new Request(input, init), env as never);
      return response ?? new Response(null, { status: 404 });
    });

    await expect(
      waitForUserWorkspaceRuntimeReadiness({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret,
        runtimeVersion,
        request,
      }),
    ).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledOnce();
    expect(idFromName).toHaveBeenCalledWith('cloudchef-runtime-readiness');
    expect(get).toHaveBeenCalledWith('readiness-id');
    expect(runReadinessProbe).toHaveBeenCalledOnce();
  });

  it('rejects an invalid raw secret before allocating a readiness Durable Object', async () => {
    const get = vi.fn();
    const response = await routeUserWorkspaceRuntimeControlPlaneRequest(
      new Request('https://workspace-runtime.example/v1/readiness', {
        headers: { authorization: `Bearer ${'x'.repeat(32)}` },
      }),
      runtimeEnv({ idFromName: vi.fn(() => 'readiness-id'), get }) as never,
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(get).not.toHaveBeenCalled();
  });

  it('does not expose the retired health compatibility route', async () => {
    const response = await routeUserWorkspaceRuntimeControlPlaneRequest(
      new Request('https://workspace-runtime.example/v1/health', {
        headers: { authorization: `Bearer ${controlPlaneSecret}` },
      }),
      runtimeEnv({ idFromName: vi.fn(() => 'readiness-id'), get: vi.fn() }) as never,
    );

    expect(response).toBeNull();
  });
});

function runtimeEnv(projectWorkspace: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }) {
  return {
    CONTROL_PLANE_SECRET: controlPlaneSecret,
    CLOUDCHEF_RUNTIME_VERSION: runtimeVersion,
    DB: {
      prepare: vi.fn(() => ({ first: vi.fn(async () => ({ ok: 1 })) })),
    },
    PROJECT_WORKSPACE: projectWorkspace,
  };
}
