import { describe, expect, it, vi } from 'vitest';
import { waitForUserWorkspaceRuntimeReadiness } from '../../app/lib/.server/cloudflare/user-workspace-runtime-readiness';
import {
  changeUserWorkspaceRuntimeUpgradeWindow,
  claimUserWorkspaceRuntimeUpgradeWindow,
  RuntimeUpgradeWindowRefusedError,
} from '../../app/lib/.server/cloudflare/user-workspace-runtime-upgrade-window';
import {
  readRuntimeUpgradeWindow,
  recordRuntimeActivity,
  RUNTIME_UPGRADE_WINDOW_MS,
} from '../../app/lib/.server/cloudflare/user-workspace-runtime-activity';
import { userWorkspaceDatabase } from '../../app/test/control-plane-d1';
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

describe('user workspace runtime upgrade window route', () => {
  const targetVersion = 'b'.repeat(64);
  const holder = 'workspace-upgrade';

  it('grants the window to the control plane while nothing runs, and refuses it while a turn does', async () => {
    const { db } = userWorkspaceDatabase();
    const request = routedFetch(upgradeWindowEnv(db), () => 1_000_000);

    await expect(
      claimUserWorkspaceRuntimeUpgradeWindow({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret,
        targetVersion,
        holder,
        request,
      }),
    ).resolves.toEqual({ status: 'granted' });

    await recordRuntimeActivity(db, { agentName: 'chat-a', busy: true, now: 1_000_000 });
    await expect(
      claimUserWorkspaceRuntimeUpgradeWindow({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret,
        targetVersion,
        holder: 'workspace-later-upgrade',
        request,
      }),
    ).resolves.toEqual({ status: 'busy', busy: 1 });
  });

  it('holds the claimed window while work waits on it, and releases it once the upgrade serves', async () => {
    const { db } = userWorkspaceDatabase();
    let now = 1_000_000;
    const request = routedFetch(upgradeWindowEnv(db), () => now);
    const args = { endpoint: 'https://workspace-runtime.example', controlPlaneSecret, targetVersion, holder, request };
    await claimUserWorkspaceRuntimeUpgradeWindow(args);
    await recordRuntimeActivity(db, { agentName: 'chat-a', busy: true, now });

    now += RUNTIME_UPGRADE_WINDOW_MS - 1;
    await changeUserWorkspaceRuntimeUpgradeWindow({ ...args, change: 'hold' });
    await expect(readRuntimeUpgradeWindow(db, now + 1)).resolves.toMatchObject({ targetVersion });

    await changeUserWorkspaceRuntimeUpgradeWindow({ ...args, change: 'release' });
    await expect(readRuntimeUpgradeWindow(db, now)).resolves.toBeNull();
  });

  it('refuses to open a lapsed window again over work that started meanwhile, which the upgrade waits for', async () => {
    const { db } = userWorkspaceDatabase();
    let now = 1_000_000;
    const request = routedFetch(upgradeWindowEnv(db), () => now);
    const args = { endpoint: 'https://workspace-runtime.example', controlPlaneSecret, targetVersion, holder, request };
    await claimUserWorkspaceRuntimeUpgradeWindow(args);

    now += RUNTIME_UPGRADE_WINDOW_MS + 1_000;
    await recordRuntimeActivity(db, { agentName: 'chat-a', busy: true, now });
    const refused = changeUserWorkspaceRuntimeUpgradeWindow({ ...args, change: 'hold' });
    await expect(refused).rejects.toBeInstanceOf(RuntimeUpgradeWindowRefusedError);
    await expect(refused).rejects.toMatchObject({ busy: 1 });
    await expect(readRuntimeUpgradeWindow(db, now)).resolves.toBeNull();
  });

  it('refuses to hold or release the window without the runtime secret', async () => {
    const { db } = userWorkspaceDatabase();
    for (const method of ['PUT', 'DELETE']) {
      const response = await routeUserWorkspaceRuntimeControlPlaneRequest(
        new Request('https://workspace-runtime.example/v1/upgrade-window', {
          method,
          headers: { authorization: `Bearer ${'x'.repeat(32)}` },
          body: JSON.stringify({ targetVersion }),
        }),
        upgradeWindowEnv(db),
      );
      expect(response?.status).toBe(401);
    }
  });

  it('refuses anyone without the runtime secret', async () => {
    const { db } = userWorkspaceDatabase();
    const response = await routeUserWorkspaceRuntimeControlPlaneRequest(
      new Request('https://workspace-runtime.example/v1/upgrade-window', {
        method: 'POST',
        headers: { authorization: `Bearer ${'x'.repeat(32)}` },
        body: JSON.stringify({ targetVersion }),
      }),
      upgradeWindowEnv(db),
    );

    expect(response?.status).toBe(401);
  });

  it('rejects a request that does not name a runtime version', async () => {
    const { db } = userWorkspaceDatabase();
    const response = await routeUserWorkspaceRuntimeControlPlaneRequest(
      new Request('https://workspace-runtime.example/v1/upgrade-window', {
        method: 'POST',
        headers: { authorization: `Bearer ${controlPlaneSecret}` },
        body: JSON.stringify({ targetVersion: 'latest' }),
      }),
      upgradeWindowEnv(db),
    );

    expect(response?.status).toBe(400);
  });

  it('fails, never redeploying unasked, when a runtime with the window refuses the secret', async () => {
    const { db } = userWorkspaceDatabase();
    const request = routedFetch(upgradeWindowEnv(db), () => 1_000_000);

    await expect(
      claimUserWorkspaceRuntimeUpgradeWindow({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret: 'x'.repeat(32),
        targetVersion,
        holder,
        request,
      }),
    ).rejects.toThrow('refused the control plane secret');
  });

  it("keeps one upgrade's window from another, named by the holder each sends", async () => {
    const { db } = userWorkspaceDatabase();
    const request = routedFetch(upgradeWindowEnv(db), () => 1_000_000);
    const base = { endpoint: 'https://workspace-runtime.example', controlPlaneSecret, targetVersion, holder, request };
    await expect(claimUserWorkspaceRuntimeUpgradeWindow({ ...base, holder: 'workspace-first' })).resolves.toEqual({
      status: 'granted',
    });

    await expect(claimUserWorkspaceRuntimeUpgradeWindow({ ...base, holder: 'workspace-second' })).resolves.toEqual({
      status: 'busy',
      busy: 0,
    });
    await expect(
      changeUserWorkspaceRuntimeUpgradeWindow({ ...base, holder: 'workspace-second', change: 'hold' }),
    ).rejects.toBeInstanceOf(RuntimeUpgradeWindowRefusedError);
    await changeUserWorkspaceRuntimeUpgradeWindow({ ...base, holder: 'workspace-second', change: 'release' });
    await expect(readRuntimeUpgradeWindow(db, 1_000_000)).resolves.not.toBeNull();

    await changeUserWorkspaceRuntimeUpgradeWindow({ ...base, holder: 'workspace-first', change: 'release' });
    await expect(readRuntimeUpgradeWindow(db, 1_000_000)).resolves.toBeNull();
  });

  it('rejects a request that names no holder', async () => {
    const { db } = userWorkspaceDatabase();
    const response = await routeUserWorkspaceRuntimeControlPlaneRequest(
      new Request('https://workspace-runtime.example/v1/upgrade-window', {
        method: 'POST',
        headers: { authorization: `Bearer ${controlPlaneSecret}` },
        body: JSON.stringify({ targetVersion }),
      }),
      upgradeWindowEnv(db),
    );

    expect(response?.status).toBe(400);
  });

  it('rejects a holder that is not an instance name', async () => {
    const { db } = userWorkspaceDatabase();
    const response = await routeUserWorkspaceRuntimeControlPlaneRequest(
      new Request('https://workspace-runtime.example/v1/upgrade-window', {
        method: 'POST',
        headers: { authorization: `Bearer ${controlPlaneSecret}`, 'cloudchef-upgrade-holder': 'two words' },
        body: JSON.stringify({ targetVersion }),
      }),
      upgradeWindowEnv(db),
    );

    expect(response?.status).toBe(400);
  });

  it('fails rather than guess when the runtime cannot read its activity', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: 'unavailable' }, { status: 503 }));

    await expect(
      claimUserWorkspaceRuntimeUpgradeWindow({
        endpoint: 'https://workspace-runtime.example',
        controlPlaneSecret,
        targetVersion,
        holder,
        request,
      }),
    ).rejects.toThrow('HTTP 503');
  });
});

type ControlPlaneRouteEnv = Parameters<typeof routeUserWorkspaceRuntimeControlPlaneRequest>[1];

function upgradeWindowEnv(db: D1Database): ControlPlaneRouteEnv {
  return {
    CONTROL_PLANE_SECRET: controlPlaneSecret,
    CLOUDCHEF_RUNTIME_VERSION: runtimeVersion,
    DB: db,
    PROJECT_WORKSPACE: {
      idFromName: () => {
        throw new Error('The upgrade window needs no Durable Object.');
      },
      get: () => {
        throw new Error('The upgrade window needs no Durable Object.');
      },
    },
  };
}

function routedFetch(env: ControlPlaneRouteEnv, now: () => number) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const response = await routeUserWorkspaceRuntimeControlPlaneRequest(new Request(input, init), env, now);
    return response ?? new Response(null, { status: 404 });
  });
}

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
