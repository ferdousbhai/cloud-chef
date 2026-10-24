import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomaticDeploymentRetry } from '~/agents/builder-publication-retry';
import type { BuilderWorkspaceApi, BuilderWorkspaceCheckpoint } from '~/agents/builder-workspace-api';
import { DeploymentConcurrencyLimitError } from '~/lib/.server/cloudflare/deployment-repository';
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
 * A CloudChef app publishes itself to production when a turn that changed it ends. These follow that publication through what can cut it short — the person's next
 * message, a failure that passes, a restart — with the real agent and its publication commands faked
 * at their boundary.
 */
const CHECKPOINT: BuilderWorkspaceCheckpoint = { workspaceRevision: 3, revision: 'a'.repeat(64) };
const NEXT_CHECKPOINT: BuilderWorkspaceCheckpoint = { workspaceRevision: 4, revision: 'b'.repeat(64) };
const PROJECT_ID = 'project-1';

type DeployRequest = Parameters<BuilderPublisher['deploy']>[0];

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
    build?: Pick<BuilderWorkspaceApi, 'validate' | 'hasSuccessfulValidation'>;
  } = {},
) {
  const checkpoint = options.checkpoint ?? (() => CHECKPOINT);
  const deleteProject = vi.fn(async () => undefined);
  const workspace: Partial<BuilderWorkspaceApi> = {
    projectId: PROJECT_ID,
    checkpoint: async () => checkpoint(),
    deleteProject,
    ...options.build,
  };
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
        transcript: { agentName: AGENT_NAME, subchatIndex: 0 },
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
  it('publishes production when a turn that changed the app ends, and keeps the address it serves at', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({
      status: 'succeeded',
      id: 'deployment-1',
      productionUrl: 'https://app.example.workers.dev',
    }));
    const harness = await publicationHarness({ publisher: { deploy } });

    await finishChangingTurn(harness);

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
    expect(deploy.mock.calls[0]?.[0]).toMatchObject({ validatedRevision: CHECKPOINT.revision });
    expect(harness.agent.state.productionUrl).toBe('https://app.example.workers.dev');
    expect(harness.agent.state.publicationPending).toBe(false);
  });

  it('records a deployment that went live as production, and tells the model about a step after it that failed', async () => {
    const warning = "Production serves the new revision, but setting the Worker's schedule failed (unavailable).";
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({
      status: 'succeeded',
      id: 'deployment-1',
      productionUrl: null,
      error: warning,
    }));
    const harness = await publicationHarness({ publisher: { deploy } });

    await finishChangingTurn(harness);

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(harness.agent.state.deployment).toMatchObject({ status: 'succeeded', error: warning });
    expect(harness.agent.state.publicationPending).toBe(false);
    expect(harness.agent['publicationFailure']()).toBe(
      `the production deployment of the latest changes went live. ${warning}`,
    );
  });

  it('records a succeeded deployment and the revision production serves in one write', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({ publisher: { deploy } });
    const setState = vi.spyOn(harness.agent, 'setState');

    await finishChangingTurn(harness);

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    const written = setState.mock.calls.map(([state]) => state);
    expect(written.some((state) => state.deployment?.status === 'succeeded')).toBe(true);
    for (const state of written.filter(({ deployment }) => deployment?.status === 'succeeded')) {
      expect(state.productionRevision).toBe(CHECKPOINT.revision);
    }
  });

  it('publishes the changes of a turn that was stopped or failed', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({ publisher: { deploy } });

    await finishChangingTurn(harness, 'aborted');

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
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

  it('records a deployment that failed after a stop came too late to call it off as failed, not stopped', async () => {
    const deployments: DeployRequest[] = [];
    const harness = await publicationHarness({
      publisher: {
        deploy: async (request) => {
          deployments.push(request);
          // Past its last stopping point the deployment finishes, and here its migration fails.
          await untilStopped(request.abortSignal).catch(() => undefined);
          throw new Error('Migration 0002_add_orders.sql failed: table orders already exists');
        },
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => deployments.length === 1);

    await sendNextMessage(harness);

    expect(deployments[0]?.abortSignal?.aborted).toBe(true);
    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    expect(harness.agent.state.deployment).toMatchObject({
      revision: CHECKPOINT.revision,
      error: expect.stringContaining('Migration 0002_add_orders.sql failed'),
    });
    expect(harness.agent.state.failedPublicationRevision).toBe(CHECKPOINT.revision);
    expect(harness.agent.state.publicationPending).toBe(true);
  });

  it("stops the last turn's deployment while it still builds, however the build ends", async () => {
    const builds: AbortSignal[] = [];
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({
      publisher: { deploy },
      build: {
        hasSuccessfulValidation: async () => false,
        validate: async (request) => {
          const signal = request.abortSignal ?? new AbortController().signal;
          builds.push(signal);
          // A stopped build reports itself as a failed one, not with the stop's reason.
          await untilStopped(signal).catch(() => undefined);
          return { version: 1, ok: false, summary: 'The build was cancelled.' };
        },
      },
    });
    await finishChangingTurn(harness);
    await eventually(() => builds.length === 1);

    await sendNextMessage(harness);

    expect(builds[0]?.aborted).toBe(true);
    await eventually(() => harness.agent.state.deployment === null);
    expect(deploy).not.toHaveBeenCalled();
    expect(harness.agent.state.failedPublicationRevision).toBeNull();
    expect(harness.agent.state.publicationPending).toBe(true);
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

    harness.deleteChat();
    await harness.agent.scheduleDestroyForGc('owner-1').catch(() => undefined);

    expect(deployments[0]?.abortSignal?.aborted).toBe(true);
    expect(harness.deleteProject).toHaveBeenCalledOnce();
    const live = await harness.agent.listFibers({ status: ['pending', 'running', 'interrupted'] });
    expect(live.filter((fiber) => fiber.name === 'background:builder_deployment')).toEqual([]);
  });

  it('a scheduled retry of a revision production already serves records the publication done', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded' }));
    const harness = await publicationHarness({ publisher: { deploy } });
    harness.agent.setState({
      ...harness.agent.state,
      publicationPending: true,
      productionRevision: CHECKPOINT.revision,
      deployment: { status: 'succeeded', id: 'deployment-1', ...CHECKPOINT },
    });

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });

    await settle();
    expect(deploy).not.toHaveBeenCalled();
    expect(harness.agent.state.publicationPending).toBe(false);
    expect(harness.agent.state.productionRevision).toBe(CHECKPOINT.revision);
  });

  it('a chat revived before the GC sweep reached it keeps its project', async () => {
    const harness = await publicationHarness();

    await expect(harness.agent.scheduleDestroyForGc('owner-1')).rejects.toMatchObject({ status: 404 });
    expect(harness.deleteProject).not.toHaveBeenCalled();
    await expect(harness.agent.deployValidatedRevision()).resolves.toMatchObject({ revision: CHECKPOINT.revision });
  });

  it('a project being deleted refuses a deployment', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const harness = await publicationHarness({ publisher: { deploy } });
    harness.deleteChat();
    await harness.agent.scheduleDestroyForGc('owner-1').catch(() => undefined);

    await expect(harness.agent.deployValidatedRevision()).rejects.toBeDefined();
    await settle();
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe("a new turn's stop reaches every automatic publication", () => {
  it('a deployment still waiting out an upgrade window when the person writes again never starts', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    const harness = await publicationHarness({ publisher: { deploy } });
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
    const deploy = vi.fn<BuilderPublisher['deploy']>();
    let reads = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await publicationHarness({
      publisher: { deploy },
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
    expect(deploy).not.toHaveBeenCalled();
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
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => {
      throw new Error('The build failed: typecheck reported 2 errors.');
    });
    const harness = await publicationHarness({ publisher: { deploy } });
    await finishChangingTurn(harness);
    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    expect(harness.agent.state.failedPublicationRevision).toBe(CHECKPOINT.revision);

    // A transcript reload, a successor's settle, any RPC: each wakes the agent.
    await harness.agent.onStart();
    await harness.agent.onStart();
    await settle();
    expect(deploy).toHaveBeenCalledOnce();
    expect(harness.agent.state.publicationPending).toBe(true);

    harness.beginTurn();
    await harness.endTurn();
    await eventually(() => deploy.mock.calls.length === 2);
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

  it('runs the deployment when its record was planned and never claimed', async () => {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => ({ status: 'succeeded', id: 'deployment-1' }));
    const harness = await publicationHarness({
      publisher: { deploy, terminalize: async () => ({ id: 'deployment-1', status: 'ready' }) },
    });
    failedDeployment(harness);

    await harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 });

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
    expect(scheduledRetries(harness)).toEqual([]);
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

  it('starts one deployment when a Deploy click and a scheduled retry both settled the failed record', async () => {
    const running = deferred<void>();
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => {
      await running.promise;
      return { status: 'succeeded', id: 'deployment-1' };
    });
    // Each settles the record before either starts the deployment.
    const bothSettling = deferred<void>();
    let settling = 0;
    const harness = await publicationHarness({
      publisher: {
        deploy,
        terminalize: async () => {
          settling += 1;
          if (settling === 2) {
            bothSettling.resolve();
          }
          await bothSettling.promise;
          return { status: 'failed', error: 'Deployment was interrupted.' };
        },
      },
    });
    failedDeployment(harness);
    // Neither sees the other's fiber: each reads the fibers before the other starts one.
    const listFibers = harness.agent.listFibers.bind(harness.agent);
    vi.spyOn(harness.agent, 'listFibers').mockImplementation(async (options) => {
      const live = await listFibers(options);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return live;
    });

    await Promise.all([
      harness.agent.deployValidatedRevision(),
      harness.agent.retryAutomaticDeployment({ ...CHECKPOINT, attempt: 1 }),
    ]);

    await eventually(() => deploy.mock.calls.length > 0);
    await settle();
    const live = await harness.agent.listFibers({ status: ['pending', 'running', 'interrupted'] });
    expect(live.filter((fiber) => fiber.name === 'background:builder_deployment')).toHaveLength(1);
    running.resolve();
    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it('does not start a second deployment for a retry while a failure recorded meanwhile hides the running one', async () => {
    const running = deferred<void>();
    const deploy = vi.fn<BuilderPublisher['deploy']>(async () => {
      await running.promise;
      return { status: 'succeeded', id: 'deployment-1' };
    });
    const harness = await publicationHarness({
      publisher: { deploy, terminalize: async () => ({ status: 'failed', error: 'Deployment was interrupted.' }) },
    });
    await harness.agent.deployValidatedRevision();
    await eventually(() => deploy.mock.calls.length > 0);
    harness.agent.setState({
      ...harness.agent.state,
      deployment: { status: 'failed', ...CHECKPOINT, error: 'Deployment cannot continue from status provisioning.' },
    });

    await harness.agent.deployValidatedRevision();

    await settle();
    expect(deploy).toHaveBeenCalledOnce();
    running.resolve();
    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
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

describe('another deployment record left holding the project', () => {
  const STALE = 20 * 60_000;
  /** The record every deployment here plans, and claims once no other record holds the project. */
  const PLANNED = 'deployment-planned';
  /** The execution of `CHECKPOINT` that threw, leaving its record, and the settle scheduled for it. */
  const LEFT_EXECUTION = { deploymentId: 'deployment-left', executionGeneration: 0 };
  const LEFT = { ...CHECKPOINT, ...LEFT_EXECUTION };

  /** The record a deployment of `CHECKPOINT` left in the runtime's D1, last touched `age` ago. */
  function leftRecord(
    harness: BuilderAgentHarness,
    status: 'provisioning' | 'deploying' | 'succeeded',
    age = STALE,
    id = 'deployment-left',
    executionGeneration = 0,
  ) {
    harness.database
      .prepare(
        `INSERT INTO deployments (
           id, chat_id, user_id, connection_id, connection_generation, execution_generation, workspace_reference,
           status, plan_json, plan_digest, created_at, updated_at
         ) VALUES (?, 'chat-1', 'owner-1', 'connection-1', 1, ?, ?, ?, '{}', 'digest', 1, ?)`,
      )
      .run(
        id,
        executionGeneration,
        `workspace-runtime:${PROJECT_ID}:${CHECKPOINT.workspaceRevision}:${CHECKPOINT.revision}`,
        status,
        Date.now() - age,
      );
  }

  function recordStatus(harness: BuilderAgentHarness, id = 'deployment-left') {
    return harness.database.prepare(`SELECT status FROM deployments WHERE id = ?`).get(id)?.status;
  }

  /** Publication commands that refuse a deployment while another record holds the project, as the claim does. */
  function holdingPublisher(harness: () => BuilderAgentHarness, options: { settlesAs?: 'failed' | 'succeeded' } = {}) {
    const deploy = vi.fn<BuilderPublisher['deploy']>(async (request) => {
      request.onPlanned?.(PLANNED);
      const holding = harness()
        .database.prepare(`SELECT id FROM deployments WHERE id <> ? AND status IN ('provisioning', 'deploying')`)
        .get(PLANNED);
      if (holding) {
        throw new DeploymentConcurrencyLimitError();
      }
      return { status: 'succeeded', id: PLANNED };
    });
    // Only the execution generation it was given, as the settling write matches it.
    const settle = vi.fn<BuilderPublisher['settle']>(async (request) => {
      const status = options.settlesAs ?? 'failed';
      const { changes } = harness()
        .database.prepare(
          `UPDATE deployments SET status = ?
           WHERE id = ? AND execution_generation = ? AND status IN ('provisioning', 'deploying')`,
        )
        .run(status, request.deploymentId, request.executionGeneration);
      // A record it found settled, or a later execution holds, is answered as it is.
      const found = recordStatus(harness(), request.deploymentId) === 'succeeded' ? 'succeeded' : 'deploying';
      return {
        settled: changes > 0,
        deployment: {
          status: changes ? status : found,
          id: request.deploymentId,
          error: 'Deployment was interrupted.',
        },
      };
    });
    return { deploy, settle };
  }

  it.each(['deploying', 'provisioning'] as const)(
    'a %s record nothing runs is settled by the next deployment, which then proceeds',
    async (status) => {
      let harness!: BuilderAgentHarness;
      const publisher = holdingPublisher(() => harness);
      harness = await publicationHarness({ publisher, checkpoint: () => NEXT_CHECKPOINT });
      leftRecord(harness, status);

      await harness.agent.deployValidatedRevision();

      await eventually(() => harness.agent.state.productionRevision === NEXT_CHECKPOINT.revision);
      expect(recordStatus(harness)).toBe('failed');
      expect(publisher.settle).toHaveBeenCalledWith(expect.objectContaining({ deploymentId: 'deployment-left' }));
      expect(publisher.deploy).toHaveBeenCalledTimes(2);
    },
  );

  it("a record of the deployment's own revision, left under the id it had before, is settled by it", async () => {
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness);
    harness = await publicationHarness({ publisher });
    // Left provisioning before the release that derived ids apart; the revision has since been planned
    // under its current id, which the deployment claims.
    leftRecord(harness, 'provisioning', STALE, 'deployment-before');

    await harness.agent.deployValidatedRevision();

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(recordStatus(harness, 'deployment-before')).toBe('failed');
    expect(publisher.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deploymentId: 'deployment-before' }),
    );
    expect(publisher.deploy).toHaveBeenCalledTimes(2);
  });

  it("a promoted record of the deployment's own revision, left under the id it had before, is production", async () => {
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness, { settlesAs: 'succeeded' });
    harness = await publicationHarness({ publisher });
    leftRecord(harness, 'deploying', STALE, 'deployment-before');

    await harness.agent.deployValidatedRevision();

    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
    expect(recordStatus(harness, 'deployment-before')).toBe('succeeded');
    expect(harness.agent.state.deployment).toMatchObject({ status: 'succeeded', id: 'deployment-before' });
    // Production serves it already, so it is not deployed again.
    expect(publisher.deploy).toHaveBeenCalledOnce();
  });

  it('the record the deployment itself planned is never settled as the one holding the project', async () => {
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness);
    publisher.deploy.mockImplementation(async (request) => {
      request.onPlanned?.(PLANNED);
      throw new DeploymentConcurrencyLimitError();
    });
    harness = await publicationHarness({ publisher });
    leftRecord(harness, 'provisioning', STALE, PLANNED);

    await harness.agent.deployValidatedRevision();

    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    expect(recordStatus(harness, PLANNED)).toBe('provisioning');
    expect(publisher.settle).not.toHaveBeenCalled();
  });

  it('a record a later execution took over and succeeded is not recorded as production by the settle', async () => {
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness);
    const settleHeld = publisher.settle.getMockImplementation();
    publisher.settle.mockImplementationOnce(async (request) => {
      // Retried through the runtime's deployment route as the slot was read, and succeeded.
      harness.database
        .prepare(`UPDATE deployments SET status = 'succeeded', execution_generation = ? WHERE id = ?`)
        .run(request.executionGeneration + 1, request.deploymentId);
      return settleHeld!(request);
    });
    const deployHeld = publisher.deploy.getMockImplementation();
    publisher.deploy.mockImplementationOnce(deployHeld!).mockRejectedValueOnce(new Error('The account refused it.'));
    harness = await publicationHarness({ publisher, checkpoint: () => NEXT_CHECKPOINT });
    leftRecord(harness, 'deploying');

    await harness.agent.deployValidatedRevision();

    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    expect(publisher.deploy).toHaveBeenCalledTimes(2);
    expect(harness.agent.state.productionRevision).not.toBe(CHECKPOINT.revision);
  });

  it('a record a deployment fiber of its revision still runs is left alone', async () => {
    let current = CHECKPOINT;
    let harness!: BuilderAgentHarness;
    const running = deferred<void>();
    const publisher = holdingPublisher(() => harness);
    const deployNext = publisher.deploy.getMockImplementation();
    publisher.deploy.mockImplementation(async (request) => {
      if (request.validatedRevision !== CHECKPOINT.revision) {
        return deployNext!(request);
      }
      leftRecord(harness, 'deploying');
      await running.promise;
      return { status: 'succeeded', id: 'deployment-left' };
    });
    harness = await publicationHarness({ publisher, checkpoint: () => current });
    await harness.agent.deployValidatedRevision();
    await eventually(() => recordStatus(harness) === 'deploying');
    current = NEXT_CHECKPOINT;

    await harness.agent.deployValidatedRevision();

    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    expect(harness.agent.state.deployment).toMatchObject({ revision: NEXT_CHECKPOINT.revision });
    expect(recordStatus(harness)).toBe('deploying');
    expect(publisher.settle).not.toHaveBeenCalled();
    running.resolve();
    await settle();
  });

  it('a record that showed work recently is left alone, as one the deployment route may be running', async () => {
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness);
    harness = await publicationHarness({ publisher, checkpoint: () => NEXT_CHECKPOINT });
    leftRecord(harness, 'deploying', 60_000);

    await harness.agent.deployValidatedRevision();

    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    expect(recordStatus(harness)).toBe('deploying');
    expect(publisher.settle).not.toHaveBeenCalled();
  });

  it('a promoted deployment whose success write failed is settled as production after the project moved on', async () => {
    let current = CHECKPOINT;
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness, { settlesAs: 'succeeded' });
    publisher.deploy.mockImplementationOnce(async (request) => {
      request.onExecution?.(LEFT_EXECUTION);
      leftRecord(harness, 'deploying', 0);
      throw new Error(
        'Production serves the new revision, but recording its deployment failed (D1 unavailable). Deployment was interrupted. Retry to record it.',
      );
    });
    harness = await publicationHarness({ publisher, checkpoint: () => current });
    await harness.agent.deployValidatedRevision();
    await eventually(() => harness.agent.state.deployment?.status === 'failed');
    const settles = harness.agent
      .getSchedules<BuilderWorkspaceCheckpoint>()
      .filter((schedule) => schedule.callback === 'settleDeploymentRecord');
    expect(settles.map((schedule) => schedule.payload)).toEqual([LEFT]);
    current = NEXT_CHECKPOINT;
    await settle();

    await harness.agent.settleDeploymentRecord(LEFT);

    expect(recordStatus(harness)).toBe('succeeded');
    expect(harness.agent.state.productionRevision).toBe(CHECKPOINT.revision);
    // The project's next deployment is no longer refused.
    await harness.agent.deployValidatedRevision();
    await eventually(() => harness.agent.state.productionRevision === NEXT_CHECKPOINT.revision);
  });

  it('a scheduled settle leaves the record of a revision a deployment fiber runs again', async () => {
    let harness!: BuilderAgentHarness;
    const running = deferred<void>();
    const publisher = holdingPublisher(() => harness);
    publisher.deploy.mockImplementation(async () => {
      leftRecord(harness, 'deploying');
      await running.promise;
      return { status: 'succeeded', id: 'deployment-left' };
    });
    harness = await publicationHarness({ publisher });
    await harness.agent.deployValidatedRevision();
    await eventually(() => recordStatus(harness) === 'deploying');

    await harness.agent.settleDeploymentRecord(LEFT);

    expect(recordStatus(harness)).toBe('deploying');
    expect(publisher.settle).not.toHaveBeenCalled();
    running.resolve();
    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
  });

  it('a scheduled settle leaves a deployment of its revision that started while it waited to be admitted', async () => {
    let harness!: BuilderAgentHarness;
    const running = deferred<void>();
    const publisher = holdingPublisher(() => harness);
    publisher.deploy.mockImplementation(async () => {
      await running.promise;
      return { status: 'succeeded', id: 'deployment-left' };
    });
    harness = await publicationHarness({ publisher });
    leftRecord(harness, 'deploying');
    const activity = harness.agent['runtimeActivity'];
    const admitted = activity.run.bind(activity);
    vi.spyOn(activity, 'run').mockImplementationOnce(async (work) => {
      // Admitted only once a deployment of the revision has started.
      await harness.agent.deployValidatedRevision();
      await eventually(() => publisher.deploy.mock.calls.length === 1);
      return admitted(work);
    });

    await harness.agent.settleDeploymentRecord(LEFT);

    expect(recordStatus(harness)).toBe('deploying');
    expect(publisher.settle).not.toHaveBeenCalled();
    running.resolve();
    await eventually(() => harness.agent.state.productionRevision === CHECKPOINT.revision);
  });

  it('a scheduled settle of an execution that threw leaves the record a later execution holds', async () => {
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness);
    harness = await publicationHarness({ publisher, checkpoint: () => NEXT_CHECKPOINT });
    // The record was retried through the runtime's deployment route, outside this agent, since it threw.
    leftRecord(harness, 'deploying', 0, LEFT_EXECUTION.deploymentId, LEFT_EXECUTION.executionGeneration + 1);

    await harness.agent.settleDeploymentRecord(LEFT);

    expect(publisher.settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(LEFT_EXECUTION));
    expect(recordStatus(harness)).toBe('deploying');
  });

  it('a scheduled settle that finds a later execution succeeded leaves production as it is', async () => {
    let harness!: BuilderAgentHarness;
    const publisher = holdingPublisher(() => harness);
    harness = await publicationHarness({ publisher, checkpoint: () => NEXT_CHECKPOINT });
    // Retried since it threw, the record succeeded; then the project's next revision was deployed over it.
    leftRecord(harness, 'succeeded', 0, LEFT_EXECUTION.deploymentId, LEFT_EXECUTION.executionGeneration + 1);
    await harness.agent.deployValidatedRevision();
    await eventually(() => harness.agent.state.productionRevision === NEXT_CHECKPOINT.revision);

    await harness.agent.settleDeploymentRecord(LEFT);

    expect(publisher.settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(LEFT_EXECUTION));
    expect(harness.agent.state.productionRevision).toBe(NEXT_CHECKPOINT.revision);
  });
});
