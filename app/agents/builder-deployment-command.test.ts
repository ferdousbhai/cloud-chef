import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toolFailure, toolSuccess } from 'cloudchef-agent/tool-result';
import type { BuilderWorkspaceDeploymentPlan } from './builder-workspace-api';

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
  deployForUser: vi.fn(),
  terminalizeInterrupted: vi.fn(),
}));

vi.mock('~/server-handlers/deployments', () => ({
  createOrReplayDeploymentPlanForUser: mocks.createDeployment,
  deployForUser: mocks.deployForUser,
  terminalizeInterruptedDeploymentForUser: mocks.terminalizeInterrupted,
}));

import {
  buildCheckpointForBuilder,
  deployValidatedRevisionForBuilder,
  settleDeploymentForBuilder,
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
      deployment: {
        id: '11111111-1111-5111-8111-111111111111',
        status: 'failed',
        productionUrl: null,
        error: { message: 'Deployment was interrupted.' },
      },
      settled: true,
    });
  });

  it('builds the exact checkpoint a deployment was asked for', async () => {
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
        toolCallId: 'deployment:7:validation',
      }),
    ).resolves.toEqual(requestedSnapshot);
    expect(workspace.validate).toHaveBeenCalledWith({
      toolCallId: 'deployment:7:validation',
      input: { source: 'deployment' },
    });
  });

  it('reuses the build an earlier validation of the exact revision left', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);

    await buildCheckpointForBuilder({
      workspace,
      requestedSnapshot: { workspaceRevision: 7, revision: 'a'.repeat(64) },
      toolCallId: 'deployment:7:validation',
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
        toolCallId: 'deployment:7:validation',
      }),
    ).rejects.toThrow('The build failed: Typecheck failed in src/routes/index.tsx.');
    expect(mocks.deployForUser).not.toHaveBeenCalled();
  });

  it('never builds a newer checkpoint than the one that was asked for', async () => {
    const workspace = workspaceStub();

    await expect(
      buildCheckpointForBuilder({
        workspace,
        requestedSnapshot: { workspaceRevision: 6, revision: 'b'.repeat(64) },
        toolCallId: 'deployment:6:validation',
      }),
    ).rejects.toThrow('project changed after the deployment was requested');
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

  it('reports an earlier plan it settled as succeeded over the latest plan', async () => {
    mocks.terminalizeInterrupted
      .mockReset()
      .mockResolvedValueOnce(settled('11111111-1111-5111-8111-111111111111', 'succeeded'))
      .mockResolvedValueOnce(settled('22222222-2222-5222-8222-222222222222', 'failed'))
      .mockResolvedValue(null);

    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace: workspaceStub(),
        toolCallId: 'deploy-command:7:revision',
        validatedRevision: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ id: '11111111-1111-5111-8111-111111111111', status: 'succeeded' });

    mocks.terminalizeInterrupted
      .mockReset()
      .mockResolvedValueOnce(settled('11111111-1111-5111-8111-111111111111', 'succeeded', false))
      .mockResolvedValueOnce(settled('22222222-2222-5222-8222-222222222222', 'failed'))
      .mockResolvedValue(null);
    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace: workspaceStub(),
        toolCallId: 'deploy-command:7:revision',
        validatedRevision: 'a'.repeat(64),
      }),
    ).resolves.toMatchObject({ id: '22222222-2222-5222-8222-222222222222', status: 'failed' });
  });

  it('settles one execution of one record', async () => {
    await expect(
      settleDeploymentForBuilder({
        context: operationContext(),
        deploymentId: '33333333-3333-5333-8333-333333333333',
        executionGeneration: 4,
      }),
    ).resolves.toEqual({
      settled: true,
      deployment: {
        id: '11111111-1111-5111-8111-111111111111',
        status: 'failed',
        productionUrl: null,
        error: 'Deployment was interrupted.',
      },
    });
    expect(mocks.terminalizeInterrupted).toHaveBeenCalledExactlyOnceWith({
      env: expect.anything(),
      userId: 'user-1',
      deploymentId: '33333333-3333-5333-8333-333333333333',
      executionGeneration: 4,
    });
  });

  it('answers a record it found succeeded, or found gone, as not settled by it', async () => {
    const settleIt = () =>
      settleDeploymentForBuilder({
        context: operationContext(),
        deploymentId: '33333333-3333-5333-8333-333333333333',
        executionGeneration: 4,
      });
    mocks.terminalizeInterrupted.mockResolvedValueOnce(
      settled('33333333-3333-5333-8333-333333333333', 'succeeded', false),
    );
    await expect(settleIt()).resolves.toMatchObject({ settled: false, deployment: { status: 'succeeded' } });
    mocks.terminalizeInterrupted.mockResolvedValueOnce(null);
    await expect(settleIt()).resolves.toMatchObject({ settled: false, deployment: { status: 'failed' } });
  });

  it.each([
    ['approved', 'ready'],
    ['provisioning', 'deploying'],
    ['deploying', 'deploying'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
  ])('reports a %s deployment as %s, so only a claimed one is waited for', async (status, reported) => {
    mocks.terminalizeInterrupted
      .mockReset()
      .mockResolvedValueOnce(settled('11111111-1111-5111-8111-111111111111', status))
      .mockResolvedValue(null);
    const revision = 'a'.repeat(64);

    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace: workspaceStub(),
        toolCallId: `deploy-command:7:${revision}`,
        validatedRevision: revision,
      }),
    ).resolves.toMatchObject({ status: reported });
  });

  it('terminalizes every plan of the revision, and reports the latest, the one that ran', async () => {
    mocks.terminalizeInterrupted
      .mockReset()
      .mockResolvedValueOnce(settled('11111111-1111-5111-8111-111111111111'))
      .mockResolvedValueOnce(settled('22222222-2222-5222-8222-222222222222'))
      .mockResolvedValue(null);
    const revision = 'a'.repeat(64);

    await expect(
      terminalizeInterruptedDeploymentForBuilder({
        context: operationContext(),
        workspace: workspaceStub(),
        toolCallId: `deploy-command:7:${revision}`,
        validatedRevision: revision,
      }),
    ).resolves.toMatchObject({ id: '22222222-2222-5222-8222-222222222222' });

    // Both plans, and the next one it never made.
    const terminalized = mocks.terminalizeInterrupted.mock.calls.map(([input]) => input.deploymentId);
    expect(terminalized).toHaveLength(3);
    expect(new Set(terminalized).size).toBe(3);
  });

  it('plans a revision again under its next id when the plan stored under one would no longer be its plan', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    const revision = 'a'.repeat(64);
    const publish = () =>
      deployValidatedRevisionForBuilder({
        context: operationContext(),
        workspace,
        toolCallId: `deploy-command:7:${revision}`,
        validatedRevision: revision,
      });
    // The first id holds a plan made before the project's resources were named as they are now.
    mocks.createDeployment.mockResolvedValueOnce(null);

    await publish();

    const [stale, replanned] = mocks.createDeployment.mock.calls.map(([input]) => input.deploymentId);
    expect(replanned).toMatch(/^[0-9a-f-]{36}$/);
    expect(replanned).not.toBe(stale);
    expect(mocks.deployForUser).toHaveBeenCalledOnce();
    expect(mocks.deployForUser).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: replanned }));

    // The ids are the revision's own, so the next publication and recovery find the same ones.
    vi.clearAllMocks();
    mocks.createDeployment.mockResolvedValueOnce(null).mockResolvedValue({ id: replanned, status: 'approved' });
    await publish();
    expect(mocks.createDeployment.mock.calls.map(([input]) => input.deploymentId)).toEqual([stale, replanned]);
    mocks.terminalizeInterrupted.mockResolvedValueOnce(settled(stale)).mockResolvedValueOnce(settled(replanned));
    mocks.terminalizeInterrupted.mockResolvedValue(null);
    await terminalizeInterruptedDeploymentForBuilder({
      context: operationContext(),
      workspace,
      toolCallId: `deploy-command:7:${revision}`,
      validatedRevision: revision,
    });
    expect(mocks.terminalizeInterrupted.mock.calls.map(([input]) => input.deploymentId).slice(0, 2)).toEqual([
      stale,
      replanned,
    ]);
  });

  it('tells its caller the execution it runs, so the caller can settle exactly it should it throw', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    const onExecution = vi.fn();

    await deployValidatedRevisionForBuilder({
      context: operationContext(),
      workspace,
      toolCallId: 'deploy-command:7:revision',
      validatedRevision: 'a'.repeat(64),
      onExecution,
    });

    expect(mocks.deployForUser).toHaveBeenCalledWith(expect.objectContaining({ onExecution }));
  });

  it('gives up on a revision planned again and again', async () => {
    const workspace = workspaceStub();
    workspace.hasSuccessfulValidation.mockResolvedValue(true);
    mocks.createDeployment.mockResolvedValue(null);

    await expect(
      deployValidatedRevisionForBuilder({
        context: operationContext(),
        workspace,
        toolCallId: 'deploy-command:7:revision',
        validatedRevision: 'a'.repeat(64),
      }),
    ).rejects.toThrow('Deployment of this revision was planned too many times');
    expect(mocks.createDeployment).toHaveBeenCalledTimes(8);
    expect(mocks.deployForUser).not.toHaveBeenCalled();
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

/** A record as recovery left it: settled by that call unless `settledHere` says otherwise. */
function settled(id: string, status = 'failed', settledHere = true) {
  return {
    deployment: { id, status, productionUrl: null, error: { message: 'Deployment was interrupted.' } },
    settled: settledHere,
  };
}

function operationContext() {
  return { env: {} as Env, userId: 'user-1', chatInitialId: 'chat-1' };
}
