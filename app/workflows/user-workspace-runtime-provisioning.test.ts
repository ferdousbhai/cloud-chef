import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '~/lib/hex-digest';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';

const mocks = {
  requireActiveConnection: vi.fn(),
  resolveCredential: vi.fn(),
  deriveSecret: vi.fn(),
  waitForReadiness: vi.fn(),
  upsertRuntime: vi.fn(),
  accountApi: {
    readWorkspaceContainersEntitlement: vi.fn(),
    getWorkersSubdomain: vi.fn(),
    ensureD1Database: vi.fn(),
    applyD1Migrations: vi.fn(),
    deployWorkspaceRuntimeWorker: vi.fn(),
    configureWorkspaceRuntimeGcSchedule: vi.fn(),
    enableWorkerSubdomain: vi.fn(),
    ensureWorkspaceRuntimeContainer: vi.fn(),
  },
};

import {
  runUserWorkspaceRuntimeProvisioningWorkflow,
  startUserWorkspaceRuntimeProvisioning,
  workspaceRuntimeNames,
  type UserWorkspaceRuntimeProvisioningDependencies,
  type UserWorkspaceRuntimeProvisioningStep,
  USER_WORKSPACE_REQUIRED_CAPABILITIES,
} from './user-workspace-runtime-provisioning';

const connection: CloudflareConnection = {
  id: 'connection-1',
  userId: 'user-1',
  orgId: null,
  accountId: '0af9e0921b880657d84a6c07307f8aef',
  accountName: 'Account',
  status: 'active',
  credentialHandle: 'handle-1',
  grantedCapabilities: [...USER_WORKSPACE_REQUIRED_CAPABILITIES],
  requestedOAuthScopes: [],
  grantedOAuthScopes: [],
  oauthScopeProfileVersion: null,
  oauthScopeGrantStatus: 'unknown',
  aiBillingEnabled: true,
  connectedAt: 1,
  updatedAt: 1,
  generation: 1,
};

const dependencies = {
  requireConnection: mocks.requireActiveConnection,
  resolveCredential: mocks.resolveCredential,
  createAccountApi: () => mocks.accountApi,
  deriveSecret: mocks.deriveSecret,
  waitForReadiness: mocks.waitForReadiness,
  upsertRuntime: mocks.upsertRuntime,
} satisfies UserWorkspaceRuntimeProvisioningDependencies;

describe('workspace runtime provisioning Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveConnection.mockResolvedValue(connection);
    mocks.resolveCredential.mockResolvedValue('user-token');
    mocks.deriveSecret.mockResolvedValue('s'.repeat(64));
    mocks.accountApi.readWorkspaceContainersEntitlement.mockResolvedValue({ status: 'entitled' });
    mocks.accountApi.getWorkersSubdomain.mockResolvedValue('user');
    mocks.accountApi.ensureD1Database.mockResolvedValue({ id: 'database-1', name: 'database' });
    mocks.accountApi.deployWorkspaceRuntimeWorker.mockResolvedValue({ namespaceId: 'namespace-1' });
    mocks.upsertRuntime.mockResolvedValue(undefined);
  });

  it('uses one deterministic instance for repeated requests', async () => {
    const status = vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'running' });
    const instance = workflowInstance(status);
    const createBatch = vi
      .fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch']>()
      .mockResolvedValueOnce([instance])
      // The binding throws on a duplicate id; it never reports one as an empty batch.
      .mockRejectedValueOnce(new Error('instance with id workspace-... already exists'));
    const get = vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance);
    const env = workflowEnv(createBatch, get);

    await expect(startUserWorkspaceRuntimeProvisioning(launchArgs(env))).resolves.toEqual({ status: 'preparing' });
    await expect(startUserWorkspaceRuntimeProvisioning(launchArgs(env))).resolves.toEqual({ status: 'preparing' });

    const firstId = createBatch.mock.calls[0][0][0].id;
    expect(createBatch.mock.calls[1][0][0].id).toBe(firstId);
    expect(get).toHaveBeenCalledWith(firstId);
  });

  it("gives each member of an organization their own workspace in the organization's account", async () => {
    const instance = workflowInstance(vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'running' }));
    const createBatch = vi
      .fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch']>()
      .mockResolvedValue([instance]);
    const env = workflowEnv(createBatch, vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>());

    await startUserWorkspaceRuntimeProvisioning({ ...launchArgs(env), userId: 'member-1' });
    await startUserWorkspaceRuntimeProvisioning({ ...launchArgs(env), userId: 'member-2' });

    const [first, second] = createBatch.mock.calls.map((call) => call[0][0]);
    expect(first.params).toMatchObject({ userId: 'member-1' });
    expect(second.params).toMatchObject({ userId: 'member-2', connectionId: launchArgs(env).connectionId });
    expect(second.id).not.toBe(first.id);
  });

  it("keeps a person's own workspace and their organization's apart in one Cloudflare account", async () => {
    const personal = await workspaceRuntimeNames({ accountId: 'account-1', id: 'mine', orgId: null }, 'user-1');
    const organization = await workspaceRuntimeNames({ accountId: 'account-1', id: 'acme', orgId: 'org-1' }, 'user-1');
    expect(organization.workerName).not.toBe(personal.workerName);
    expect(organization.databaseName).not.toBe(personal.databaseName);
    // A person's own workspace keeps the name it has always had.
    expect(personal.workerName).toBe(`cloudchef-workspace-${(await sha256Hex('account-1:user-1')).slice(0, 16)}`);
  });

  it('builds a workspace again when its finished Workflow left nothing ready, as after leaving and rejoining', async () => {
    const instance = workflowInstance(
      vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'complete', output: { status: 'ready' } }),
    );
    const env = workflowEnv(
      vi
        .fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch']>()
        .mockRejectedValue(new Error('instance with id workspace-... already exists')),
      vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance),
    );

    await expect(startUserWorkspaceRuntimeProvisioning(launchArgs(env))).resolves.toEqual({ status: 'preparing' });
    expect(vi.mocked(instance.restart)).toHaveBeenCalledOnce();

    // Finished just after the caller looked: no second build.
    vi.mocked(instance.restart).mockClear();
    await expect(
      startUserWorkspaceRuntimeProvisioning({ ...launchArgs(env), isReady: async () => true }),
    ).resolves.toEqual({ status: 'preparing' });
    expect(vi.mocked(instance.restart)).not.toHaveBeenCalled();
  });

  it('restarts a failed target only on explicit retry', async () => {
    const instance = workflowInstance(
      vi.fn<WorkflowInstance['status']>().mockResolvedValue({
        status: 'complete',
        output: { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null },
      }),
    );
    const env = workflowEnv(
      vi
        .fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch']>()
        .mockRejectedValue(new Error('instance with id workspace-... already exists')),
      vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance),
    );

    await expect(startUserWorkspaceRuntimeProvisioning({ ...launchArgs(env), retry: true })).resolves.toEqual({
      status: 'preparing',
    });
    expect(instance.restart).toHaveBeenCalledOnce();
  });

  it('returns the two actionable eligibility outcomes without creating resources', async () => {
    for (const [entitlement, errorCode] of [
      [
        { status: 'plan_required', message: 'Upgrade', upgradeUrl: 'https://dash.cloudflare.com/' },
        'workspace_plan_required',
      ],
      [{ status: 'undetermined', reason: 'Unavailable' }, 'workspace_eligibility_unknown'],
    ] as const) {
      mocks.accountApi.readWorkspaceContainersEntitlement.mockResolvedValueOnce(entitlement);

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({
        status: 'error',
        errorCode,
        upgradeUrl: errorCode === 'workspace_plan_required' ? 'https://dash.cloudflare.com/' : null,
      });
    }
    expect(mocks.accountApi.ensureD1Database).not.toHaveBeenCalled();
  });

  it("doesn't deploy a workspace for someone who lost access while it was being prepared", async () => {
    // Allowed when the run starts; removed (here: someone else's connection) by the time it deploys.
    mocks.requireActiveConnection
      .mockResolvedValueOnce(connection)
      .mockResolvedValue({ ...connection, userId: 'someone-else' });

    await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toMatchObject({
      status: 'error',
    });
    expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
  });

  it('fails closed when the connection cannot provision the runtime', async () => {
    mocks.requireActiveConnection.mockResolvedValueOnce({ ...connection, grantedCapabilities: [] });

    await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({
      status: 'error',
      errorCode: 'workspace_preparation_failed',
      upgradeUrl: null,
    });
    expect(mocks.accountApi.readWorkspaceContainersEntitlement).not.toHaveBeenCalled();
  });
});

function launchArgs(env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>) {
  return { env, userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 1 };
}

function workflowArgs() {
  return {
    // SAFETY: these tests inject every external dependency, so only the two Env fields read by orchestration are needed.
    env: {
      DB: {},
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'k'.repeat(44),
    } as Env,
    event: { payload: { userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 1 } },
    step: {
      async do<T>(
        _name: string,
        _config: Parameters<UserWorkspaceRuntimeProvisioningStep['do']>[1],
        operation: () => Promise<T>,
      ) {
        return operation();
      },
    } satisfies UserWorkspaceRuntimeProvisioningStep,
    dependencies,
  };
}

function workflowEnv(
  createBatch: Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch'],
  get: Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get'],
): Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'> {
  return {
    USER_WORKSPACE_RUNTIME_PROVISIONING: {
      create: vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['create']>(),
      createBatch,
      get,
      deleteBatch: vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['deleteBatch']>(),
    },
  };
}

function workflowInstance(status: WorkflowInstance['status']): WorkflowInstance {
  return {
    id: 'workspace-instance',
    status,
    restart: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  };
}
