import { readUserWorkspaceRuntimeHealth } from '../../app/lib/.server/cloudflare/user-workspace-runtime-health';

const READINESS_WORKSPACE_NAME = 'cloudchef-runtime-readiness';

type RuntimeReadinessEnv = {
  CONTROL_PLANE_SECRET: string;
  CLOUDCHEF_RUNTIME_VERSION: string;
  DB: Pick<D1Database, 'prepare'>;
  PROJECT_WORKSPACE: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { runReadinessProbe(): Promise<void> };
  };
};

/** Prove that the Worker, D1, Durable Object, VFS, Sandbox, and FUSE path all work. */
export async function routeUserWorkspaceRuntimeControlPlaneRequest(
  request: Request,
  env: RuntimeReadinessEnv,
): Promise<Response | null> {
  if (request.method !== 'GET' || new URL(request.url).pathname !== '/v1/readiness') {
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
