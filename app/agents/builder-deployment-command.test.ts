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
  buildCheckpointForBuilder,
  deployValidatedRevisionForBuilder,
  previewValidatedRevisionForBuilder,
  terminalizeInterruptedDeploymentForBuilder,
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
      url: 'https://cloudchef-app-preview.account.workers.dev',
      workspaceRevision: 7,
      snapshotRevision: 'a'.repeat(64),
      readyAt: '2026-08-30T00:00:00.000Z',
    });
  });

  it('builds the exact checkpoint a preview was asked for', async () => {
    const workspace = workspaceStub();
    workspace.validate.mockImplementationOnce(async () => {
      workspace.hasSuccessfulValidation.mockResolvedValue(true);
      return toolSuccess('Project validation passed.');
    });
    const requestedSnapshot = { workspaceRevision: 7, revision: 'a'.repeat(64) };

    await expect(
      buildCheckpointForBuilder({
        workspace,
        requestedSnapshot,
        publication: 'preview',
        toolCallId: 'preview:preview-1:validation',
      }),
    ).resolves.toEqual(requestedSnapshot);
    expect(workspace.validate).toHaveBeenCalledWith({
      toolCallId: 'preview:preview-1:validation',
      input: { source: 'preview' },
    });
  });

  it('reuses the build an earlier validation of the exact revision left', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);

    await buildCheckpointForBuilder({
      workspace,
      requestedSnapshot: { workspaceRevision: 7, revision: 'a'.repeat(64) },
      publication: 'preview',
      toolCallId: 'preview:preview-1:validation',
    });

    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('surfaces a failed build instead of publishing anything', async () => {
    const workspace = workspaceStub();
    workspace.validate.mockResolvedValueOnce(toolFailure('Typecheck failed in src/routes/index.tsx.'));

    await expect(
      buildCheckpointForBuilder({
        workspace,
        requestedSnapshot: { workspaceRevision: 7, revision: 'a'.repeat(64) },
        publication: 'preview',
        toolCallId: 'preview:preview-1:validation',
      }),
    ).rejects.toThrow('The build failed: Typecheck failed in src/routes/index.tsx.');
    expect(mocks.previewForUser).not.toHaveBeenCalled();
  });

  it('builds a deployment of a revision nobody validated', async () => {
    const workspace = workspaceStub();
    workspace.validate.mockImplementationOnce(async () => {
      workspace.hasSuccessfulValidation.mockResolvedValue(true);
      return toolSuccess('Project validation passed.');
    });

    await buildCheckpointForBuilder({
      workspace,
      requestedSnapshot: { workspaceRevision: 7, revision: 'a'.repeat(64) },
      publication: 'deployment',
      toolCallId: 'deployment:7:validation',
    });

    expect(workspace.validate).toHaveBeenCalledWith({
      toolCallId: 'deployment:7:validation',
      input: { source: 'deployment' },
    });
  });

  it('never builds a newer checkpoint than the one that was asked for', async () => {
    const workspace = workspaceStub();

    await expect(
      buildCheckpointForBuilder({
        workspace,
        requestedSnapshot: { workspaceRevision: 6, revision: 'b'.repeat(64) },
        publication: 'preview',
        toolCallId: 'preview:preview-1:validation',
      }),
    ).rejects.toThrow('project changed after the preview was requested');
    expect(workspace.validate).not.toHaveBeenCalled();
  });

  it('refuses deployment when the project changed after its build', async () => {
    const workspace = workspaceStub();
    await expect(
      deployValidatedRevisionForBuilder({
        context: operationContext(),
        workspace,
        toolCallId: 'deploy-command',
        validatedRevision: 'c'.repeat(64),
      }),
    ).rejects.toThrow('changed after it was built');
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
    mocks.terminalizeInterrupted.mockResolvedValue(null);

    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace: workspaceStub(),
        toolCallId: 'deploy-command:7:revision',
        validatedRevision: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('before execution started') });
  });

  it('settles an interrupted deployment recorded under the identity it had before resources were the project’s', async () => {
    mocks.terminalizeInterrupted.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: '33333333-3333-5333-8333-333333333333',
      status: 'succeeded',
      productionUrl: 'https://cloudchef-earlier.account.workers.dev',
      error: null,
    });
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    const revision = 'a'.repeat(64);

    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace,
        toolCallId: `deploy-command:7:${revision}`,
        validatedRevision: revision,
      }),
    ).resolves.toEqual({
      id: '33333333-3333-5333-8333-333333333333',
      status: 'succeeded',
      productionUrl: 'https://cloudchef-earlier.account.workers.dev',
      error: null,
    });
    await deployValidatedRevisionForBuilder({
      context: operationContext(),
      workspace,
      toolCallId: `deploy-command:7:${revision}`,
      validatedRevision: revision,
    });

    const [current, previous] = mocks.terminalizeInterrupted.mock.calls.map(([input]) => input.deploymentId);
    expect(previous).toMatch(/^[0-9a-f-]{36}$/);
    expect(previous).not.toBe(current);
    // A publication now is planned under the current identity, so a plan made before is never replayed.
    expect(mocks.createDeployment).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: current }));
  });

  it('looks no further than the current identity once it has a record', async () => {
    await terminalizeInterruptedDeploymentForBuilder({
      context: operationContext(),
      workspace: workspaceStub(),
      toolCallId: 'deploy-command:7:revision',
      validatedRevision: 'a'.repeat(64),
    });

    expect(mocks.terminalizeInterrupted).toHaveBeenCalledOnce();
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
