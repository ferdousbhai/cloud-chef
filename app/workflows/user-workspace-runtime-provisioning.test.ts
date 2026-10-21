import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '~/lib/hex-digest';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import type { UserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';

const mocks = {
  requireActiveConnection: vi.fn(),
  resolveCredential: vi.fn(),
  deriveSecret: vi.fn(),
  waitForReadiness: vi.fn(),
  upsertRuntime: vi.fn(),
  findRuntime: vi.fn(),
  claimUpgradeWindow: vi.fn(),
  now: vi.fn(),
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
  LEGACY_RUNTIME_QUIET_MS,
  runUserWorkspaceRuntimeProvisioningWorkflow,
  startUserWorkspaceRuntimeProvisioning,
  sweepUserWorkspaceRuntimeUpgrade,
  UPGRADE_MAX_WAIT_MS,
  workspaceRuntimeNames,
  type UserWorkspaceRuntimeProvisioningDependencies,
  type UserWorkspaceRuntimeProvisioningStep,
  USER_WORKSPACE_REQUIRED_CAPABILITIES,
} from './user-workspace-runtime-provisioning';

const NOW = 100 * 60 * 60_000;

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
  findRuntime: mocks.findRuntime,
  claimUpgradeWindow: mocks.claimUpgradeWindow,
  now: mocks.now,
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
    mocks.findRuntime.mockResolvedValue(null);
    mocks.now.mockReturnValue(NOW);
  });

  it('uses one deterministic instance for repeated requests', async () => {
    const status = vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'running' });
    const instance = workflowInstance(status);
    const createBatch = vi
      .fn<CreateBatch>()
      .mockResolvedValueOnce({ created: [instance], errors: [] })
      // The object form reports a duplicate id as a per-instance error.
      .mockResolvedValueOnce({
        created: [],
        errors: [{ index: 0, id: 'workspace-...', code: 409, message: 'instance already exists' }],
      });
    const get = vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance);
    const env = workflowEnv(createBatch, get);

    await expect(startUserWorkspaceRuntimeProvisioning(launchArgs(env))).resolves.toEqual({ status: 'preparing' });
    await expect(startUserWorkspaceRuntimeProvisioning(launchArgs(env))).resolves.toEqual({ status: 'preparing' });

    const firstId = createBatch.mock.calls[0][0].instances?.[0]?.id;
    expect(firstId).toBeDefined();
    expect(createBatch.mock.calls[1][0].instances?.[0]?.id).toBe(firstId);
    expect(get).toHaveBeenCalledWith(firstId);
  });

  it("gives each member of an organization their own workspace in the organization's account", async () => {
    const instance = workflowInstance(vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'running' }));
    const createBatch = vi.fn<CreateBatch>().mockResolvedValue({ created: [instance], errors: [] });
    const env = workflowEnv(createBatch, vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>());

    await startUserWorkspaceRuntimeProvisioning({ ...launchArgs(env), userId: 'member-1' });
    await startUserWorkspaceRuntimeProvisioning({ ...launchArgs(env), userId: 'member-2' });

    const [first, second] = createBatch.mock.calls.map((call) => call[0].instances![0]!);
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
        .fn<CreateBatch>()
        // The binding has also thrown for a duplicate id rather than reporting it.
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
        .fn<CreateBatch>()
        // The binding has also thrown for a duplicate id rather than reporting it.
        .mockRejectedValue(new Error('instance with id workspace-... already exists')),
      vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance),
    );

    await expect(startUserWorkspaceRuntimeProvisioning({ ...launchArgs(env), retry: true })).resolves.toEqual({
      status: 'preparing',
    });
    expect(instance.restart).toHaveBeenCalledOnce();
  });

  describe('scheduled upgrade sweep', () => {
    const existing = () =>
      vi
        .fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch']>()
        .mockRejectedValue(new Error('instance with id workspace-... already exists'));
    const sweepArgs = (env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>, overrides = {}) => ({
      ...launchArgs(env),
      restartFailed: true,
      isCurrent: async () => false,
      ...overrides,
    });

    it('starts the same Workflow instance a session request would', async () => {
      const instance = workflowInstance(vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'running' }));
      const createBatch = vi
        .fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch']>()
        .mockResolvedValue([instance]);
      const env = workflowEnv(createBatch, vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>());

      await expect(sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env))).resolves.toBe('started');
      await startUserWorkspaceRuntimeProvisioning(launchArgs(env));

      const [swept, requested] = createBatch.mock.calls.map((call) => call[0][0]);
      expect(swept.id).toBe(requested.id);
      expect(swept.params).toEqual(requested.params);
    });

    it('leaves an upgrade that is still waiting for a quiet moment alone', async () => {
      const instance = workflowInstance(vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'waiting' }));
      const env = workflowEnv(
        existing(),
        vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance),
      );

      await expect(sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env))).resolves.toBe('running');
      expect(instance.restart).not.toHaveBeenCalled();
    });

    it('restarts a failed upgrade without a browser retry, but only when its slot allows', async () => {
      for (const status of [
        { status: 'errored' as const },
        { status: 'terminated' as const },
        { status: 'complete' as const, output: { status: 'error', errorCode: 'workspace_preparation_failed' } },
      ]) {
        const instance = workflowInstance(vi.fn<WorkflowInstance['status']>().mockResolvedValue(status));
        const env = workflowEnv(
          existing(),
          vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance),
        );

        await expect(sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env, { restartFailed: false }))).resolves.toBe('left');
        expect(instance.restart).not.toHaveBeenCalled();
        await expect(sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env))).resolves.toBe('restarted');
        expect(instance.restart).toHaveBeenCalledOnce();
      }
    });

    it('waits again after an upgrade gave up waiting, unless the runtime is current after all', async () => {
      const instance = workflowInstance(
        vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'complete', output: { status: 'deferred' } }),
      );
      const env = workflowEnv(
        existing(),
        vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance),
      );

      await expect(
        sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env, { restartFailed: false, isCurrent: async () => true })),
      ).resolves.toBe('left');
      expect(instance.restart).not.toHaveBeenCalled();
      await expect(sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env, { restartFailed: false }))).resolves.toBe(
        'restarted',
      );
      expect(instance.restart).toHaveBeenCalledOnce();
    });
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

  describe('upgrading a live workspace', () => {
    let endpoint: string;

    beforeEach(async () => {
      endpoint = `https://${(await workspaceRuntimeNames(connection, 'user-1')).workerName}.user.workers.dev`;
      mocks.findRuntime.mockResolvedValue(liveRuntime(endpoint));
    });

    it('redeploys only once the workspace grants the window, waiting while it is busy', async () => {
      mocks.claimUpgradeWindow
        .mockResolvedValueOnce({ status: 'busy', busy: 1 })
        .mockResolvedValueOnce({ status: 'busy', busy: 1 })
        .mockResolvedValueOnce({ status: 'granted' });
      const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async () => {
        expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
        status: 'ready',
      });

      expect(sleep.mock.calls.map(([, duration]) => duration)).toEqual([30_000, 60_000]);
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
      expect(mocks.claimUpgradeWindow).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint, targetVersion: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      );
    });

    it('gives up without redeploying a workspace that never goes quiet', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'busy', busy: 2 });
      let now = NOW;
      mocks.now.mockImplementation(() => now);
      const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async (_name, duration) => {
        now += duration;
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
        status: 'deferred',
      });

      expect(now - NOW).toBeGreaterThanOrEqual(UPGRADE_MAX_WAIT_MS);
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
      expect(mocks.upsertRuntime).not.toHaveBeenCalled();
    });

    it('upgrades a runtime too old to report activity only after no session for longer than a turn runs', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'unsupported' });
      let now = NOW;
      mocks.now.mockImplementation(() => now);
      mocks.findRuntime.mockResolvedValue({ ...liveRuntime(endpoint), lastSessionAt: NOW - 60_000 });
      const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async (_name, duration) => {
        expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
        now += duration;
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
        status: 'ready',
      });

      expect(now).toBe(NOW - 60_000 + LEGACY_RUNTIME_QUIET_MS);
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
    });

    it('records the protocol the new runtime speaks', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });

      await runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs());

      expect(mocks.upsertRuntime).toHaveBeenCalledWith(expect.objectContaining({ protocolVersion: 1 }));
    });

    it("doesn't wait on a runtime of an earlier connection generation, which can no longer be asked", async () => {
      mocks.findRuntime.mockResolvedValue({ ...liveRuntime(endpoint), connectionGeneration: 0 });

      await runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs());

      expect(mocks.claimUpgradeWindow).not.toHaveBeenCalled();
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
    });
  });

  it('deploys a first workspace without asking for an upgrade window', async () => {
    await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({ status: 'ready' });

    expect(mocks.claimUpgradeWindow).not.toHaveBeenCalled();
    expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
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

function liveRuntime(endpoint: string): UserWorkspaceRuntime {
  return {
    connectionId: 'connection-1',
    connectionGeneration: 1,
    endpoint,
    runtimeVersion: '0'.repeat(64),
    imageDigest: null,
    protocolVersion: null,
    lastSessionAt: 0,
  };
}

function launchArgs(env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>) {
  return { env, userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 1 };
}

function workflowArgs(sleep: UserWorkspaceRuntimeProvisioningStep['sleep'] = async () => undefined) {
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
      sleep,
    } satisfies UserWorkspaceRuntimeProvisioningStep,
    dependencies,
  };
}

/** The object form of `createBatch`; the array form is deprecated. */
type CreateBatch = (options: WorkflowBatchCreateOptions<unknown>) => Promise<WorkflowBatchCreateResult>;

function workflowEnv(
  createBatch: CreateBatch,
  get: Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get'],
): Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'> {
  return {
    USER_WORKSPACE_RUNTIME_PROVISIONING: {
      create: vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['create']>(),
      // SAFETY: the binding overloads createBatch with its deprecated array form, which the
      // provisioning code no longer calls.
      createBatch: createBatch as Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['createBatch'],
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
