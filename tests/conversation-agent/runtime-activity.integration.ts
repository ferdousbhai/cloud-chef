import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import {
  AGENT_NAME,
  conversationAgentHarness,
  eventually,
  RUNTIME_VERSION,
  settle,
  VALIDATED_CHECKPOINT,
  type ConversationAgentHarness,
  type BuilderPublisher,
} from './harness';

/**
 * Every kind of work a redeploy would cut off records the agent busy first, then waits out an open upgrade
 * window before it starts: that upgrade found the runtime idle and is redeploying its Worker and rolling
 * out its container, so the work starts once the new runtime serves instead of being cut off.
 */
function expectHeldByUpgradeWindow(harness: ConversationAgentHarness) {
  expect(harness.activity()).toEqual([{ agent_name: AGENT_NAME, busy: 1 }]);
}

beforeEach(() => {
  // The Workers global a publication's progress follower waits on between reads.
  vi.stubGlobal('scheduler', { wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ConversationAgent runtime activity', () => {
  it('records the agent busy while its turn runs, and idle once it ends', async () => {
    const harness = await conversationAgentHarness();
    const { agent } = harness;

    agent.setState({ ...agent.state, activeTurn: { id: 'turn-1', requestId: 'request-1', status: 'accepted' } });
    await eventually(() => harness.activity()[0]?.busy === 1);

    agent.setState({ ...agent.state, activeTurn: null });
    await eventually(() => harness.activity()[0]?.busy === 0);
  });

  it('a window for the version already running holds work back too, until the upgrade releases it', async () => {
    // Deployed, with its container applications still being replaced: work started now would lose its container.
    const harness = await conversationAgentHarness();
    harness.openUpgradeWindow(RUNTIME_VERSION);

    const deployment = harness.agent.deployValidatedRevision();
    await settle();
    expect(harness.agent.state.deployment).toBeNull();

    harness.closeUpgradeWindow();
    await expect(deployment).resolves.toMatchObject({ status: 'deploying' });
  });

  it('a production deployment stays busy while it runs, though an editor save clears its record', async () => {
    const plan = deferred<Awaited<ReturnType<BuilderPublisher['deploy']>>>();
    const harness = await conversationAgentHarness({
      workspace: {
        applyClientChanges: async () => ({ ok: true, state: READY_STATE, changedPaths: ['src/app.tsx'] }),
      },
      publisher: { deploy: () => plan.promise },
    });

    await harness.agent.deployValidatedRevision();
    await eventually(() => harness.activity()[0]?.busy === 1);
    await harness.agent.applyWorkspaceClientChanges({ baseRevision: 3, changes: [] });
    expect(harness.agent.state.deployment).toBeNull();
    await settle();
    expect(harness.activity()).toEqual([{ agent_name: AGENT_NAME, busy: 1 }]);

    plan.reject(new Error('The deployment could not be planned.'));
    await eventually(() => harness.activity()[0]?.busy === 0);
  });

  it('seeding a new workspace is busy, and waits out an upgrade window before it starts', async () => {
    const seed = deferred<{ status: 'initialized'; state: typeof READY_STATE }>();
    const beginSeed = vi.fn(() => seed.promise);
    let seeded = true;
    const harness = await conversationAgentHarness({
      workspace: { refresh: async () => (seeded ? READY_STATE : { ...READY_STATE, initialized: false }), beginSeed },
    });
    // The project was reset since the agent started: the next preparation seeds it again.
    seeded = false;
    harness.openUpgradeWindow();

    const prepared = harness.agent.prepareWorkspace();
    await settle();
    expectHeldByUpgradeWindow(harness);
    expect(beginSeed).not.toHaveBeenCalled();

    harness.closeUpgradeWindow();
    await eventually(() => beginSeed.mock.calls.length > 0);
    await settle();
    expect(harness.activity()).toEqual([{ agent_name: AGENT_NAME, busy: 1 }]);

    seeded = true;
    seed.resolve({ status: 'initialized', state: READY_STATE });
    await prepared;
    await eventually(() => harness.activity()[0]?.busy === 0);
  });

  it('a production deployment waits out an upgrade window before it starts', async () => {
    const harness = await conversationAgentHarness();
    harness.openUpgradeWindow();

    const deployment = harness.agent.deployValidatedRevision();
    await settle();
    expectHeldByUpgradeWindow(harness);
    expect(harness.agent.state.deployment).toBeNull();

    harness.closeUpgradeWindow();
    await expect(deployment).resolves.toMatchObject({ status: 'deploying', ...VALIDATED_CHECKPOINT });
  });

  it('an approved Cloudflare request waits out an upgrade window before it runs', async () => {
    const harness = await conversationAgentHarness({ cloudflareIdentity: true });
    const proposal = await harness.proposeCloudflareRequest();
    harness.openUpgradeWindow();

    const approval = harness.agent.approveCloudflareExecution({ executionId: proposal.executionId });
    await settle();
    expectHeldByUpgradeWindow(harness);
    expect(harness.cloudflareExecution(proposal.executionId)?.status).toBe('awaiting_approval');

    harness.closeUpgradeWindow();
    await approval.catch(() => undefined);
    expect(harness.cloudflareExecution(proposal.executionId)?.status).not.toBe('awaiting_approval');
  });

  it('a chat turn is recorded busy and waits out an upgrade window before any model work', async () => {
    const asked: string[] = [];
    // Before admission a turn asks which models the account allows; the first thing it does after
    // admission is ask the control plane for model access.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return new Response('unavailable', { status: 503 });
    });
    const models = vi.fn(async () => {
      throw new Error('catalog unavailable');
    });
    const harness = await conversationAgentHarness({ cloudflareIdentity: true, ai: { models } });
    harness.openUpgradeWindow();

    const turn = harness.agent.sendMessage({
      text: 'Build it',
      requestId: 'request-1',
      transcript: { agentName: AGENT_NAME, subchatIndex: 0 },
      modelId: CLOUDFLARE_WORKERS_AI_MODEL,
    });
    await settle();
    expectHeldByUpgradeWindow(harness);
    expect(harness.agent.state.activeTurn).toMatchObject({ status: 'accepted' });
    // The browser shows that the workspace is upgrading.
    expect(harness.agent.state.upgradeWaiting).toBe(true);
    // Only the check of which models the account allows, made before the turn is admitted.
    expect(asked).toEqual([`${CONTROL_PLANE}/api/cloudflare/runtime-models`]);

    harness.closeUpgradeWindow();
    await eventually(() => asked.length > 1);
    expect(asked[1]).toContain('/api/cloudflare/runtime-access');
    expect(harness.agent.state.upgradeWaiting).toBe(false);
    await Promise.resolve(turn).catch(() => undefined);
  });

  it('a Stop calls off a chat turn still waiting out an upgrade window', async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return new Response('unavailable', { status: 503 });
    });
    const models = vi.fn(async () => {
      throw new Error('catalog unavailable');
    });
    const harness = await conversationAgentHarness({ cloudflareIdentity: true, ai: { models } });
    harness.openUpgradeWindow();

    const turn = harness.agent.sendMessage({
      text: 'Build it',
      requestId: 'request-1',
      transcript: { agentName: AGENT_NAME, subchatIndex: 0 },
      modelId: CLOUDFLARE_WORKERS_AI_MODEL,
    });
    await eventually(() => harness.agent.state.upgradeWaiting === true);
    await harness.agent.cancelActiveTurn();

    await expect(turn).rejects.toThrow('Cancelled by the project owner');
    expect(harness.agent.state.activeTurn).toBeNull();
    expect(harness.agent.state.upgradeWaiting).toBe(false);
    // Nothing past the check of which models the account allows.
    expect(asked).toEqual([`${CONTROL_PLANE}/api/cloudflare/runtime-models`]);
  });
});

const CONTROL_PLANE = 'https://control-plane.test';

const READY_STATE = {
  initialized: true,
  revision: 3,
  resetRevision: 0,
  fileCount: 1,
  totalBytes: 10,
  seeding: false,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((settleResolve, settleReject) => {
    resolve = settleResolve;
    reject = settleReject;
  });
  return { promise, resolve, reject };
}
