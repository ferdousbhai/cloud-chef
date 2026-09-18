import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toolFailure, toolSuccess } from 'cloudchef-agent/tool-result';
import type { BuilderWorkspaceDeploymentPlan } from './builder-workspace-api';

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
  deployForUser: vi.fn(),
  previewForUser: vi.fn(),
  terminalizeInterrupted: vi.fn(),
}));

vi.mock('~/server-handlers/deployments', () => ({
  createOrReplayDeploymentPlanForUser: mocks.createDeployment,
  deployForUser: mocks.deployForUser,
  previewForUser: mocks.previewForUser,
  terminalizeInterruptedDeploymentForUser: mocks.terminalizeInterrupted,
}));

import {
  deployValidatedRevisionForBuilder,
  previewValidatedRevisionForBuilder,
  terminalizeInterruptedDeploymentForBuilder,
  validatePreviewCheckpointForBuilder,
  validatedDeploymentCheckpoint,
} from './builder-deployment-command';

describe('builder deployment command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDeployment.mockResolvedValue({ id: '11111111-1111-5111-8111-111111111111', status: 'approved' });
    mocks.deployForUser.mockResolvedValue({
      id: '11111111-1111-5111-8111-111111111111',
      status: 'succeeded',
      productionUrl: 'https://app.example.com',
      error: null,
    });
    mocks.terminalizeInterrupted.mockResolvedValue({
      id: '11111111-1111-5111-8111-111111111111',
      status: 'failed',
      productionUrl: null,
      error: { message: 'Deployment was interrupted.' },
    });
    mocks.previewForUser.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      url: 'https://22222222-cloudchef-app.account.workers.dev',
      workspaceRevision: 7,
      snapshotRevision: 'a'.repeat(64),
      readyAt: '2026-08-30T00:00:00.000Z',
    });
  });

  it('reports readiness only for the exact checkpoint with a durable validation receipt', async () => {
    const workspace = workspaceStub();
    await expect(validatedDeploymentCheckpoint(workspace)).resolves.toBeNull();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    await expect(validatedDeploymentCheckpoint(workspace)).resolves.toEqual({
      workspaceRevision: 7,
      revision: 'a'.repeat(64),
    });
  });

  it('validates the exact checkpoint before a manual preview', async () => {
    const workspace = workspaceStub();
    workspace.validate.mockImplementationOnce(async () => {
      workspace.hasSuccessfulValidation.mockResolvedValue(true);
      return toolSuccess('Project validation passed.');
    });
    const requestedSnapshot = { workspaceRevision: 7, revision: 'a'.repeat(64) };

    await expect(
      validatePreviewCheckpointForBuilder({
        workspace,
        requestedSnapshot,
        toolCallId: 'preview:preview-1:validation',
      }),
    ).resolves.toEqual(requestedSnapshot);
    expect(workspace.validate).toHaveBeenCalledWith({
      toolCallId: 'preview:preview-1:validation',
      input: { source: 'preview' },
    });
  });

  it('reuses an exact durable validation receipt for preview', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);

    await validatePreviewCheckpointForBuilder({
      workspace,
      requestedSnapshot: { workspaceRevision: 7, revision: 'a'.repeat(64) },
      toolCallId: 'preview:preview-1:validation',
    });

    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('surfaces full validation failure instead of attempting preview publication', async () => {
    const workspace = workspaceStub();
    workspace.validate.mockResolvedValueOnce(toolFailure('Typecheck failed in src/routes/index.tsx.'));

    await expect(
      validatePreviewCheckpointForBuilder({
        workspace,
        requestedSnapshot: { workspaceRevision: 7, revision: 'a'.repeat(64) },
        toolCallId: 'preview:preview-1:validation',
      }),
    ).rejects.toThrow('Preview validation failed: Typecheck failed in src/routes/index.tsx.');
    expect(mocks.previewForUser).not.toHaveBeenCalled();
  });

  it('does not validate a stale preview request against a newer checkpoint', async () => {
    const workspace = workspaceStub();

    await expect(
      validatePreviewCheckpointForBuilder({
        workspace,
        requestedSnapshot: { workspaceRevision: 6, revision: 'b'.repeat(64) },
        toolCallId: 'preview:preview-1:validation',
      }),
    ).rejects.toThrow('project changed after the preview was requested');
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('refuses deployment when the validated revision is stale', async () => {
    const workspace = workspaceStub();
    await expect(
      deployValidatedRevisionForBuilder({
        context: operationContext(),
        workspace,
        toolCallId: 'deploy-command',
        validatedRevision: 'c'.repeat(64),
      }),
    ).rejects.toThrow('changed after validation');
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it('terminalizes the same deterministic deployment after fiber interruption', async () => {
    const workspace = workspaceStub();
    await terminalizeInterruptedDeploymentForBuilder({
      context: operationContext(),
      workspace,
      toolCallId: 'deploy-command:7:revision',
      validatedRevision: 'a'.repeat(64),
    });

    expect(mocks.terminalizeInterrupted).toHaveBeenCalledWith({
      env: expect.anything(),
      userId: 'user-1',
      deploymentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('accepts recovery before the deterministic deployment row was created', async () => {
    mocks.terminalizeInterrupted.mockResolvedValueOnce(null);

    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace: workspaceStub(),
        toolCallId: 'deploy-command:7:revision',
        validatedRevision: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('before execution started') });
  });

  it('creates and executes one idempotent exact-revision deployment', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    await expect(
      deployValidatedRevisionForBuilder({
        context: operationContext(),
        workspace,
        toolCallId: 'deploy-command',
        validatedRevision: 'a'.repeat(64),
      }),
    ).resolves.toEqual({
      id: '11111111-1111-5111-8111-111111111111',
      status: 'succeeded',
      productionUrl: 'https://app.example.com',
      error: null,
    });
    expect(mocks.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        chatId: 'chat-1',
        deploymentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        projectId: 'workspace-1',
        revision: 'a'.repeat(64),
        workspaceRevision: 7,
      }),
    );
    expect(mocks.deployForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', deploymentId: expect.stringMatching(/^[0-9a-f-]{36}$/) }),
    );
  });

  it('uses the same deterministic plan for preview and production of one validated revision', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    const revision = 'a'.repeat(64);

    await previewValidatedRevisionForBuilder({
      context: operationContext(),
      workspace,
      toolCallId: `deploy-command:7:${revision}`,
      previewId: 'preview-1',
      validatedRevision: revision,
    });
    await deployValidatedRevisionForBuilder({
      context: operationContext(),
      workspace,
      toolCallId: `deploy-command:7:${revision}`,
      validatedRevision: revision,
    });

    const previewPlan = mocks.createDeployment.mock.calls[0]?.[0];
    const productionPlan = mocks.createDeployment.mock.calls[1]?.[0];
    expect(previewPlan.deploymentId).toBe(productionPlan.deploymentId);
    expect(mocks.previewForUser).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: previewPlan.deploymentId, previewId: 'preview-1' }),
    );
  });
});

function workspaceStub() {
  return {
    projectId: 'workspace-1',
    checkpoint: vi.fn(async () => ({ workspaceRevision: 7, revision: 'a'.repeat(64) })),
    hasSuccessfulValidation: vi.fn(async () => false),
    validate: vi.fn(async () => toolSuccess('Project validation passed.')),
    prepareDeployment: vi.fn(async () => ({
      workspaceRevision: 7,
      revision: 'a'.repeat(64),
      project: {
        type: 'web_app',
        bindings: { ai: true, d1: true, r2: true, kv: true, appAgent: true },
      } satisfies BuilderWorkspaceDeploymentPlan['project'],
    })),
  };
}

function operationContext() {
  return { env: {} as Env, userId: 'user-1', chatInitialId: 'chat-1' };
}
