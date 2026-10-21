import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomaticDeploymentRetry } from '~/agents/builder-publication-retry';
import type { BuilderWorkspaceApi, BuilderWorkspaceCheckpoint } from '~/agents/builder-workspace-api';
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
  options: {
    publisher?: Partial<BuilderPublisher>;
    checkpoint?: () => BuilderWorkspaceCheckpoint | Promise<BuilderWorkspaceCheckpoint>;
    refresh?: BuilderWorkspaceApi['refresh'];
  } = {},
) {
  const checkpoint = options.checkpoint ?? (() => CHECKPOINT);
  const deleteProject = vi.fn(async () => undefined);
  const workspace: Partial<BuilderWorkspaceApi> = { checkpoint: async () => checkpoint(), deleteProject };
  if (options.refresh) {
    workspace.refresh = options.refresh;
  }
  const harness = await builderAgentHarness({
    cloudflareIdentity: true,
    ai: {
      models: vi.fn(async () => {
        throw new Error('catalog unavailable');
      }),
    },
    workspace,
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

/** The person sends their next message: its turn takes the workspace and stays running. */
async function sendNextMessage(
  harness: BuilderAgentHarness,
  options: { abortSignal?: AbortSignal; turnContext?: object } = {},
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unavailable', { status: 503 }));
  await Promise.resolve(
    harness.agent.onChatMessage(undefined, {
      requestId: 'request-2',
      abortSignal: options.abortSignal,
      body: {
        chatInitialId: CHAT_INITIAL_ID,
        subchatIndex: 0,
        transcript: { agentName: AGENT_NAME, generation: 0, subchatIndex: 0 },
        modelId: CLOUDFLARE_WORKERS_AI_MODEL,
        turnContext: options.turnContext,
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

  it('an agent last deployed before production was recorded counts its succeeded deployment as production', async () => {
    const preview = vi.fn<BuilderPublisher['preview']>();
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({ publisher: { preview, deploy } });
    // Its state predates `productionRevision`: only the deployment record says production serves it.
    const { productionRevision: _, ...legacy } = harness.agent.state;
    harness.agent.setState({ ...legacy, deployment: { status: 'succeeded', id: 'deployment-1', ...CHECKPOINT } });

    await finishChangingTurn(harness);

    await settle();
    expect(preview).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(harness.agent.state.publicationPending).toBe(false);
  });

  it('a scheduled retry of a revision production already serves records the publication done', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({ publisher: { deploy } });
    const { productionRevision: _, ...legacy } = harness.agent.state;
    harness.agent.setState({
      ...legacy,
      publicationPending: true,
      deployment: { status: 'succeeded', id: 'deployment-1', ...CHECKPOINT },
    });

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });

    await settle();
    expect(deploy).not.toHaveBeenCalled();
    expect(harness.agent.state.publicationPending).toBe(false);
    expect(harness.agent.state.productionRevision).toBe(CHECKPOINT.revision);
  });

  it("an editor change's manual preview is not promoted after a turn ended at the revision already deployed", async () => {
    let current = CHECKPOINT;
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({ publisher: { deploy }, checkpoint: () => current });
    const { productionRevision: _, ...legacy } = harness.agent.state;
    harness.agent.setState({ ...legacy, deployment: { status: 'succeeded', id: 'deployment-1', ...CHECKPOINT } });
    await finishChangingTurn(harness);
    await settle();
    // The person edits a file in the editor, which clears the deployment record, and builds a preview.
    current = NEXT_CHECKPOINT;
    harness.agent.setState({ ...harness.agent.state, deployment: null });

    await harness.agent.requestPreview();

    await eventually(() => harness.agent.state.preview?.status === 'ready');
    await settle();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('a project being deleted refuses a preview', async () => {
    const preview = vi.fn<BuilderPublisher['preview']>();
    const harness = await publicationHarness({ publisher: { preview } });
    await harness.agent.scheduleDestroyForGc('owner-1').catch(() => undefined);

    await expect(harness.agent.requestPreview()).rejects.toMatchObject({ status: 409 });
    await settle();
    expect(preview).not.toHaveBeenCalled();
  });
});

/** The preview of `CHECKPOINT` already serves, so a publication of it goes straight to production. */
function previewServing(harness: BuilderAgentHarness) {
  harness.agent.setState({
    ...harness.agent.state,
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
}

describe("a new turn's stop reaches every automatic publication", () => {
  it('a preview still waiting out an upgrade window when the person writes again never starts', async () => {
    const preview = vi.fn<BuilderPublisher['preview']>();
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const harness = await publicationHarness({ publisher: { preview, deploy } });
    harness.openUpgradeWindow();

    harness.beginTurn();
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });
    const ended = harness.endTurn();
    await settle();
    const next = sendNextMessage(harness);
    await settle();
    harness.closeUpgradeWindow();
    await Promise.all([ended, next]);

    await settle();
    expect(preview).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    // Never even queued: the browser never shows a preview starting.
    expect(harness.agent.state.preview).toMatchObject({ status: 'idle', pendingId: null });
    expect(harness.agent.state.publicationPending).toBe(true);
  });

  it('a deployment still waiting out an upgrade window when the person writes again never starts', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const harness = await publicationHarness({ publisher: { deploy } });
    previewServing(harness);
    harness.openUpgradeWindow();

    harness.beginTurn();
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });
    const ended = harness.endTurn();
    await settle();
    const next = sendNextMessage(harness);
    await settle();
    harness.closeUpgradeWindow();
    await Promise.all([ended, next]);

    await settle();
    expect(deploy).not.toHaveBeenCalled();
    // Never even recorded as deploying: the browser never shows a deployment starting.
    expect(harness.agent.state.deployment).toMatchObject({ status: 'ready', revision: CHECKPOINT.revision });
  });

  it("a deployment fiber held by an upgrade window is stopped by the person's next message", async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const harness = await publicationHarness({ publisher: { deploy } });
    previewServing(harness);
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });
    // An upgrade claims its window the moment the agent's admission check has gone idle again, so the
    // deployment fiber that check let through waits for it.
    harness.database.exec(`
      CREATE TRIGGER claim_window AFTER UPDATE OF busy ON runtime_activity WHEN OLD.busy = 1 AND NEW.busy = 0
      BEGIN
        INSERT OR REPLACE INTO runtime_upgrade_window (id, target_version, expires_at)
          VALUES (1, 'runtime-next', ${Date.now() + 60_000});
      END;
    `);

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });
    await eventually(() => harness.agent.state.deployment?.status === 'deploying');
    harness.database.exec('DROP TRIGGER claim_window');
    await settle();
    expect(deploy).not.toHaveBeenCalled();

    const next = sendNextMessage(harness);
    await settle();
    harness.closeUpgradeWindow();
    await next;

    await eventually(() => harness.agent.state.deployment === null);
    expect(deploy).not.toHaveBeenCalled();
  });

  it('a restarted agent does not resume a publication while the chat request that woke it starts a turn', async () => {
    const preview = vi.fn<BuilderPublisher['preview']>();
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    let reads = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await publicationHarness({
      publisher: { preview, deploy },
      checkpoint: async () => {
        reads += 1;
        // The resumed publication's own read of the revision to publish, after it found no turn running.
        if (reads === 2) {
          await held;
        }
        return CHECKPOINT;
      },
    });
    harness.agent.setState({ ...harness.agent.state, publicationPending: true });
    reads = 0;

    // The request wakes the agent: its start resumes the publication while the request is handled.
    await harness.agent.onStart();
    await eventually(() => reads === 2);
    await sendNextMessage(harness);
    expect(harness.agent.state.activeTurn).not.toBeNull();
    release();

    await settle();
    expect(preview).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
    expect(harness.agent.state.preview?.pendingId).toBeNull();
  });
});

describe('a publication that failed', () => {
  it("is redone at the next turn's end, after its record in the user's account is settled", async () => {
    let attempts = 0;
    const terminalize = vi.fn<BuilderPublisher['terminalize']>(async () => ({ status: 'failed', error: 'failed' }));
    const harness = await publicationHarness({
      publisher: {
        terminalize,
        deploy: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('The build failed: typecheck reported 2 errors.');
          }
          return { status: 'succeeded', id: 'deployment-2' };
        },
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => harness.agent.state.deployment?.status === 'failed');

    // The next turn changed nothing (say it fixed an outside setting): the same revision publishes again.
    harness.beginTurn();
    await harness.endTurn();

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(attempts).toBe(2);
    expect(terminalize).toHaveBeenCalledOnce();
    expect(harness.agent.state.publicationPending).toBe(false);
  });

  it('is not built again each time the agent wakes, only at the next turn end', async () => {
    const preview = vi.fn<BuilderPublisher['preview']>(async () => {
      throw new Error('The preview build failed: typecheck reported 2 errors.');
    });
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => {
      throw new Error('The build failed: typecheck reported 2 errors.');
    });
    const harness = await publicationHarness({ publisher: { preview, deploy } });
    await finishChangingTurn(harness);
    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    expect(harness.agent.state.failedPublicationRevision).toBe(CHECKPOINT.revision);

    // A transcript reload, a successor's settle, any RPC: each wakes the agent.
    await harness.agent.onStart();
    await harness.agent.onStart();
    await settle();
    expect(preview).toHaveBeenCalledOnce();
    expect(deploy).toHaveBeenCalledOnce();
    expect(harness.agent.state.publicationPending).toBe(true);

    harness.beginTurn();
    await harness.endTurn();
    await eventually(() => deploy.mock.calls.length === 2);
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('a wake still publishes a revision that changed since the one that failed', async () => {
    let current = CHECKPOINT;
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({ publisher: { deploy }, checkpoint: () => current });
    harness.agent.setState({
      ...harness.agent.state,
      publicationPending: true,
      failedPublicationRevision: CHECKPOINT.revision,
    });
    current = NEXT_CHECKPOINT;

    await harness.agent.onStart();

    await eventually(() => harness.agent.state.productionRevision === NEXT_CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it("an interrupted deployment that finished in the user's account is recorded as production", async () => {
    const harness = await publicationHarness({
      publisher: {
        terminalize: async () => ({ status: 'succeeded', id: 'deployment-1', productionUrl: 'https://app.example' }),
      },
    });
    harness.agent.setState({
      ...harness.agent.state,
      publicationPending: true,
      deployment: { status: 'deploying', ...CHECKPOINT },
    });

    await expect(
      harness.agent.onFiberRecovered({
        id: 'fiber-1',
        name: 'background:builder_deployment',
        metadata: { ...CHECKPOINT, automatic: true, attempt: 0 },
        snapshot: null,
        createdAt: 1,
        recoveryReason: 'interrupted',
      }),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(harness.agent.state.deployment).toMatchObject({ status: 'succeeded', revision: CHECKPOINT.revision });
    expect(harness.agent.state.productionRevision).toBe(CHECKPOINT.revision);
    expect(harness.agent.state.publicationPending).toBe(false);
  });
});

describe('a turn that ends without its end-of-turn hook', () => {
  /** The last turn's deployment runs until a new turn stops it; every later one succeeds. */
  function stoppableDeployments() {
    const deployments: DeployRequest[] = [];
    const deploy = async (request: DeployRequest) => {
      deployments.push(request);
      if (deployments.length === 1) {
        return untilStopped(request.abortSignal);
      }
      return { status: 'succeeded' as const, id: 'deployment-2' };
    };
    return { deployments, deploy };
  }

  it('a message refused for its turn context stops nothing and leaves no turn behind', async () => {
    const { deployments, deploy } = stoppableDeployments();
    const harness = await publicationHarness({ publisher: { deploy } });
    await finishChangingTurn(harness);
    await eventually(() => deployments.length === 1);

    await sendNextMessage(harness, { turnContext: { version: 99 } });

    expect(harness.agent.state.activeTurn).toBeNull();
    expect(deployments[0]?.abortSignal?.aborted).toBe(false);
    expect(harness.agent.state.deployment).toMatchObject({ status: 'deploying', revision: CHECKPOINT.revision });
  });

  it("a Stop redoes the publication the stopped turn's start called off", async () => {
    const { deployments, deploy } = stoppableDeployments();
    const harness = await publicationHarness({ publisher: { deploy } });
    await finishChangingTurn(harness);
    await eventually(() => deployments.length === 1);
    await sendNextMessage(harness);
    expect(deployments[0]?.abortSignal?.aborted).toBe(true);
    expect(harness.agent.state.activeTurn).not.toBeNull();

    await harness.agent.cancelActiveTurn();

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deployments).toHaveLength(2);
    expect(harness.agent.state.publicationPending).toBe(false);
  });

  it('a turn that failed before it streamed redoes the publication it called off', async () => {
    const { deployments, deploy } = stoppableDeployments();
    const harness = await publicationHarness({ publisher: { deploy } });
    await finishChangingTurn(harness);
    await eventually(() => deployments.length === 1);
    // The new turn waits out an upgrade, and the person stops it there.
    harness.openUpgradeWindow();
    const stop = new AbortController();
    const turn = sendNextMessage(harness, { abortSignal: stop.signal });
    await eventually(() => harness.agent.state.upgradeWaiting === true);
    expect(deployments[0]?.abortSignal?.aborted).toBe(true);

    stop.abort(new DOMException('Cancelled by the project owner', 'AbortError'));
    await turn;
    expect(harness.agent.state.activeTurn).toBeNull();
    harness.closeUpgradeWindow();

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deployments).toHaveLength(2);
  });
});

describe('redoing a failed deployment', () => {
  /** The automatic deployment of `CHECKPOINT` failed for a reason that passes, and its retry is due. */
  function failedDeployment(harness: BuilderAgentHarness) {
    previewServing(harness);
    harness.agent.setState({
      ...harness.agent.state,
      publicationPending: true,
      deployment: { status: 'failed', ...CHECKPOINT, error: 'Deployment was interrupted.' },
    });
  }

  function scheduledRetries(harness: BuilderAgentHarness) {
    return harness.agent
      .getSchedules<AutomaticDeploymentRetry>()
      .filter((schedule) => schedule.callback === 'retryAutomaticDeployment')
      .map((schedule) => schedule.payload);
  }

  it("keeps retrying when the failed deployment's record cannot be settled yet", async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const terminalize = vi.fn<BuilderPublisher['terminalize']>(async () => {
      throw new Error('Network connection lost');
    });
    const harness = await publicationHarness({ publisher: { deploy, terminalize } });
    failedDeployment(harness);

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });

    expect(scheduledRetries(harness)).toEqual([{ ...CHECKPOINT, attempt: 2 }]);
    expect(harness.agent.state.failedPublicationRevision).toBe(CHECKPOINT.revision);
    expect(deploy).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps retrying while the record says the deployment is still running', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const harness = await publicationHarness({
      publisher: { deploy, terminalize: async () => ({ status: 'deploying' }) },
    });
    failedDeployment(harness);

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });

    expect(scheduledRetries(harness)).toEqual([{ ...CHECKPOINT, attempt: 2 }]);
    await settle();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('does not start a second deployment when another started while the record was settled', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const terminalized = deferred<void>();
    const harness = await publicationHarness({
      publisher: {
        deploy,
        terminalize: async () => {
          terminalized.resolve();
          return { status: 'failed', error: 'Deployment was interrupted.' };
        },
      },
    });
    failedDeployment(harness);
    void terminalized.promise.then(() =>
      harness.agent.setState({ ...harness.agent.state, deployment: { status: 'deploying', ...CHECKPOINT } }),
    );

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });

    await settle();
    expect(deploy).not.toHaveBeenCalled();
    const live = await harness.agent.listFibers({ status: ['pending', 'running', 'interrupted'] });
    expect(live.filter((fiber) => fiber.name === 'background:builder_deployment')).toEqual([]);
  });

  it("a manual redeploy records a deployment that finished in the user's account instead of redeploying", async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const harness = await publicationHarness({
      publisher: {
        deploy,
        terminalize: async () => ({ status: 'succeeded', id: 'deployment-1', productionUrl: 'https://app.example' }),
      },
    });
    failedDeployment(harness);

    await expect(harness.agent.deployValidatedRevision()).resolves.toMatchObject({ status: 'succeeded' });

    expect(harness.agent.state.productionRevision).toBe(CHECKPOINT.revision);
    await settle();
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe('a stale automatic preview', () => {
  it('never cancels the manual preview that replaced it', async () => {
    const previews: PreviewRequest[] = [];
    let refreshes: number | null = null;
    const staleHeld = deferred<void>();
    const harness = await publicationHarness({
      publisher: {
        preview: async (request) => {
          previews.push(request);
          return untilStopped(request.abortSignal);
        },
      },
      refresh: async () => {
        if (refreshes === null) {
          return READY_WORKSPACE;
        }
        refreshes += 1;
        // The automatic preview's read of the workspace, held until the manual one runs; by then the
        // workspace has moved on.
        if (refreshes === 1) {
          await staleHeld.promise;
          return { ...READY_WORKSPACE, revision: 4 };
        }
        return READY_WORKSPACE;
      },
    });
    refreshes = 0;
    const ended = finishChangingTurn(harness);
    await eventually(() => refreshes === 1);
    // The person writes again, then builds a preview by hand while that turn runs.
    await sendNextMessage(harness);
    await harness.agent.requestPreview();
    await eventually(() => previews.length === 1);

    staleHeld.resolve();
    await ended;

    await settle();
    expect(previews[0]?.abortSignal?.aborted).toBe(false);
    expect(harness.agent.state.preview).toMatchObject({ status: 'building' });
  });
});

const READY_WORKSPACE = {
  initialized: true,
  revision: 3,
  resetRevision: 0,
  fileCount: 1,
  totalBytes: 10,
  seeding: false,
};
