import { z } from 'zod';
import { readJsonBodyWithLimit } from '../../app/lib/bounded-body';
import {
  claimRuntimeUpgradeWindow,
  holdRuntimeUpgradeWindow,
  releaseRuntimeUpgradeWindow,
} from '../../app/lib/.server/cloudflare/user-workspace-runtime-activity';
import { readUserWorkspaceRuntimeHealth } from '../../app/lib/.server/cloudflare/user-workspace-runtime-health';

const READINESS_WORKSPACE_NAME = 'cloudchef-runtime-readiness';
const UPGRADE_WINDOW_PATH = '/v1/upgrade-window';
const MAX_UPGRADE_WINDOW_REQUEST_BYTES = 1_024;
const UPGRADE_WINDOW_METHODS = new Set(['POST', 'PUT', 'DELETE']);
const upgradeWindowRequestSchema = z.object({ targetVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/**
 * The upgrade asking, named by its Workflow instance. A header, not a body field: a runtime from before
 * holders refuses a body field it does not know, and the claim goes to the runtime being replaced.
 */
const UPGRADE_WINDOW_HOLDER_HEADER = 'cloudchef-upgrade-holder';
const upgradeWindowHolderSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);

type RuntimeReadinessEnv = {
  CONTROL_PLANE_SECRET: string;
  CLOUDCHEF_RUNTIME_VERSION: string;
  DB: Pick<D1Database, 'prepare'>;
  PROJECT_WORKSPACE: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { runReadinessProbe(): Promise<void> };
  };
};

/**
 * The routes only the control plane calls, authenticated with the runtime's secret: readiness, and
 * the window an upgrade claims (`POST`) before it redeploys this Worker, holds (`PUT`) while the
 * container image rolls out and the new runtime readies, and releases (`DELETE`) once it serves.
 */
export async function routeUserWorkspaceRuntimeControlPlaneRequest(
  request: Request,
  env: RuntimeReadinessEnv,
  now: () => number = Date.now,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (pathname === UPGRADE_WINDOW_PATH && UPGRADE_WINDOW_METHODS.has(request.method)) {
    return upgradeWindow(request, env, now());
  }
  if (request.method !== 'GET' || pathname !== '/v1/readiness') {
    return null;
  }
  if (!authorized(request, env.CONTROL_PLANE_SECRET)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders() });
  }
  try {
    const health = await readUserWorkspaceRuntimeHealth(env);
    const id = env.PROJECT_WORKSPACE.idFromName(READINESS_WORKSPACE_NAME);
    await env.PROJECT_WORKSPACE.get(id).runReadinessProbe();
    return Response.json(health, { headers: noStoreHeaders() });
  } catch {
    return Response.json(
      { ok: false, runtimeVersion: env.CLOUDCHEF_RUNTIME_VERSION },
      { status: 503, headers: noStoreHeaders() },
    );
  }
}

/**
 * Grant the window only while no agent is doing work a redeploy would cut off. Work that starts inside
 * it waits until the upgrade releases it, so the control plane can redeploy the Worker and roll out its
 * container without cutting anything off.
 */
async function upgradeWindow(request: Request, env: RuntimeReadinessEnv, now: number): Promise<Response> {
  if (!authorized(request, env.CONTROL_PLANE_SECRET)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: noStoreHeaders() });
  }
  const targetVersion = await readTargetVersion(request);
  const holderHeader = request.headers.get(UPGRADE_WINDOW_HOLDER_HEADER);
  // A control plane from before holders names none, and its calls work as they always did.
  const holder = holderHeader === null ? null : upgradeWindowHolderSchema.safeParse(holderHeader).data;
  if (!targetVersion || holder === undefined) {
    return Response.json({ error: 'Invalid upgrade window request.' }, { status: 400, headers: noStoreHeaders() });
  }
  try {
    if (request.method === 'PUT') {
      // A lapsed window is not opened again over work that started meanwhile, nor another upgrade's
      // open window taken over: the upgrade waits for either.
      const hold = await holdRuntimeUpgradeWindow(env.DB, { targetVersion, now, holder });
      return Response.json(hold, { status: hold.held ? 200 : 409, headers: noStoreHeaders() });
    }
    if (request.method === 'DELETE') {
      await releaseRuntimeUpgradeWindow(env.DB, { targetVersion, holder });
      return Response.json({ released: true }, { headers: noStoreHeaders() });
    }
    return Response.json(await claimRuntimeUpgradeWindow(env.DB, { targetVersion, now, holder }), {
      headers: noStoreHeaders(),
    });
  } catch {
    return Response.json({ error: 'Workspace activity is unavailable.' }, { status: 503, headers: noStoreHeaders() });
  }
}

async function readTargetVersion(request: Request): Promise<string | null> {
  try {
    const body = upgradeWindowRequestSchema.safeParse(
      await readJsonBodyWithLimit(request, MAX_UPGRADE_WINDOW_REQUEST_BYTES, 'Upgrade window request'),
    );
    return body.success ? body.data.targetVersion : null;
  } catch {
    return null;
  }
}

function noStoreHeaders(): HeadersInit {
  return { 'cache-control': 'no-store' };
}

function authorized(request: Request, expected: string): boolean {
  const supplied = request.headers.get('authorization')?.slice('Bearer '.length) ?? '';
  if (
    !request.headers.get('authorization')?.startsWith('Bearer ') ||
    expected.length < 32 ||
    supplied.length !== expected.length
  ) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}
