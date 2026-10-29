import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_WORKSPACE_DATA_MIGRATIONS } from '~/generated/user-workspace-runtime.generated';
import { sha256Hex } from '~/lib/hex-digest';
import { USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION } from '@cloudchef/user-workspace-runtime/protocol';
import type { CloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import type { UserWorkspaceRuntime } from '~/lib/.server/cloudflare/user-workspace-runtime-repository';
import { USER_WORKSPACE_IMAGE } from '~/lib/.server/cloudflare/user-workspace-image';
import {
  RuntimeSecretRefusedError,
  RuntimeUpgradeWindowRefusedError,
} from '~/lib/.server/cloudflare/user-workspace-runtime-upgrade-window';

const mocks = {
  requireActiveConnection: vi.fn(),
  deriveSecret: vi.fn(),
  waitForReadiness: vi.fn(),
  upsertRuntime: vi.fn(),
  findRuntime: vi.fn(),
  claimUpgradeWindow: vi.fn(),
  changeUpgradeWindow: vi.fn(),
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
  EARLIER_GENERATION_MAX_WAIT_MS,
  runUserWorkspaceRuntimeProvisioningWorkflow,
  startUserWorkspaceRuntimeProvisioning,
  sweepUserWorkspaceRuntimeUpgrade,
  UPGRADE_MAX_WAIT_MS,
  UPGRADE_WINDOW_RENEWAL_MS,
  workspaceRuntimeNames,
  type UserWorkspaceRuntimeProvisioningDependencies,
  type UserWorkspaceRuntimeProvisioningStep,
} from './user-workspace-runtime-provisioning';
import { CORE_CLOUDFLARE_OAUTH_SCOPES } from '~/lib/.server/cloudflare/cloudflare-oauth-scope-manifest';

const NOW = 100 * 60 * 60_000;

const connection: CloudflareConnection = {
  id: 'connection-1',
  userId: 'user-1',
  orgId: null,
  accountId: '0af9e0921b880657d84a6c07307f8aef',
  accountName: 'Account',
  status: 'active',
  credentialHandle: 'handle-1',
  grantedOAuthScopes: [...CORE_CLOUDFLARE_OAUTH_SCOPES],
  connectedAt: 1,
  updatedAt: 1,
  generation: 1,
};

const dependencies = {
  requireConnection: mocks.requireActiveConnection,
  openAccountApi: async () => mocks.accountApi,
  deriveSecret: mocks.deriveSecret,
  waitForReadiness: mocks.waitForReadiness,
  upsertRuntime: mocks.upsertRuntime,
  findRuntime: mocks.findRuntime,
  claimUpgradeWindow: mocks.claimUpgradeWindow,
  changeUpgradeWindow: mocks.changeUpgradeWindow,
} satisfies UserWorkspaceRuntimeProvisioningDependencies;

describe('workspace runtime provisioning Workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActiveConnection.mockResolvedValue(connection);
    mocks.deriveSecret.mockResolvedValue('s'.repeat(64));
    mocks.accountApi.readWorkspaceContainersEntitlement.mockResolvedValue({ status: 'entitled' });
    mocks.accountApi.getWorkersSubdomain.mockResolvedValue('user');
    mocks.accountApi.ensureD1Database.mockResolvedValue({ id: 'database-1', name: 'database' });
    mocks.accountApi.deployWorkspaceRuntimeWorker.mockResolvedValue({ namespaceId: 'namespace-1' });
    mocks.upsertRuntime.mockResolvedValue(undefined);
    mocks.findRuntime.mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    mocks.changeUpgradeWindow.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
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
      vi.fn<CreateBatch>().mockResolvedValue({
        created: [],
        errors: [{ index: 0, id: 'workspace-...', code: 409, message: 'instance already exists' }],
      });
    const sweepArgs = (env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>, overrides = {}) => ({
      ...launchArgs(env),
      restartFailed: true,
      isCurrent: async () => false,
      ...overrides,
    });

    it('starts the same Workflow instance a session request would', async () => {
      const instance = workflowInstance(vi.fn<WorkflowInstance['status']>().mockResolvedValue({ status: 'running' }));
      const createBatch = vi.fn<CreateBatch>().mockResolvedValue({ created: [instance], errors: [] });
      const env = workflowEnv(createBatch, vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>());

      await expect(sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env))).resolves.toBe('started');
      await startUserWorkspaceRuntimeProvisioning(launchArgs(env));

      const [swept, requested] = createBatch.mock.calls.map((call) => call[0].instances![0]!);
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
        {
          status: 'complete' as const,
          output: { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null },
        },
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

    it('restarts on every sweep an upgrade that failed after redeploying the Worker', async () => {
      const instance = workflowInstance(
        vi.fn<WorkflowInstance['status']>().mockResolvedValue({
          status: 'complete',
          output: { status: 'error', errorCode: 'workspace_preparation_failed', upgradeUrl: null, redeployed: true },
        }),
      );
      const env = workflowEnv(
        existing(),
        vi.fn<Env['USER_WORKSPACE_RUNTIME_PROVISIONING']['get']>().mockResolvedValue(instance),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(sweepUserWorkspaceRuntimeUpgrade(sweepArgs(env, { restartFailed: false }))).resolves.toBe(
        'restarted',
      );
      expect(instance.restart).toHaveBeenCalledOnce();
      warn.mockRestore();
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
      vi.setSystemTime(now);
      const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async (_name, duration) => {
        now += duration;
        vi.setSystemTime(now);
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
        status: 'deferred',
      });

      expect(now - NOW).toBeGreaterThanOrEqual(UPGRADE_MAX_WAIT_MS);
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
      expect(mocks.upsertRuntime).not.toHaveBeenCalled();
    });

    it('records the protocol the new runtime speaks', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });

      await runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs());

      expect(mocks.upsertRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION }),
      );
    });

    it('configures the Worker, replaces its container applications and waits for readiness inside the window, then releases it', async () => {
      const calls: string[] = [];
      mocks.claimUpgradeWindow.mockImplementation(async () => {
        calls.push('claim');
        return { status: 'granted' };
      });
      mocks.accountApi.deployWorkspaceRuntimeWorker.mockImplementation(async () => {
        calls.push('deploy Worker');
        return { namespaceId: 'namespace-1' };
      });
      mocks.changeUpgradeWindow.mockImplementation(async ({ change }: { change: string }) => {
        calls.push(`${change} window`);
      });
      mocks.accountApi.enableWorkerSubdomain.mockImplementation(async () => {
        calls.push('enable subdomain');
      });
      mocks.accountApi.configureWorkspaceRuntimeGcSchedule.mockImplementation(async () => {
        calls.push('configure Worker');
      });
      mocks.accountApi.ensureWorkspaceRuntimeContainer.mockImplementation(async () => {
        calls.push('container applications');
      });
      mocks.waitForReadiness.mockImplementation(async () => {
        calls.push('readiness');
      });
      mocks.upsertRuntime.mockImplementation(async () => {
        calls.push('mark ready');
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({ status: 'ready' });

      expect(calls).toEqual([
        'claim',
        'deploy Worker',
        // The window is renewed through the Worker's subdomain.
        'enable subdomain',
        'hold window',
        'configure Worker',
        'hold window',
        'container applications',
        'hold window',
        'readiness',
        'release window',
        'mark ready',
      ]);
      expect(mocks.changeUpgradeWindow).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint, targetVersion: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      );
    });

    it('moves the workspace and builder container applications to the durable_object policy, naming no image', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });
      mocks.accountApi.deployWorkspaceRuntimeWorker.mockResolvedValue({
        namespaceId: 'namespace-1',
        builderNamespaceId: 'namespace-2',
      });
      const held: boolean[] = [];
      let holding = false;
      mocks.changeUpgradeWindow.mockImplementation(async ({ change }: { change: string }) => {
        holding = change === 'hold';
      });
      mocks.accountApi.ensureWorkspaceRuntimeContainer.mockImplementation(async () => {
        held.push(holding);
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({ status: 'ready' });

      const { workerName } = await workspaceRuntimeNames(connection, 'user-1');
      expect(mocks.accountApi.ensureWorkspaceRuntimeContainer.mock.calls).toEqual([
        [{ applicationName: workerName, namespaceId: 'namespace-1' }],
        [{ applicationName: `${workerName}-builder`, namespaceId: 'namespace-2' }],
      ]);
      // Replacing an application ends its containers, so each runs only while the window is held.
      expect(held).toEqual([true, true]);
      expect(mocks.upsertRuntime).toHaveBeenCalledWith(expect.objectContaining({ imageDigest: USER_WORKSPACE_IMAGE }));
    });

    it('keeps renewing the window while the container applications are replaced', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: NOW });
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });
      let rolledOut: () => void = () => undefined;
      mocks.accountApi.ensureWorkspaceRuntimeContainer.mockReturnValue(
        new Promise<void>((resolve) => {
          rolledOut = resolve;
        }),
      );
      const holds = () => mocks.changeUpgradeWindow.mock.calls.filter(([args]) => args.change === 'hold').length;

      const provisioning = runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs());
      // The configure step held it once, then the rollout holds it and renews it on schedule.
      await vi.waitFor(() => expect(holds()).toBe(2));
      await vi.advanceTimersByTimeAsync(UPGRADE_WINDOW_RENEWAL_MS);
      await vi.waitFor(() => expect(holds()).toBe(3));
      await vi.advanceTimersByTimeAsync(UPGRADE_WINDOW_RENEWAL_MS);
      await vi.waitFor(() => expect(holds()).toBe(4));

      rolledOut();
      await expect(provisioning).resolves.toEqual({ status: 'ready' });
      expect(mocks.changeUpgradeWindow).toHaveBeenLastCalledWith(expect.objectContaining({ change: 'release' }));
    });

    it('waits, never redeploying again, for work that started while the window had lapsed', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });
      let holds = 0;
      mocks.changeUpgradeWindow.mockImplementation(async ({ change }: { change: string }) => {
        // The configure step's retries outlasted the window, and a turn started on the new Worker.
        if (change === 'hold' && ++holds === 2) {
          throw new RuntimeUpgradeWindowRefusedError(1);
        }
      });
      const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async () => {
        expect(mocks.accountApi.ensureWorkspaceRuntimeContainer).not.toHaveBeenCalled();
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
        status: 'ready',
      });

      expect(sleep.mock.calls.map(([, duration]) => duration)).toEqual([30_000]);
      expect(mocks.claimUpgradeWindow).toHaveBeenCalledOnce();
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
      expect(mocks.accountApi.ensureWorkspaceRuntimeContainer).toHaveBeenCalledOnce();
    });

    it('never gives up on a redeployed workspace, however long work on it keeps the window from it', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });
      let now = NOW;
      vi.setSystemTime(now);
      // Work keeps starting on the new Worker for longer than the wait before a redeploy may last.
      mocks.changeUpgradeWindow.mockImplementation(async ({ change }: { change: string }) => {
        if (change === 'hold' && now - NOW < UPGRADE_MAX_WAIT_MS + 60 * 60_000) {
          throw new RuntimeUpgradeWindowRefusedError(1);
        }
      });
      const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async (_name, duration) => {
        expect(duration).toBeLessThanOrEqual(5 * 60_000);
        now += duration;
        vi.setSystemTime(now);
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
        status: 'ready',
      });

      expect(now - NOW).toBeGreaterThan(UPGRADE_MAX_WAIT_MS);
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
      expect(mocks.accountApi.configureWorkspaceRuntimeGcSchedule).toHaveBeenCalledOnce();
      expect(mocks.accountApi.ensureWorkspaceRuntimeContainer).toHaveBeenCalledOnce();
      expect(mocks.waitForReadiness).toHaveBeenCalledOnce();
      expect(mocks.upsertRuntime).toHaveBeenCalledOnce();
    });

    it('names itself to the runtime as the holder of the window it claims, renews and releases', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });

      await runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs());

      expect(mocks.claimUpgradeWindow).toHaveBeenCalledWith(
        expect.objectContaining({ holder: 'workspace-instance-1' }),
      );
      expect(mocks.changeUpgradeWindow.mock.calls.map(([args]) => [args.change, args.holder])).toEqual([
        ['hold', 'workspace-instance-1'],
        ['hold', 'workspace-instance-1'],
        ['hold', 'workspace-instance-1'],
        ['release', 'workspace-instance-1'],
      ]);
    });

    it('retries what follows a redeploy without claiming the window again or redeploying', async () => {
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });
      mocks.accountApi.enableWorkerSubdomain.mockRejectedValueOnce(new Error('Cloudflare API unavailable'));
      mocks.accountApi.ensureWorkspaceRuntimeContainer.mockRejectedValueOnce(new Error('Rollout unavailable'));

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(undefined, 2))).resolves.toEqual({
        status: 'ready',
      });

      expect(mocks.claimUpgradeWindow).toHaveBeenCalledOnce();
      expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
      expect(mocks.accountApi.enableWorkerSubdomain).toHaveBeenCalledTimes(2);
      expect(mocks.accountApi.ensureWorkspaceRuntimeContainer).toHaveBeenCalledTimes(2);
    });

    it('says when it failed after redeploying the Worker, and not when it failed before', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mocks.claimUpgradeWindow.mockRejectedValueOnce(new Error('HTTP 503'));

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({
        status: 'error',
        errorCode: 'workspace_preparation_failed',
        upgradeUrl: null,
      });

      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });
      mocks.accountApi.ensureWorkspaceRuntimeContainer.mockRejectedValueOnce(new Error('Rollout unavailable'));
      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({
        status: 'error',
        errorCode: 'workspace_preparation_failed',
        upgradeUrl: null,
        redeployed: true,
      });
      error.mockRestore();
    });

    it('is ready even when the window could not be released early, since it lapses on its own', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mocks.claimUpgradeWindow.mockResolvedValue({ status: 'granted' });
      mocks.changeUpgradeWindow.mockImplementation(async ({ change }: { change: string }) => {
        if (change === 'release') {
          throw new Error('HTTP 503');
        }
      });

      await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({ status: 'ready' });
      expect(mocks.upsertRuntime).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    describe('of an earlier connection generation, after a reconnect', () => {
      beforeEach(() => {
        mocks.findRuntime.mockResolvedValue({ ...liveRuntime(endpoint), connectionGeneration: 0 });
        mocks.deriveSecret.mockImplementation(async ({ connectionGeneration }: { connectionGeneration: number }) =>
          `secret-${connectionGeneration}`.padEnd(64, 's'),
        );
      });

      it("waits for it to go quiet, asking with that generation's secret, before redeploying it", async () => {
        mocks.claimUpgradeWindow.mockResolvedValueOnce({ status: 'busy', busy: 1 }).mockResolvedValue({
          status: 'granted',
        });
        const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async () => {
          expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
        });

        await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
          status: 'ready',
        });

        expect(mocks.claimUpgradeWindow.mock.calls.map(([args]) => args.controlPlaneSecret)).toEqual([
          'secret-0'.padEnd(64, 's'),
          'secret-0'.padEnd(64, 's'),
        ]);
        expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledWith(
          expect.objectContaining({ controlPlaneSecret: 'secret-1'.padEnd(64, 's') }),
        );
        // The redeployed Worker has this generation's secret, through which the window is held.
        expect(new Set(mocks.changeUpgradeWindow.mock.calls.map(([args]) => args.controlPlaneSecret))).toEqual(
          new Set(['secret-1'.padEnd(64, 's')]),
        );
      });

      it("asks with this generation's secret when a retry finds the Worker it already redeployed", async () => {
        mocks.claimUpgradeWindow
          .mockRejectedValueOnce(new RuntimeSecretRefusedError())
          .mockResolvedValueOnce({ status: 'granted' });

        await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({
          status: 'ready',
        });

        expect(mocks.claimUpgradeWindow.mock.calls.map(([args]) => args.controlPlaneSecret)).toEqual([
          'secret-0'.padEnd(64, 's'),
          'secret-1'.padEnd(64, 's'),
        ]);
        expect(mocks.changeUpgradeWindow).toHaveBeenCalled();
      });

      it('redeploys it as a first workspace when it refuses both secrets', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.claimUpgradeWindow.mockRejectedValue(new RuntimeSecretRefusedError());

        await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({
          status: 'ready',
        });

        expect(mocks.claimUpgradeWindow).toHaveBeenCalledTimes(2);
        expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
        expect(mocks.changeUpgradeWindow).not.toHaveBeenCalled();
        warn.mockRestore();
      });

      it('redeploys it as a first workspace once it has stayed busy for the cap, since its member has no session', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.claimUpgradeWindow.mockResolvedValue({ status: 'busy', busy: 1 });
        let now = NOW;
        vi.setSystemTime(now);
        const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async (_name, duration) => {
          expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
          now += duration;
          vi.setSystemTime(now);
        });

        await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
          status: 'ready',
        });

        // The backoff is cut short so the redeploy comes at the cap, not after the next full wait.
        expect(sleep.mock.calls.map(([, duration]) => duration)).toEqual([
          30_000, 60_000, 120_000, 240_000, 300_000, 150_000,
        ]);
        expect(now - NOW).toBe(EARLIER_GENERATION_MAX_WAIT_MS);
        expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
        expect(mocks.changeUpgradeWindow).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'runtime_upgrade_unwindowed', reason: 'earlier_generation_wait_capped' }),
        );
        warn.mockRestore();
      });

      it('upgrades it inside the window when it goes quiet before the cap', async () => {
        mocks.claimUpgradeWindow
          .mockResolvedValueOnce({ status: 'busy', busy: 1 })
          .mockResolvedValueOnce({ status: 'busy', busy: 1 })
          .mockResolvedValueOnce({ status: 'busy', busy: 1 })
          .mockResolvedValue({ status: 'granted' });
        let now = NOW;
        vi.setSystemTime(now);
        const sleep = vi.fn<UserWorkspaceRuntimeProvisioningStep['sleep']>(async (_name, duration) => {
          expect(mocks.accountApi.deployWorkspaceRuntimeWorker).not.toHaveBeenCalled();
          now += duration;
          vi.setSystemTime(now);
        });

        await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs(sleep))).resolves.toEqual({
          status: 'ready',
        });

        expect(sleep.mock.calls.map(([, duration]) => duration)).toEqual([30_000, 60_000, 120_000]);
        expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
        expect(mocks.changeUpgradeWindow).toHaveBeenCalledWith(expect.objectContaining({ change: 'release' }));
      });

      it('replays the waits an instance recorded before the cap, then redeploys at its next attempt', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.claimUpgradeWindow.mockResolvedValue({ status: 'busy', busy: 1 });
        // What a Workflow started before the cap recorded: it found the runtime live at NOW and has
        // waited past the cap with the old backoff, its next attempt after the last of these waits.
        const waits = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000];
        const recorded = new Map<string, object | number | string>([
          ['inspect account', { status: 'entitled', workersSubdomain: 'user' }],
          ['prepare workspace database', 'database-1'],
          ['inspect live workspace', NOW],
        ]);
        const recordedSleeps = new Set<string>();
        let now = NOW;
        waits.forEach((waitMs, index) => {
          recorded.set(`deploy workspace Worker (attempt ${index + 1})`, { status: 'busy', checkedAt: now, waitMs });
          recordedSleeps.add(`wait for an idle workspace (attempt ${index + 1})`);
          now += waitMs;
        });
        vi.setSystemTime(now);
        const asked: string[] = [];
        const args = workflowArgs();
        const step = {
          async do<T>(
            name: string,
            config: Parameters<UserWorkspaceRuntimeProvisioningStep['do']>[1],
            operation: () => Promise<T>,
          ) {
            asked.push(name);
            if (recorded.has(name)) {
              // SAFETY: each recorded result is the one this step returned when the instance recorded it.
              return recorded.get(name) as T;
            }
            return args.step.do(name, config, operation);
          },
          // A recorded sleep has already elapsed; a new one passes on the clock.
          async sleep(name: string, duration: number) {
            if (!recordedSleeps.has(name)) {
              now += duration;
              vi.setSystemTime(now);
            }
          },
        } satisfies UserWorkspaceRuntimeProvisioningStep;

        await expect(runUserWorkspaceRuntimeProvisioningWorkflow({ ...args, step })).resolves.toEqual({
          status: 'ready',
        });

        expect(asked.slice(0, recorded.size)).toEqual([...recorded.keys()]);
        expect(asked[recorded.size]).toBe(`deploy workspace Worker (attempt ${waits.length + 1})`);
        expect(mocks.claimUpgradeWindow).toHaveBeenCalledOnce();
        expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
        expect(mocks.changeUpgradeWindow).not.toHaveBeenCalled();
        warn.mockRestore();
      });
    });
  });

  it('deploys a first workspace without asking for an upgrade window', async () => {
    await expect(runUserWorkspaceRuntimeProvisioningWorkflow(workflowArgs())).resolves.toEqual({ status: 'ready' });

    expect(mocks.claimUpgradeWindow).not.toHaveBeenCalled();
    expect(mocks.changeUpgradeWindow).not.toHaveBeenCalled();
    expect(mocks.accountApi.deployWorkspaceRuntimeWorker).toHaveBeenCalledOnce();
  });

  it("applies the running release's migrations before uploading its runtime onto a database an earlier release prepared", async () => {
    // What an instance started by the earlier release recorded before a release deployed: its
    // 'prepare workspace database' result is replayed and never applies this release's migrations.
    const recorded = new Map<string, object | string | null>([
      ['inspect account', { status: 'entitled', workersSubdomain: 'user' }],
      ['prepare workspace database', 'database-1'],
      ['inspect live workspace', null],
    ]);
    const order: string[] = [];
    mocks.accountApi.applyD1Migrations.mockImplementation(async () => {
      order.push('migrate');
    });
    mocks.accountApi.deployWorkspaceRuntimeWorker.mockImplementation(async () => {
      order.push('upload');
      return { namespaceId: 'namespace-1' };
    });
    const args = workflowArgs();
    const step = {
      async do<T>(
        name: string,
        config: Parameters<UserWorkspaceRuntimeProvisioningStep['do']>[1],
        operation: () => Promise<T>,
      ) {
        if (recorded.has(name)) {
          // SAFETY: each recorded result is the one this step returned when the instance recorded it.
          return recorded.get(name) as T;
        }
        return args.step.do(name, config, operation);
      },
      sleep: args.step.sleep,
    } satisfies UserWorkspaceRuntimeProvisioningStep;

    await expect(runUserWorkspaceRuntimeProvisioningWorkflow({ ...args, step })).resolves.toEqual({
      status: 'ready',
    });

    expect(mocks.accountApi.ensureD1Database).not.toHaveBeenCalled();
    expect(mocks.accountApi.applyD1Migrations).toHaveBeenCalledExactlyOnceWith(
      'database-1',
      USER_WORKSPACE_DATA_MIGRATIONS,
    );
    expect(order).toEqual(['migrate', 'upload']);
  });

  it('fails closed when the connection cannot provision the runtime', async () => {
    mocks.requireActiveConnection.mockResolvedValueOnce({ ...connection, grantedOAuthScopes: [] });

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
    imageDigest: 'docker.io/cloudflare/sandbox:earlier',
    protocolVersion: USER_WORKSPACE_RUNTIME_PROTOCOL_VERSION,
  };
}

function launchArgs(env: Pick<Env, 'USER_WORKSPACE_RUNTIME_PROVISIONING'>) {
  return { env, userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 1, isReady: async () => false };
}

/** @param attempts how many times each step runs before its failure fails the Workflow, as its retries do */
function workflowArgs(sleep: UserWorkspaceRuntimeProvisioningStep['sleep'] = async () => undefined, attempts = 1) {
  return {
    // SAFETY: these tests inject every external dependency, so only the two Env fields read by orchestration are needed.
    env: {
      DB: {},
      CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY: 'k'.repeat(44),
    } as Env,
    event: {
      payload: { userId: 'user-1', connectionId: 'connection-1', connectionGeneration: 1 },
      instanceId: 'workspace-instance-1',
    },
    step: {
      async do<T>(
        _name: string,
        _config: Parameters<UserWorkspaceRuntimeProvisioningStep['do']>[1],
        operation: () => Promise<T>,
      ) {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await operation();
          } catch (error) {
            if (attempt >= attempts) {
              throw error;
            }
          }
        }
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
