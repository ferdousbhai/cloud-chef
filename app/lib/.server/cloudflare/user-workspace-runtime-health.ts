import { USER_WORKSPACE_RUNTIME_SERVICE } from '@cloudchef/user-workspace-runtime/protocol';

type RuntimeHealthEnv = {
  DB: Pick<D1Database, 'prepare'>;
  CLOUDCHEF_RUNTIME_VERSION: string;
};

type UserWorkspaceRuntimeHealth = {
  ok: true;
  service: typeof USER_WORKSPACE_RUNTIME_SERVICE;
  runtimeVersion: string;
};

/** Prove that the deployed Worker can read its required D1 binding. */
export async function readUserWorkspaceRuntimeHealth(env: RuntimeHealthEnv): Promise<UserWorkspaceRuntimeHealth> {
  if (!/^[a-f0-9]{64}$/.test(env.CLOUDCHEF_RUNTIME_VERSION)) {
    throw new Error('The workspace runtime version binding is invalid.');
  }
  const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  if (database?.ok !== 1) {
    throw new Error('The workspace runtime database is unavailable.');
  }
  return {
    ok: true,
    service: USER_WORKSPACE_RUNTIME_SERVICE,
    runtimeVersion: env.CLOUDCHEF_RUNTIME_VERSION,
  };
}
