import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
  requireDeployment: vi.fn(),
  executeUserOwnedDeployment: vi.fn(),
  executeUserOwnedPreview: vi.fn(),
}));

vi.mock('~/lib/.server/cloudflare/deployment-repository', async (importOriginal) => ({
  ...(await importOriginal()),
  createDeployment: mocks.createDeployment,
  requireDeploymentForUser: mocks.requireDeployment,
}));
vi.mock('~/lib/.server/cloudflare/user-workspace-deployment-executor', () => ({
  executeUserOwnedDeployment: mocks.executeUserOwnedDeployment,
  executeUserOwnedPreview: mocks.executeUserOwnedPreview,
}));

import { appResourceIdentity, appResourceName } from '~/lib/cloudflare/app-resource-names';
import { DeploymentNotFoundError } from '~/lib/.server/cloudflare/deployment-repository';
import { buildDeploymentPlanFromSource } from '~/lib/.server/cloudflare/deployment-plan';
import { createOrReplayDeploymentPlanForUser, deployForUser, previewForUser } from './deployments';

const project = { type: 'worker' as const, bindings: { ai: false, d1: false, r2: false, kv: false, appAgent: false } };
const revision = 'a'.repeat(64);

function deployment(status: 'approved' | 'succeeded' = 'approved') {
  return {
    id: 'deployment-1',
    chatId: 'chat-row-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    connectionGeneration: 1,
    executionGeneration: 1,
    workspaceReference: `workspace-runtime:agent-1:7:${revision}`,
    status,
    plan: {
      version: 5 as const,
      deploymentId: 'deployment-1',
      sourceSha256: revision,
      project,
      resources: [],
    },
    planDigest: 'b'.repeat(64),
    productionUrl: status === 'succeeded' ? 'https://app.example.workers.dev' : null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('deployment handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireDeployment.mockRejectedValue(new Error('not configured'));
    mocks.createDeployment.mockResolvedValue(deployment());
    mocks.executeUserOwnedDeployment.mockResolvedValue(deployment('succeeded'));
    mocks.executeUserOwnedPreview.mockResolvedValue({
      id: 'version-1',
      url: 'https://cloudchef-app-preview.account.workers.dev',
      workspaceRevision: 7,
      snapshotRevision: revision,
      readyAt: '2026-08-30T00:00:00.000Z',
    });
  });

  it('stores only an opaque reference to the exact user-owned workspace revision', async () => {
    mocks.requireDeployment.mockRejectedValueOnce(
      new (await import('~/lib/.server/cloudflare/deployment-repository')).DeploymentNotFoundError(),
    );
    const db = activeChatDb();
    const result = await createOrReplayDeploymentPlanForUser({
      env: runtimeEnv(db),
      userId: 'user-1',
      chatId: 'chat-1',
      deploymentId: 'deployment-1',
      projectId: 'agent-1',
      revision,
      workspaceRevision: 7,
      project,
    });
    expect(result).toMatchObject({ id: 'deployment-1', status: 'approved' });
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceReference: `workspace-runtime:agent-1:7:${revision}` }),
    );
    // Its Worker, and its preview's, are the project's, whatever revision this is.
    const identity = await appResourceIdentity('agent-1');
    expect(mocks.createDeployment.mock.calls[0]?.[0].plan.resources).toEqual([
      { type: 'worker', logicalName: 'app', proposedName: `cloudchef-${identity}` },
      {
        type: 'worker',
        logicalName: 'app_preview',
        proposedName: `${identity.slice(0, 8)}-cloudchef-${identity}-preview`,
      },
    ]);
  });

  it('plans a revision onto the resources the project’s earlier deployments already use', async () => {
    mocks.requireDeployment.mockRejectedValueOnce(new DeploymentNotFoundError());

    await createOrReplayDeploymentPlanForUser({
      env: runtimeEnv(activeChatDb([{ type: 'worker', logical_name: 'app', name: 'cloudchef-earlier' }])),
      userId: 'user-1',
      chatId: 'chat-1',
      deploymentId: 'deployment-2',
      projectId: 'agent-1',
      revision,
      workspaceRevision: 8,
      project,
    });

    // The preview Worker no earlier deployment had is named after the project.
    expect(mocks.createDeployment.mock.calls[0]?.[0].plan.resources).toEqual([
      { type: 'worker', logicalName: 'app', proposedName: 'cloudchef-earlier' },
      {
        type: 'worker',
        logicalName: 'app_preview',
        proposedName: appResourceName(await appResourceIdentity('agent-1'), 'app_preview'),
      },
    ]);
  });

  it('replays the plan stored under the id while it is still the plan the revision gets', async () => {
    const { plan, digest } = await buildDeploymentPlanFromSource({
      deploymentId: 'deployment-1',
      sourceSha256: revision,
      project,
      naming: { identity: await appResourceIdentity('agent-1'), adopted: [] },
    });
    mocks.requireDeployment.mockResolvedValue({ ...deployment(), plan, planDigest: digest });
    const publication = {
      env: runtimeEnv(activeChatDb()),
      userId: 'user-1',
      chatId: 'chat-1',
      deploymentId: 'deployment-1',
      projectId: 'agent-1',
      revision,
      workspaceRevision: 7,
      project,
    };

    await expect(createOrReplayDeploymentPlanForUser(publication)).resolves.toMatchObject({ id: 'deployment-1' });
    expect(mocks.createDeployment).not.toHaveBeenCalled();

    // Planned before the project's resources were named as they are now: the executor would refuse it.
    mocks.requireDeployment.mockResolvedValue({ ...deployment(), plan, planDigest: 'b'.repeat(64) });
    await expect(createOrReplayDeploymentPlanForUser(publication)).resolves.toBeNull();
    // Planned under a connection since replaced: it could never run.
    mocks.requireDeployment.mockResolvedValue({ ...deployment(), plan, planDigest: digest, connectionGeneration: 0 });
    await expect(createOrReplayDeploymentPlanForUser(publication)).resolves.toBeNull();
    mocks.requireDeployment.mockResolvedValue({ ...deployment(), plan, planDigest: digest, connectionId: 'other' });
    await expect(createOrReplayDeploymentPlanForUser(publication)).resolves.toBeNull();
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it('executes a prepared deployment as one authenticated server operation', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment());
    const env = runtimeEnv(activeChatDb());
    await expect(deployForUser({ env, deploymentId: 'deployment-1', userId: 'user-1' })).resolves.toMatchObject({
      status: 'succeeded',
      productionUrl: 'https://app.example.workers.dev',
    });
    expect(mocks.executeUserOwnedDeployment).toHaveBeenCalledWith({
      env,
      deploymentId: 'deployment-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      executionGeneration: 1,
    });
  });

  it('executes preview as a sibling of the authenticated deployment', async () => {
    mocks.requireDeployment.mockResolvedValue(deployment());
    const env = runtimeEnv(activeChatDb());

    await expect(
      previewForUser({ env, deploymentId: 'deployment-1', previewId: 'preview-1', userId: 'user-1' }),
    ).resolves.toMatchObject({ id: 'version-1', workspaceRevision: 7 });
    expect(mocks.executeUserOwnedPreview).toHaveBeenCalledWith({
      env,
      deploymentId: 'deployment-1',
      previewId: 'preview-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      executionGeneration: 1,
    });
  });
});

/** An active chat, whose project's succeeded deployments named the given account resources. */
function activeChatDb(adopted: { type: string; logical_name: string; name: string }[] = []): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => ({ found: 1, id: 'chat-row-1' })),
        all: vi.fn(async () => ({ results: adopted })),
      })),
    })),
  } as unknown as D1Database;
}

function runtimeEnv(db: D1Database): Env {
  return {
    DB: db,
    CLOUDCHEF_USER_RUNTIME: '1',
    CLOUDCHEF_USER_ID: 'user-1',
    CLOUDCHEF_CONNECTION_ID: 'connection-1',
    CLOUDCHEF_CONNECTION_GENERATION: '1',
  } as unknown as Env;
}
