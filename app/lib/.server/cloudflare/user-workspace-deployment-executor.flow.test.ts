import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimApprovedDeployment: vi.fn(),
  findDeploymentResource: vi.fn(),
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

vi.mock('./deployment-plan', () => ({
  deploymentPlanResourceName: (plan: { resources: Array<Record<string, string>> }, type: string, logicalName: string) =>
    plan.resources.find((resource) => resource.type === type && resource.logicalName === logicalName)?.proposedName ??
    null,
  isCurrentDeploymentPlan: () => true,
}));
vi.mock('./deployment-repository', () => ({
  claimApprovedDeployment: mocks.claimApprovedDeployment,
  findDeploymentResource: mocks.findDeploymentResource,
  recordDeploymentActivity: mocks.recordDeploymentActivity,
  recordDeploymentResource: mocks.recordDeploymentResource,
  requireDeployment: mocks.requireDeployment,
  transitionDeployment: mocks.transitionDeployment,
}));
vi.mock('./user-account-api', () => ({
  UserCloudflareAccountApi: mocks.UserCloudflareAccountApi,
}));

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
      mainModule: 'server.js',
      modules: [
        {
          path: 'server.js',
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
        mainModule: 'server.js',
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
      mainModule: 'server.js',
      modules: [
        {
          path: 'server.js',
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
});
