import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomaticDeploymentRetry } from '~/agents/builder-publication-retry';
import type { BuilderWorkspaceCheckpoint } from '~/agents/builder-workspace-api';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import {
  AGENT_NAME,
  builderAgentHarness,
  CHAT_INITIAL_ID,
  eventually,
  settle,
  type BuilderAgentHarness,
  type BuilderPublisher,
} from './harness';

/**
 * A CloudChef app publishes itself when a turn that changed it ends: the hosted preview, then
 * production. These follow that publication through what can cut it short — the person's next
 * message, a failure that passes, a restart — with the real agent and its publication commands faked
 * at their boundary.
 */
const CHECKPOINT: BuilderWorkspaceCheckpoint = { workspaceRevision: 3, revision: 'a'.repeat(64) };
const NEXT_CHECKPOINT: BuilderWorkspaceCheckpoint = { workspaceRevision: 4, revision: 'b'.repeat(64) };

type DeployRequest = Parameters<BuilderPublisher['deploy']>[0];
type PreviewRequest = Parameters<BuilderPublisher['preview']>[0];

/** A publication that runs until it is stopped, then rejects as the executor does: with its signal's reason. */
function untilStopped(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function publicationHarness(
  options: { publisher?: Partial<BuilderPublisher>; checkpoint?: () => BuilderWorkspaceCheckpoint } = {},
) {
  const checkpoint = options.checkpoint ?? (() => CHECKPOINT);
  const deleteProject = vi.fn(async () => undefined);
  const harness = await builderAgentHarness({
    cloudflareIdentity: true,
    ai: {
      models: vi.fn(async () => {
        throw new Error('catalog unavailable');
      }),
    },
    workspace: { checkpoint: async () => checkpoint(), deleteProject },
    publisher: options.publisher,
  });
  return { ...harness, deleteProject };
}

/** The turn that changed the app ends, as a turn whose tools wrote to the project does. */
async function finishChangingTurn(harness: BuilderAgentHarness, status: 'completed' | 'aborted' = 'completed') {
  harness.beginTurn();
  harness.agent.setState({ ...harness.agent.state, publicationPending: true });
  await harness.endTurn(status);
}

/** The person sends their next message. The turn stops at its first model-access check, after it took the workspace. */
async function sendNextMessage(harness: BuilderAgentHarness) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unavailable', { status: 503 }));
  await Promise.resolve(
    harness.agent.onChatMessage(undefined, {
      requestId: 'request-2',
      body: {
        chatInitialId: CHAT_INITIAL_ID,
        subchatIndex: 0,
        transcript: { agentName: AGENT_NAME, generation: 0, subchatIndex: 0 },
        modelId: CLOUDFLARE_WORKERS_AI_MODEL,
      },
    }),
  ).catch(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BuilderAgent automatic publication', () => {
  it('publishes the preview and then production when a turn that changed the app ends', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({ publisher: { deploy } });

    await finishChangingTurn(harness);

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
    expect(deploy.mock.calls[0]?.[0]).toMatchObject({ validatedRevision: CHECKPOINT.revision });
    expect(harness.agent.state.preview).toMatchObject({ status: 'ready' });
    expect(harness.agent.state.publicationPending).toBe(false);
  });

  it('publishes the changes of a turn that was stopped or failed', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({ publisher: { deploy } });

    await finishChangingTurn(harness, 'aborted');

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
  });

  it("stops the last turn's preview when the person writes again, and never deploys from it", async () => {
    const previews: PreviewRequest[] = [];
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({
      publisher: {
        preview: async (request) => {
          previews.push(request);
          return untilStopped(request.abortSignal);
        },
        deploy,
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => previews.length === 1);

    await sendNextMessage(harness);

    expect(previews[0]?.abortSignal?.aborted).toBe(true);
    await settle();
    expect(deploy).not.toHaveBeenCalled();
    expect(harness.agent.state.preview).toMatchObject({ status: 'cancelled', pendingId: null });
    // Production still has to catch up: the next turn's end publishes.
    expect(harness.agent.state.publicationPending).toBe(true);
  });

  it("stops the last turn's deployment before it changes production, and the next turn's end deploys again", async () => {
    const deployments: DeployRequest[] = [];
    let stopFirst = true;
    const harness = await publicationHarness({
      publisher: {
        deploy: async (request) => {
          deployments.push(request);
          if (stopFirst) {
            stopFirst = false;
            return untilStopped(request.abortSignal);
          }
          return { status: 'succeeded', id: 'deployment-1' };
        },
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => deployments.length === 1);

    await sendNextMessage(harness);

    expect(deployments[0]?.abortSignal?.aborted).toBe(true);
    await eventually(() => harness.agent.state.deployment === null);
    expect(harness.agent.state.productionRevision).toBeNull();
    expect(harness.agent.state.publicationPending).toBe(true);

    // The next turn changed nothing, yet production catches up with the turn before it.
    harness.beginTurn();
    await harness.endTurn();
    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deployments).toHaveLength(2);
  });

  it('does not deploy while a turn is running; the turn publishes when it ends', async () => {
    const preview = deferred<void>();
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({
      publisher: {
        preview: async (request) => {
          await preview.promise;
          return {
            id: 'version-1',
            url: 'https://preview.example.workers.dev',
            workspaceRevision: 3,
            snapshotRevision: request.validatedRevision,
            readyAt: '2026-10-21T00:00:00.000Z',
          };
        },
        deploy,
      },
    });
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });
    // A manual "Build preview" while the work of an unpublished turn waits for production.
    await harness.agent.requestPreview();
    harness.beginTurn();

    preview.resolve();
    await eventually(() => harness.agent.state.preview?.status === 'ready');
    await settle();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('deploys behind a manual preview of the revision a turn asked to publish', async () => {
    const preview = deferred<void>();
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({
      publisher: {
        preview: async (request) => {
          await preview.promise;
          return {
            id: 'version-1',
            url: 'https://preview.example.workers.dev',
            workspaceRevision: 3,
            snapshotRevision: request.validatedRevision,
            readyAt: '2026-10-21T00:00:00.000Z',
          };
        },
        deploy,
      },
    });
    await harness.agent.requestPreview();
    // The turn ends while the manual preview of the same revision is still publishing: the turn's
    // publication rides on it instead of starting a second one.
    await finishChangingTurn(harness);

    preview.resolve();
    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it('a manual preview with nothing waiting for production never deploys', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({ publisher: { deploy } });

    await harness.agent.requestPreview();

    await eventually(() => harness.agent.state.preview?.status === 'ready');
    await settle();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('retries an automatic deployment that failed for a reason that passes', async () => {
    let attempts = 0;
    const harness = await publicationHarness({
      publisher: {
        deploy: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('Finish the active deployment before starting another one.');
          }
          return { status: 'succeeded', id: 'deployment-1' };
        },
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => harness.agent.state.deployment?.status === 'failed');

    const [retry] = harness.agent
      .getSchedules<AutomaticDeploymentRetry>()
      .filter((schedule) => schedule.callback === 'retryAutomaticDeployment');
    expect(retry?.payload).toEqual({ ...CHECKPOINT, attempt: 1 });
    if (retry) {
      await harness.agent.retryAutomaticDeployment(retry.payload);
    }

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(attempts).toBe(2);
  });

  it('leaves a deployment whose build failed for the next turn instead of retrying it', async () => {
    const harness = await publicationHarness({
      publisher: {
        deploy: async () => {
          throw new Error('The build failed: typecheck reported 2 errors.');
        },
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => harness.agent.state.deployment?.status === 'failed');

    expect(harness.agent.getSchedules().filter((schedule) => schedule.callback === 'retryAutomaticDeployment')).toEqual(
      [],
    );
  });

  it('a retry for a revision the project has moved past does nothing', async () => {
    let current = CHECKPOINT;
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({ publisher: { deploy }, checkpoint: () => current });
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });
    current = NEXT_CHECKPOINT;

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });

    await settle();
    expect(deploy).not.toHaveBeenCalled();
    expect(harness.agent.state.deployment).toBeNull();
  });

  it('a restarted agent resumes the publication a turn asked for', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({ publisher: { deploy } });
    // The turn ended and recorded that production must catch up, then the agent stopped before
    // any publication fiber started.
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });

    await harness.agent.onStart();

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it('a preview recovered after it published, but before production was scheduled behind it, deploys', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({ publisher: { deploy } });
    // The preview recorded itself ready, then the agent stopped before the deployment fiber started.
    harness.agent.setState({
      ...harness.agent.state,
      publicationPending: true,
      preview: {
        status: 'ready',
        pendingId: null,
        workspaceRevision: 3,
        stale: false,
        error: null,
        published: {
          id: 'version-1',
          url: 'https://preview.example.workers.dev',
          workspaceRevision: 3,
          snapshotRevision: CHECKPOINT.revision,
          readyAt: '2026-10-21T00:00:00.000Z',
        },
      },
    });

    await harness.agent.onFiberRecovered({
      id: 'fiber-1',
      name: 'background:builder_preview',
      metadata: {
        previewId: 'preview-1',
        workspaceRevision: 3,
        snapshotRevision: CHECKPOINT.revision,
        requestedAt: 1,
        autoDeploy: true,
      },
      snapshot: null,
      createdAt: 1,
      recoveryReason: 'interrupted',
    });

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it('records production as caught up only while it serves the current revision', async () => {
    let current = CHECKPOINT;
    const harness = await publicationHarness({
      checkpoint: () => current,
      publisher: {
        deploy: async () => {
          // The project changed again while this revision deployed.
          current = NEXT_CHECKPOINT;
          return { status: 'succeeded', id: 'deployment-1' };
        },
      },
    });

    await finishChangingTurn(harness);

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(harness.agent.state.publicationPending).toBe(true);
  });

  it('project deletion stops its publications', async () => {
    const deployments: DeployRequest[] = [];
    const harness = await publicationHarness({
      publisher: {
        deploy: async (request) => {
          deployments.push(request);
          return untilStopped(request.abortSignal);
        },
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => deployments.length === 1);

    await harness.agent.scheduleDestroyForGc('owner-1').catch(() => undefined);

    expect(deployments[0]?.abortSignal?.aborted).toBe(true);
    expect(harness.deleteProject).toHaveBeenCalledOnce();
    const live = await harness.agent.listFibers({ status: ['pending', 'running', 'interrupted'] });
    expect(live.filter((fiber) => fiber.name === 'background:builder_deployment')).toEqual([]);
  });
});
