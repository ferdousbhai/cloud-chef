import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimApprovedDeployment: vi.fn(),
  findDeploymentResource: vi.fn(),
  recordDeploymentActivity: vi.fn(),
  recordDeploymentResource: vi.fn(),
  requireDeployment: vi.fn(),
  transitionDeployment: vi.fn(),
  accountApi: {
    ensureD1Database: vi.fn(),
    deleteD1DatabaseById: vi.fn(),
    deleteManagedWorker: vi.fn(),
    managedWorkerDurableObjectClasses: vi.fn(),
    ensureR2Bucket: vi.fn(),
    ensureKvNamespace: vi.fn(),
    applyD1Migrations: vi.fn(),
    deployManagedWorker: vi.fn(),
    configureManagedWorkerSchedule: vi.fn(),
    enableWorkerSubdomain: vi.fn(),
    getWorkersSubdomain: vi.fn(),
  },
  UserCloudflareAccountApi: vi.fn(),
  /** The credential broker, reached through the global fetch. */
  credentialFetch: vi.fn<typeof fetch>(),
}));

vi.mock('./deployment-plan', async (importOriginal) => ({
  ...(await importOriginal()),
  deploymentPlanResourceName: (plan: { resources: Array<Record<string, string>> }, type: string, logicalName: string) =>
    plan.resources.find((resource) => resource.type === type && resource.logicalName === logicalName)?.proposedName ??
    null,
  isCurrentDeploymentPlan: () => true,
}));
vi.mock('./deployment-repository', () => ({
  DeploymentConcurrencyLimitError: class DeploymentConcurrencyLimitError extends Error {},
  DeploymentStateConflictError: class DeploymentStateConflictError extends Error {
    constructor(readonly status: string) {
      super(`Deployment cannot continue from status ${status}.`);
    }
  },
  claimApprovedDeployment: mocks.claimApprovedDeployment,
  findDeploymentResource: mocks.findDeploymentResource,
  recordDeploymentActivity: mocks.recordDeploymentActivity,
  recordDeploymentResource: mocks.recordDeploymentResource,
  requireDeployment: mocks.requireDeployment,
  transitionDeployment: mocks.transitionDeployment,
}));
vi.mock('./user-account-api', async (importOriginal) => ({
  ...(await importOriginal()),
  UserCloudflareAccountApi: mocks.UserCloudflareAccountApi,
}));

import { isPassingDeploymentFailure } from '~/agents/builder-publication-retry';
import { DeploymentConcurrencyLimitError, DeploymentStateConflictError } from './deployment-repository';
import { D1MigrationChangedError } from './user-account-api';
import {
  executeUserOwnedDeployment,
  terminalizeInterruptedUserOwnedDeployment,
} from './user-workspace-deployment-executor';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('executeUserOwnedDeployment credential-free Computer flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.credentialFetch.mockImplementation(async () =>
      Response.json({ accessToken: 'user-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } }),
    );
    vi.stubGlobal('fetch', mocks.credentialFetch);
    // Vitest must expose a constructible implementation because production
    // instantiates the account API with `new`.
    // eslint-disable-next-line prefer-arrow-callback
    mocks.UserCloudflareAccountApi.mockImplementation(function () {
      return mocks.accountApi;
    });
    mocks.accountApi.deployManagedWorker.mockResolvedValue({
      workerVersionId: '11111111-1111-4111-8111-111111111111',
    });
    mocks.findDeploymentResource.mockResolvedValue(null);
    mocks.accountApi.managedWorkerDurableObjectClasses.mockResolvedValue([]);
    // The project's resources are named as these plans name them.
    mocks.accountApi.configureManagedWorkerSchedule.mockResolvedValue(undefined);
    mocks.accountApi.enableWorkerSubdomain.mockResolvedValue(undefined);
    mocks.accountApi.getWorkersSubdomain.mockResolvedValue('user-subdomain');
    mocks.recordDeploymentResource.mockResolvedValue(undefined);
    mocks.recordDeploymentActivity.mockResolvedValue(undefined);
    mocks.transitionDeployment.mockResolvedValue(undefined);
  });

  it('releases the workspace session and terminalizes an interrupted active execution', async () => {
    const revision = 'a'.repeat(64);
    const deployment = {
      id: 'deployment-1',
      chatId: 'chat-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 3,
      executionGeneration: 4,
      workspaceReference: `workspace-runtime:project-1:7:${revision}`,
      status: 'deploying',
      plan: { sourceSha256: revision },
      planDigest: 'digest-1',
      productionUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const terminalizeInterruptedDeploymentSession = vi.fn().mockResolvedValue(undefined);
    const projectNamespace = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => ({ terminalizeInterruptedDeploymentSession })),
    };
    mocks.requireDeployment
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ ...deployment, status: 'failed' });

    await terminalizeInterruptedUserOwnedDeployment({
      env: { DB: {} as D1Database, PROJECT_WORKSPACE: projectNamespace } as unknown as Env,
      deploymentId: deployment.id,
      userId: deployment.userId,
      connectionId: deployment.connectionId,
      executionGeneration: deployment.executionGeneration,
    });

    expect(terminalizeInterruptedDeploymentSession).toHaveBeenCalledWith({ sessionId: 'deployment-1:4' });
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: 'deployment-1',
        executionGeneration: 4,
        expectedStatus: 'deploying',
        nextStatus: 'failed',
        errorCode: 'cloudflare_cleanup_required',
      }),
    );
  });

  it('recovers an interrupted deployment that promoted its version as succeeded, not failed', async () => {
    const revision = 'a'.repeat(64);
    const deployment = {
      id: 'deployment-1',
      chatId: 'chat-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 3,
      executionGeneration: 4,
      workspaceReference: `workspace-runtime:project-1:7:${revision}`,
      status: 'deploying',
      plan: { sourceSha256: revision },
      planDigest: 'digest-1',
      productionUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const terminalizeInterruptedDeploymentSession = vi.fn().mockResolvedValue(undefined);
    const projectNamespace = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => ({ terminalizeInterruptedDeploymentSession })),
    };
    mocks.requireDeployment
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ ...deployment, status: 'succeeded' });
    mocks.findDeploymentResource.mockImplementation(async (_db, _id, type: string, logicalName: string) =>
      type === 'worker_version' && logicalName === 'production:4'
        ? { providerResourceId: '11111111-1111-4111-8111-111111111111', createdAt: 1 }
        : null,
    );

    await expect(
      terminalizeInterruptedUserOwnedDeployment({
        // SAFETY: recovery reads only these two bindings.
        env: Object.assign({} as Env, { DB: {}, PROJECT_WORKSPACE: projectNamespace }),
        deploymentId: deployment.id,
        userId: deployment.userId,
        connectionId: deployment.connectionId,
        executionGeneration: deployment.executionGeneration,
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });

    expect(terminalizeInterruptedDeploymentSession).toHaveBeenCalledWith({ sessionId: 'deployment-1:4' });
    expect(mocks.transitionDeployment).toHaveBeenCalledOnce();
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        executionGeneration: 4,
        expectedStatus: 'deploying',
        nextStatus: 'succeeded',
        errorCode: 'deployment_follow_up_failed',
      }),
    );
  });

  it('does not make an interrupted deployment retryable until its workspace session is released', async () => {
    const revision = 'a'.repeat(64);
    const deployment = {
      id: 'deployment-1',
      chatId: 'chat-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 3,
      executionGeneration: 4,
      workspaceReference: `workspace-runtime:project-1:7:${revision}`,
      status: 'deploying',
      plan: { sourceSha256: revision },
      planDigest: 'digest-1',
      productionUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const projectNamespace = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => ({
        terminalizeInterruptedDeploymentSession: vi.fn().mockRejectedValue(new Error('workspace unavailable')),
      })),
    };
    mocks.requireDeployment.mockResolvedValue(deployment);

    await expect(
      terminalizeInterruptedUserOwnedDeployment({
        env: { DB: {} as D1Database, PROJECT_WORKSPACE: projectNamespace } as unknown as Env,
        deploymentId: deployment.id,
        userId: deployment.userId,
        connectionId: deployment.connectionId,
        executionGeneration: deployment.executionGeneration,
      }),
    ).rejects.toThrow('workspace unavailable');
    expect(mocks.transitionDeployment).not.toHaveBeenCalled();
  });

  it('passes no credential to ProjectWorkspace and publishes only through the trusted account API', async () => {
    const revision = 'a'.repeat(64);
    const plan = {
      version: 5,
      deploymentId: 'deployment-1',
      sourceSha256: revision,
      project: {
        type: 'worker',
        bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false },
      },
      resources: [{ type: 'worker', logicalName: 'app', proposedName: 'cloudchef-deployment-1' }],
    };
    const deployment = {
      id: 'deployment-1',
      chatId: 'chat-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      connectionGeneration: 3,
      executionGeneration: 4,
      workspaceReference: `workspace-runtime:project-1:7:${revision}`,
      status: 'approved',
      plan,
      planDigest: 'digest-1',
      productionUrl: null,
      errorCode: null,
      errorMessage: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const moduleBytes = new TextEncoder().encode('export default {}');
    const moduleDigest = await crypto.subtle.digest('SHA-256', moduleBytes);
    const prepareDeploymentArtifact = vi.fn(async (_input: Record<string, unknown>) => ({
      revision,
      mainModule: 'index.js',
      modules: [
        {
          path: 'index.js',
          bytes: moduleBytes,
          size: moduleBytes.byteLength,
          sha256: [...new Uint8Array(moduleDigest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        },
      ],
      assets: [],
      migrations: { DB: [], AGENT_SECURITY_DB: [] },
    }));
    const beginDeploymentSession = vi.fn().mockResolvedValue(undefined);
    const assertDeploymentSession = vi.fn().mockResolvedValue({ workspaceRevision: 7, revision });
    const finishDeploymentSession = vi.fn().mockResolvedValue(undefined);
    const projectNamespace = {
      idFromName: vi.fn((name: string) => `id:${name}`),
      get: vi.fn(() => ({
        beginDeploymentSession,
        assertDeploymentSession,
        prepareDeploymentArtifact,
        finishDeploymentSession,
      })),
    };
    mocks.requireDeployment
      .mockResolvedValueOnce(deployment)
      .mockResolvedValueOnce({ ...deployment, status: 'deploying' })
      .mockResolvedValueOnce({ ...deployment, status: 'succeeded' });
    mocks.claimApprovedDeployment.mockResolvedValue({ ...deployment, status: 'provisioning' });
    await executeUserOwnedDeployment({
      env: {
        DB: {} as D1Database,
        CLOUDCHEF_USER_RUNTIME: '1',
        CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build',
        CONTROL_PLANE_SECRET: 'runtime-secret-that-is-long-enough',
        CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
        CLOUDCHEF_USER_ID: 'user-1',
        CLOUDCHEF_CONNECTION_ID: 'connection-1',
        CLOUDCHEF_CONNECTION_GENERATION: '3',
        PROJECT_WORKSPACE: projectNamespace,
      } as unknown as Env,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      executionGeneration: 4,
    });

    expect(prepareDeploymentArtifact).toHaveBeenCalledOnce();
    const projectInput = prepareDeploymentArtifact.mock.calls[0]?.[0];
    expect(projectInput).toMatchObject({
      revision,
      workerName: 'cloudchef-deployment-1',
      projectType: 'worker',
      sessionId: 'deployment-1:4',
    });
    expect(JSON.stringify(projectInput)).not.toMatch(/oauth|token|secret|authorization/i);
    expect(mocks.accountApi.deployManagedWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSha256: revision,
        mainModule: 'index.js',
        modules: expect.any(Array),
      }),
    );
    // One token for the whole publication: a token that expires meanwhile is refreshed when Cloudflare refuses it.
    expect(mocks.credentialFetch).toHaveBeenCalledOnce();
    expect(String(mocks.credentialFetch.mock.calls[0]?.[0])).toBe(
      'https://cloudchef.build/api/cloudflare/runtime-credential',
    );
    expect(JSON.parse(String(mocks.credentialFetch.mock.calls[0]?.[1]?.body))).toMatchObject({ forceRefresh: false });
    expect(beginDeploymentSession).toHaveBeenCalledWith({
      operationId: 'deployment-1:4',
      expectedWorkspaceRevision: 7,
      expectedSnapshotRevision: revision,
    });
    expect(assertDeploymentSession).toHaveBeenCalledWith({ sessionId: 'deployment-1:4' });
    expect(finishDeploymentSession).toHaveBeenCalledWith({
      sessionId: 'deployment-1:4',
      status: 'completed',
    });
    expect(assertDeploymentSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.accountApi.deployManagedWorker.mock.invocationCallOrder[0]!,
    );
  });

  it('records a promoted deployment as succeeded, with a warning, when a step after it keeps failing', async () => {
    const { execution } = await workerDeployment();
    mocks.accountApi.configureManagedWorkerSchedule.mockRejectedValue(new Error('schedules unavailable'));
    mocks.accountApi.getWorkersSubdomain.mockRejectedValue(new Error('subdomain unavailable'));

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    // Each idempotent step is tried twice, and the ones after it still run.
    expect(mocks.accountApi.configureManagedWorkerSchedule).toHaveBeenCalledTimes(2);
    expect(mocks.accountApi.getWorkersSubdomain).toHaveBeenCalledTimes(2);
    expect(mocks.accountApi.enableWorkerSubdomain).toHaveBeenCalledOnce();
    expect(mocks.recordDeploymentResource).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'worker', logicalName: 'app' }),
    );
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: 'deploying',
        nextStatus: 'succeeded',
        productionUrl: null,
        errorCode: 'deployment_follow_up_failed',
        errorMessage: expect.stringMatching(
          /^Production serves the new revision, but setting the Worker's schedule failed \(schedules unavailable\); reading the account's workers\.dev subdomain failed \(subdomain unavailable\)\. The next deployment repeats these steps\.$/,
        ),
      }),
    );
    expect(mocks.transitionDeployment).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'failed' }));
  });

  it('retries a step after promotion that fails once, and reports nothing', async () => {
    const { execution } = await workerDeployment();
    mocks.accountApi.enableWorkerSubdomain.mockRejectedValueOnce(new Error('temporarily unavailable'));

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.accountApi.enableWorkerSubdomain).toHaveBeenCalledTimes(2);
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'succeeded',
        productionUrl: 'https://cloudchef-deployment-1.user-subdomain.workers.dev',
        errorCode: null,
        errorMessage: null,
      }),
    );
  });

  it('still records a deployment as failed when promoting its version fails', async () => {
    const { execution } = await workerDeployment();
    mocks.accountApi.deployManagedWorker.mockRejectedValueOnce(new Error('upload refused'));

    await expect(executeUserOwnedDeployment(execution)).rejects.toThrow('upload refused');

    expect(mocks.accountApi.configureManagedWorkerSchedule).not.toHaveBeenCalled();
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ nextStatus: 'failed', errorCode: 'cloudflare_cleanup_required' }),
    );
  });

  it('records the promoted version, and retries a success write D1 dropped instead of recording a failure', async () => {
    const { execution } = await workerDeployment();
    const successWrites: number[] = [];
    mocks.transitionDeployment.mockImplementation(async (input: { nextStatus: string; now: number }) => {
      if (input.nextStatus !== 'succeeded') {
        return;
      }
      successWrites.push(input.now);
      if (successWrites.length < 3) {
        throw new Error('D1_ERROR: Network connection lost');
      }
    });

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.recordDeploymentResource).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'worker_version',
        logicalName: 'production:4',
        providerResourceId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    expect(successWrites).toHaveLength(3);
    // One timestamp, so a write that landed without its acknowledgement is recognised by the next.
    expect(new Set(successWrites).size).toBe(1);
    expect(mocks.transitionDeployment).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'failed' }));
  });

  it('never records a promoted deployment as failed when its success write cannot land, and asks for the retry that recovers it', async () => {
    const { execution } = await workerDeployment();
    mocks.transitionDeployment.mockImplementation(async (input: { nextStatus: string }) => {
      if (input.nextStatus === 'succeeded') {
        throw new Error('D1_ERROR: Network connection lost');
      }
    });

    const failure = await executeUserOwnedDeployment(execution).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(
      /^Production serves the new revision, but recording its deployment failed \(D1_ERROR: Network connection lost\)\. Deployment was interrupted\./,
    );
    // An automatic deployment retries it, and the retry's recovery records it as succeeded.
    expect(isPassingDeploymentFailure({ message: failure?.message ?? '', retryable: false })).toBe(true);

    expect(mocks.transitionDeployment).toHaveBeenCalledTimes(4);
    expect(mocks.transitionDeployment).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'failed' }));
  });

  it('takes a promoted deployment recovery already recorded as succeeded for its own success', async () => {
    const { execution } = await workerDeployment();
    mocks.transitionDeployment.mockImplementation(async (input: { nextStatus: string }) => {
      if (input.nextStatus === 'succeeded') {
        throw new DeploymentStateConflictError('succeeded');
      }
    });

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.transitionDeployment).toHaveBeenCalledTimes(2);
    expect(mocks.transitionDeployment).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'failed' }));
  });

  it('refuses, before it changes anything, a deployment that drops the Agent from a Worker holding Agent data', async () => {
    const { execution, workspace } = await workerDeployment({ d1: true });
    mocks.accountApi.managedWorkerDurableObjectClasses.mockResolvedValue(['AppAgent']);

    await expect(executeUserOwnedDeployment(execution)).rejects.toThrow(
      "The Agent capability can't be removed from this published app",
    );

    expect(mocks.accountApi.managedWorkerDurableObjectClasses).toHaveBeenCalledWith('cloudchef-deployment-1');
    expect(workspace.beginDeploymentSession).not.toHaveBeenCalled();
    expect(mocks.accountApi.ensureD1Database).not.toHaveBeenCalled();
    expect(mocks.accountApi.applyD1Migrations).not.toHaveBeenCalled();
    expect(mocks.accountApi.deployManagedWorker).not.toHaveBeenCalled();
    expect(mocks.accountApi.deleteManagedWorker).not.toHaveBeenCalled();
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'failed',
        errorCode: 'deployment_provisioning_failed',
        errorMessage: expect.stringContaining('Restore the Agent capability (pnpm run agent:enable)'),
      }),
    );
  });

  it('deploys a Worker without the Agent while no Agent data was ever published to it', async () => {
    const { execution } = await workerDeployment();
    // The account API answers only this Worker's classes; another Worker's AppAgent is not among them.
    mocks.accountApi.managedWorkerDurableObjectClasses.mockResolvedValue([]);

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });
    expect(mocks.accountApi.deployManagedWorker).toHaveBeenCalledOnce();
  });

  it('deploys an app that keeps its Agent onto the Worker holding its Agent data', async () => {
    const { execution, deployment } = await workerDeployment();
    deployment.plan.project.bindings.appAgent = true;
    mocks.accountApi.managedWorkerDurableObjectClasses.mockResolvedValue(['AppAgent']);

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.accountApi.deployManagedWorker).toHaveBeenCalledOnce();
    expect(mocks.accountApi.deleteManagedWorker).not.toHaveBeenCalled();
  });

  it('reports a promoted deployment as succeeded when its closing bookkeeping fails', async () => {
    const { execution, workspace } = await workerDeployment();
    mocks.recordDeploymentActivity.mockImplementation(async (input: { sequence: number }) => {
      if (input.sequence === 80) {
        throw new Error('D1 unavailable');
      }
    });
    workspace.finishDeploymentSession.mockRejectedValueOnce(new Error('workspace reset'));

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.transitionDeployment).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'failed' }));
  });

  it('stops a cancelled deployment before it changes production, releasing the workspace', async () => {
    const { execution, workspace } = await workerDeployment();
    const controller = new AbortController();
    workspace.prepareDeploymentArtifact.mockImplementationOnce(async () => {
      controller.abort(new Error('A newer turn superseded this publication.'));
      return workspace.artifact;
    });

    await expect(executeUserOwnedDeployment({ ...execution, abortSignal: controller.signal })).rejects.toThrow(
      'A newer turn superseded this publication.',
    );

    expect(mocks.accountApi.applyD1Migrations).not.toHaveBeenCalled();
    expect(mocks.accountApi.deployManagedWorker).not.toHaveBeenCalled();
    expect(workspace.finishDeploymentSession).toHaveBeenCalledWith({ sessionId: 'deployment-1:4', status: 'failed' });
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ expectedStatus: 'deploying', nextStatus: 'failed' }),
    );
  });

  it('finishes a deployment cancelled after it started changing production', async () => {
    const { execution } = await workerDeployment();
    const controller = new AbortController();
    mocks.accountApi.deployManagedWorker.mockImplementationOnce(async () => {
      controller.abort(new Error('A newer turn superseded this publication.'));
      return { workerVersionId: '11111111-1111-4111-8111-111111111111' };
    });

    await expect(executeUserOwnedDeployment({ ...execution, abortSignal: controller.signal })).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  it('records a deployment refused for another one of the same project as failed, not left approved', async () => {
    const { execution, deployment, workspace } = await workerDeployment();
    mocks.claimApprovedDeployment.mockRejectedValueOnce(new DeploymentConcurrencyLimitError());

    await expect(executeUserOwnedDeployment(execution)).rejects.toBeInstanceOf(DeploymentConcurrencyLimitError);

    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: deployment.id,
        executionGeneration: 4,
        expectedStatus: 'approved',
        nextStatus: 'failed',
        errorCode: 'deployment_concurrency_limited',
      }),
    );
    expect(workspace.beginDeploymentSession).not.toHaveBeenCalled();
  });

  it('reports a deployment another execution claimed first as in progress, not failed', async () => {
    const { execution, workspace } = await workerDeployment();
    mocks.claimApprovedDeployment.mockRejectedValueOnce(new DeploymentStateConflictError('provisioning'));

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'deploying' });

    expect(mocks.transitionDeployment).not.toHaveBeenCalled();
    expect(workspace.beginDeploymentSession).not.toHaveBeenCalled();
    expect(mocks.accountApi.deployManagedWorker).not.toHaveBeenCalled();
  });

  it('still refuses a deployment whose claim conflicts with a settled record', async () => {
    const { execution } = await workerDeployment();
    mocks.claimApprovedDeployment.mockRejectedValueOnce(new DeploymentStateConflictError('failed'));

    await expect(executeUserOwnedDeployment(execution)).rejects.toBeInstanceOf(DeploymentStateConflictError);
    expect(mocks.transitionDeployment).not.toHaveBeenCalled();
  });

  it('refuses a deployment claimed first by an execution that has already failed', async () => {
    const { execution, deployment } = await workerDeployment();
    mocks.claimApprovedDeployment.mockRejectedValueOnce(new DeploymentStateConflictError('provisioning'));
    mocks.requireDeployment
      .mockReset()
      .mockResolvedValueOnce(deployment)
      .mockResolvedValue({
        ...deployment,
        status: 'failed',
      });

    await expect(executeUserOwnedDeployment(execution)).rejects.toBeInstanceOf(DeploymentStateConflictError);
    expect(mocks.transitionDeployment).not.toHaveBeenCalled();
  });

  it('deploys onto the database the project already has, applying its migrations there', async () => {
    const { execution } = await workerDeployment({ d1: true });

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.accountApi.ensureD1Database.mock.calls).toEqual([['cloudchef-deployment-1']]);
    expect(mocks.accountApi.applyD1Migrations).toHaveBeenCalledWith('DB-database-id', []);
    expect(mocks.accountApi.deployManagedWorker).toHaveBeenCalledWith(
      expect.objectContaining({ workerName: 'cloudchef-deployment-1', d1DatabaseId: 'DB-database-id' }),
    );
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'succeeded',
        productionUrl: 'https://cloudchef-deployment-1.user-subdomain.workers.dev',
      }),
    );
  });

  it('tells the model which applied migration changed, and publishes nothing over it', async () => {
    const { execution } = await workerDeployment({ d1: true });
    mocks.accountApi.applyD1Migrations.mockRejectedValueOnce(new D1MigrationChangedError('0001_app_data.sql'));

    await expect(executeUserOwnedDeployment(execution)).rejects.toThrow(
      'The migration 0001_app_data.sql was already applied to the production database with different contents',
    );

    expect(mocks.accountApi.deployManagedWorker).not.toHaveBeenCalled();
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'failed',
        errorMessage: expect.stringContaining(
          'Put the change in a new migration numbered after the last one, and restore 0001_app_data.sql exactly as it was applied, or delete 0001_app_data.sql if it holds no schema a new database needs',
        ),
      }),
    );
    // A database that did not record what it applied has nothing to quote.
    expect(mocks.transitionDeployment).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining('It was applied as') }),
    );
  });

  it('quotes what the database applied under the changed migration, within the failure it records', async () => {
    const { execution } = await workerDeployment({ d1: true });
    const applied = '-- Add application D1 schema changes here.\nSELECT 1;';
    mocks.accountApi.applyD1Migrations.mockRejectedValueOnce(new D1MigrationChangedError('0001_app_data.sql', applied));

    await expect(executeUserOwnedDeployment(execution)).rejects.toThrow(`It was applied as:\n${applied}`);

    const long = `CREATE TABLE notes (body TEXT);\n${'-- padding\n'.repeat(1_000)}`;
    const second = await workerDeployment({ d1: true });
    mocks.accountApi.applyD1Migrations.mockRejectedValueOnce(new D1MigrationChangedError('0002_notes.sql', long));
    await expect(executeUserOwnedDeployment(second.execution)).rejects.toThrow(
      `restore 0002_notes.sql exactly as it was applied`,
    );

    const recorded = mocks.transitionDeployment.mock.calls
      .map(([transition]) => transition.errorMessage)
      .find((message) => message?.includes('0002_notes.sql'));
    expect(recorded).toContain(`It was applied as:\n${long.slice(0, 2_000)}\n[truncated]`);
    expect(recorded?.length).toBeLessThanOrEqual(4_000);
  });

  it('never starts production’s database over for a changed migration', async () => {
    const { execution } = await workerDeployment({ d1: true });
    mocks.accountApi.applyD1Migrations.mockRejectedValueOnce(new D1MigrationChangedError('0002_notes.sql'));

    await expect(executeUserOwnedDeployment(execution)).rejects.toThrow('already applied to the production database');

    expect(mocks.accountApi.deleteD1DatabaseById).not.toHaveBeenCalled();
    // Only provisioning asked for it.
    expect(mocks.accountApi.ensureD1Database).toHaveBeenCalledOnce();
  });

  it('deploys production onto production’s bucket and namespace', async () => {
    const { execution } = await workerDeployment({ storage: true });

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.accountApi.ensureR2Bucket.mock.calls).toEqual([['cloudchef-deployment-1-storage']]);
    expect(mocks.accountApi.ensureKvNamespace.mock.calls).toEqual([['cloudchef-deployment-1-cache']]);
    expect(mocks.accountApi.deployManagedWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        workerName: 'cloudchef-deployment-1',
        r2BucketName: 'cloudchef-deployment-1-storage',
        kvNamespaceId: 'a'.repeat(32),
      }),
    );
  });
});

/** An approved deployment of a plain Worker, with the runtime bindings and ProjectWorkspace it publishes through. */
async function workerDeployment(options: { d1?: boolean; storage?: boolean } = {}) {
  const revision = 'a'.repeat(64);
  const d1 = options.d1 === true;
  const storage = options.storage === true;
  const deployment = {
    id: 'deployment-1',
    chatId: 'chat-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 3,
    executionGeneration: 4,
    workspaceReference: `workspace-runtime:project-1:7:${revision}`,
    status: 'approved',
    plan: {
      version: 5,
      deploymentId: 'deployment-1',
      sourceSha256: revision,
      project: { type: 'worker', bindings: { ai: false, d1, r2: storage, kv: storage, appAgent: false } },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'cloudchef-deployment-1' },
        ...(storage
          ? [
              { type: 'r2', logicalName: 'APP_STORAGE', proposedName: 'cloudchef-deployment-1-storage' },
              { type: 'kv', logicalName: 'APP_CACHE', proposedName: 'cloudchef-deployment-1-cache' },
            ]
          : []),
        ...(d1 ? [{ type: 'd1', logicalName: 'DB', proposedName: 'cloudchef-deployment-1' }] : []),
      ],
    },
    planDigest: 'digest-1',
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
  if (storage) {
    mocks.accountApi.ensureR2Bucket.mockImplementation(async (name: string) => ({ id: name, name }));
    mocks.accountApi.ensureKvNamespace.mockImplementation(async (name: string) => ({ id: 'a'.repeat(32), name }));
  }
  if (d1) {
    mocks.accountApi.ensureD1Database.mockImplementation(async (name: string) => ({ id: 'DB-database-id', name }));
  }
  const moduleBytes = new TextEncoder().encode('export default {}');
  const moduleDigest = await crypto.subtle.digest('SHA-256', moduleBytes);
  const artifact = {
    revision,
    mainModule: 'index.js',
    modules: [
      {
        path: 'index.js',
        bytes: moduleBytes,
        size: moduleBytes.byteLength,
        sha256: [...new Uint8Array(moduleDigest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      },
    ],
    assets: [],
    migrations: { DB: noMigrations(), AGENT_SECURITY_DB: noMigrations() },
  };
  const workspace = {
    artifact,
    beginDeploymentSession: vi.fn().mockResolvedValue(undefined),
    assertDeploymentSession: vi.fn().mockResolvedValue({ workspaceRevision: 7, revision }),
    prepareDeploymentArtifact: vi.fn(async () => artifact),
    finishDeploymentSession: vi.fn().mockResolvedValue(undefined),
  };
  mocks.requireDeployment
    .mockReset()
    .mockResolvedValueOnce(deployment)
    .mockResolvedValueOnce({ ...deployment, status: 'deploying' })
    .mockResolvedValueOnce({ ...deployment, status: 'succeeded' });
  mocks.claimApprovedDeployment.mockResolvedValue({ ...deployment, status: 'provisioning' });
  // SAFETY: this test double supplies every user-runtime binding read by the executor.
  const env = Object.assign({} as Env, {
    DB: {},
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build',
    CONTROL_PLANE_SECRET: 'runtime-secret-that-is-long-enough',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    CLOUDCHEF_USER_ID: 'user-1',
    CLOUDCHEF_CONNECTION_ID: 'connection-1',
    CLOUDCHEF_CONNECTION_GENERATION: '3',
    PROJECT_WORKSPACE: { idFromName: (name: string) => `id:${name}`, get: () => workspace },
  });
  const execution = {
    env,
    deploymentId: deployment.id,
    userId: 'user-1',
    connectionId: 'connection-1',
    executionGeneration: 4,
  };
  return { execution, deployment, workspace };
}

function noMigrations(): { name: string; sql: string }[] {
  return [];
}
