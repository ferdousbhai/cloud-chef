import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimApprovedDeployment: vi.fn(),
  findDeploymentResource: vi.fn(),
  projectResourceNaming: vi.fn(),
  recordDeploymentActivity: vi.fn(),
  recordDeploymentResource: vi.fn(),
  requireDeployment: vi.fn(),
  transitionDeployment: vi.fn(),
  accountApi: {
    ensureD1ForPlan: vi.fn(),
    ensureR2ForPlan: vi.fn(),
    ensureKvForPlan: vi.fn(),
    applyD1Migrations: vi.fn(),
    deployManagedWorker: vi.fn(),
    previewManagedWorker: vi.fn(),
    readManagedWorkerPreviewUrl: vi.fn(),
    configureManagedWorkerSchedule: vi.fn(),
    enableWorkerSubdomain: vi.fn(),
    getWorkersSubdomain: vi.fn(),
  },
  UserCloudflareAccountApi: vi.fn(),
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
  claimApprovedDeployment: mocks.claimApprovedDeployment,
  findDeploymentResource: mocks.findDeploymentResource,
  projectResourceNaming: mocks.projectResourceNaming,
  recordDeploymentActivity: mocks.recordDeploymentActivity,
  recordDeploymentResource: mocks.recordDeploymentResource,
  requireDeployment: mocks.requireDeployment,
  transitionDeployment: mocks.transitionDeployment,
}));
vi.mock('./user-account-api', async (importOriginal) => ({
  ...(await importOriginal()),
  UserCloudflareAccountApi: mocks.UserCloudflareAccountApi,
}));

import { DeploymentConcurrencyLimitError } from './deployment-repository';
import { D1MigrationChangedError } from './user-account-api';
import {
  executeUserOwnedDeployment,
  executeUserOwnedPreview,
  terminalizeInterruptedUserOwnedDeployment,
} from './user-workspace-deployment-executor';

describe('executeUserOwnedDeployment credential-free Computer flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Vitest must expose a constructible implementation because production
    // instantiates the account API with `new`.
    // eslint-disable-next-line prefer-arrow-callback
    mocks.UserCloudflareAccountApi.mockImplementation(function () {
      return mocks.accountApi;
    });
    mocks.accountApi.deployManagedWorker.mockResolvedValue({
      workerVersionId: '11111111-1111-4111-8111-111111111111',
    });
    mocks.accountApi.previewManagedWorker.mockResolvedValue({
      workerVersionId: '22222222-2222-4222-8222-222222222222',
      previewUrl: 'https://22222222-cloudchef-deployment-1.user-subdomain.workers.dev',
    });
    mocks.findDeploymentResource.mockResolvedValue(null);
    // The project's resources are named as these plans name them.
    mocks.projectResourceNaming.mockResolvedValue({ identity: 'deployment-1', adopted: [] });
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
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ accessToken: 'provisioning-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } }),
      )
      .mockResolvedValueOnce(
        Response.json({ accessToken: 'publishing-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } }),
      );

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
      request,
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
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.every(([url]) => url === 'https://cloudchef.build/api/cloudflare/runtime-credential'),
    ).toBe(true);
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toMatchObject({ forceRefresh: false });
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

  it('binds and migrates only the preview D1 when uploading an unpromoted version', async () => {
    const revision = 'd'.repeat(64);
    const plan = {
      version: 5,
      deploymentId: 'deployment-1',
      sourceSha256: revision,
      project: {
        type: 'worker',
        bindings: { ai: false, d1: true, r2: false, kv: false, appAgent: true },
      },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'cloudchef-deployment-1' },
        { type: 'd1', logicalName: 'DB', proposedName: 'cloudchef-deployment-1' },
        { type: 'd1', logicalName: 'DB_PREVIEW', proposedName: 'cloudchef-deployment-1-preview' },
        {
          type: 'd1',
          logicalName: 'AGENT_SECURITY_DB',
          proposedName: 'cloudchef-deployment-1-agent-security',
        },
        {
          type: 'd1',
          logicalName: 'AGENT_SECURITY_DB_PREVIEW',
          proposedName: 'cloudchef-deployment-1-preview-agent',
        },
        { type: 'durable_object', logicalName: 'AppAgent', proposedName: 'AppAgent' },
      ],
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
    const prepareDeploymentArtifact = vi.fn(async () => ({
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
      migrations: {
        DB: [{ name: '0001_app_data.sql', sql: 'CREATE TABLE app_data (id TEXT);' }],
        AGENT_SECURITY_DB: [{ name: '0001_agent.sql', sql: 'CREATE TABLE agent_data (id TEXT);' }],
      },
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
    mocks.requireDeployment.mockResolvedValue(deployment);
    mocks.accountApi.ensureD1ForPlan.mockImplementation(async (_plan, logicalName) =>
      logicalName === 'AGENT_SECURITY_DB_PREVIEW'
        ? { id: 'preview-agent-database-id', name: 'cloudchef-deployment-1-preview-agent' }
        : { id: 'preview-database-id', name: 'cloudchef-deployment-1-preview' },
    );
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ accessToken: 'user-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } }),
      );
    // SAFETY: this test double supplies every user-runtime binding read by the preview executor.
    const previewEnv = Object.assign({} as Env, {
      DB: {},
      CLOUDCHEF_USER_RUNTIME: '1',
      CLOUDCHEF_CONTROL_PLANE_ENDPOINT: 'https://cloudchef.build',
      CONTROL_PLANE_SECRET: 'runtime-secret-that-is-long-enough',
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      CLOUDCHEF_USER_ID: 'user-1',
      CLOUDCHEF_CONNECTION_ID: 'connection-1',
      CLOUDCHEF_CONNECTION_GENERATION: '3',
      PROJECT_WORKSPACE: projectNamespace,
    });

    await expect(
      executeUserOwnedPreview({
        env: previewEnv,
        deploymentId: 'deployment-1',
        previewId: 'preview-1',
        userId: 'user-1',
        connectionId: 'connection-1',
        executionGeneration: 4,
        request,
      }),
    ).resolves.toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      workspaceRevision: 7,
      snapshotRevision: revision,
    });

    expect(mocks.accountApi.ensureD1ForPlan.mock.calls).toEqual([
      [plan, 'DB_PREVIEW'],
      [plan, 'AGENT_SECURITY_DB_PREVIEW'],
    ]);
    expect(prepareDeploymentArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'preview:deployment-1:4:preview-1',
        d1DatabaseId: 'preview-database-id',
        d1DatabaseName: 'cloudchef-deployment-1-preview',
        agentSecurityD1DatabaseId: 'preview-agent-database-id',
        agentSecurityD1DatabaseName: 'cloudchef-deployment-1-preview-agent',
      }),
    );
    expect(mocks.accountApi.applyD1Migrations).toHaveBeenCalledWith('preview-database-id', [
      { name: '0001_app_data.sql', sql: 'CREATE TABLE app_data (id TEXT);' },
    ]);
    expect(mocks.accountApi.applyD1Migrations).toHaveBeenCalledWith('preview-agent-database-id', [
      { name: '0001_agent.sql', sql: 'CREATE TABLE agent_data (id TEXT);' },
    ]);
    expect(mocks.accountApi.previewManagedWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        d1DatabaseId: 'preview-database-id',
        agentSecurityD1DatabaseId: 'preview-agent-database-id',
        sourceSha256: revision,
      }),
    );
    expect(mocks.accountApi.deployManagedWorker).not.toHaveBeenCalled();
    expect(finishDeploymentSession).toHaveBeenCalledWith({
      sessionId: 'preview:deployment-1:4:preview-1',
      status: 'completed',
    });
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

  it('stops a cancelled preview at its next step and releases the workspace', async () => {
    const { execution, deployment, workspace } = await workerDeployment();
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment);
    const controller = new AbortController();
    workspace.prepareDeploymentArtifact.mockImplementationOnce(async () => {
      controller.abort(new Error('A newer turn superseded this publication.'));
      return workspace.artifact;
    });

    await expect(
      executeUserOwnedPreview({ ...execution, previewId: 'preview-1', abortSignal: controller.signal }),
    ).rejects.toThrow('A newer turn superseded this publication.');

    expect(mocks.accountApi.previewManagedWorker).not.toHaveBeenCalled();
    expect(workspace.finishDeploymentSession).toHaveBeenCalledWith({
      sessionId: 'preview:deployment-1:4:preview-1',
      status: 'failed',
    });
  });

  it('refuses, while it holds the project, a deployment planned for other resources than the project’s', async () => {
    const { execution, deployment, workspace } = await workerDeployment({ d1: true });
    // An earlier deployment of the project, from when each named its own, holds production's data.
    mocks.projectResourceNaming.mockResolvedValue({
      identity: 'project-1',
      adopted: [{ type: 'd1', logicalName: 'DB', name: 'cloudchef-earlier' }],
    });

    await expect(executeUserOwnedDeployment(execution)).rejects.toThrow(
      'planned for Cloudflare resources the project no longer uses',
    );

    expect(mocks.projectResourceNaming).toHaveBeenCalledWith(
      execution.env.DB,
      expect.objectContaining({ id: deployment.id, status: 'provisioning' }),
    );
    expect(mocks.claimApprovedDeployment.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.projectResourceNaming.mock.invocationCallOrder[0]!,
    );
    expect(mocks.accountApi.ensureD1ForPlan).not.toHaveBeenCalled();
    expect(mocks.accountApi.deployManagedWorker).not.toHaveBeenCalled();
    expect(workspace.beginDeploymentSession).not.toHaveBeenCalled();
    expect(mocks.transitionDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedStatus: 'provisioning',
        nextStatus: 'failed',
        errorCode: 'deployment_provisioning_failed',
      }),
    );
  });

  it('refuses a preview planned for other resources than the project’s before it creates any', async () => {
    const { execution, deployment, workspace } = await workerDeployment({ d1: true });
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment);
    mocks.projectResourceNaming.mockResolvedValue({ identity: 'project-1', adopted: [] });

    await expect(executeUserOwnedPreview({ ...execution, previewId: 'preview-1' })).rejects.toThrow(
      'planned for Cloudflare resources the project no longer uses',
    );

    expect(mocks.accountApi.ensureD1ForPlan).not.toHaveBeenCalled();
    expect(mocks.accountApi.previewManagedWorker).not.toHaveBeenCalled();
    expect(workspace.beginDeploymentSession).not.toHaveBeenCalled();
  });

  it('deploys onto the database the project already has, applying its migrations there', async () => {
    const { execution } = await workerDeployment({ d1: true });

    await expect(executeUserOwnedDeployment(execution)).resolves.toMatchObject({ status: 'succeeded' });

    expect(mocks.accountApi.ensureD1ForPlan.mock.calls.map(([, logicalName]) => logicalName)).toEqual(['DB']);
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
        errorMessage: expect.stringContaining('make the change in a new migration'),
      }),
    );
  });

  it('names the preview database when a preview finds an applied migration changed', async () => {
    const { execution, deployment } = await workerDeployment({ d1: true });
    mocks.requireDeployment.mockReset().mockResolvedValue(deployment);
    mocks.accountApi.applyD1Migrations.mockRejectedValueOnce(new D1MigrationChangedError('0002_notes.sql'));

    await expect(executeUserOwnedPreview({ ...execution, previewId: 'preview-1' })).rejects.toThrow(
      'The migration 0002_notes.sql was already applied to the preview database',
    );
    expect(mocks.accountApi.previewManagedWorker).not.toHaveBeenCalled();
  });
});

/** An approved deployment of a plain Worker, with the runtime bindings and ProjectWorkspace it publishes through. */
async function workerDeployment(options: { d1?: boolean } = {}) {
  const revision = 'a'.repeat(64);
  const d1 = options.d1 === true;
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
      project: { type: 'worker', bindings: { ai: false, d1, r2: false, kv: false, appAgent: false } },
      resources: [
        { type: 'worker', logicalName: 'app', proposedName: 'cloudchef-deployment-1' },
        ...(d1
          ? [
              { type: 'd1', logicalName: 'DB', proposedName: 'cloudchef-deployment-1' },
              { type: 'd1', logicalName: 'DB_PREVIEW', proposedName: 'cloudchef-deployment-1-preview' },
            ]
          : []),
      ],
    },
    planDigest: 'digest-1',
    productionUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
  if (d1) {
    mocks.accountApi.ensureD1ForPlan.mockImplementation(async (_plan, logicalName) => ({
      id: `${logicalName}-database-id`,
      name: logicalName === 'DB' ? 'cloudchef-deployment-1' : 'cloudchef-deployment-1-preview',
    }));
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
    migrations: { DB: [], AGENT_SECURITY_DB: [] },
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
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ accessToken: 'user-oauth-token' }, { headers: { 'Cache-Control': 'no-store' } }),
  );
  const execution = {
    env,
    deploymentId: deployment.id,
    userId: 'user-1',
    connectionId: 'connection-1',
    executionGeneration: 4,
    request,
  };
  return { execution, deployment, workspace };
}
