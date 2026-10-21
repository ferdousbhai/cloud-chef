import { afterEach, describe, expect, it, vi } from 'vitest';
import { idleBuilderPreviewState } from '~/agents/builder-preview-types';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import {
  AGENT_NAME,
  builderAgentHarness,
  CHAT_INITIAL_ID,
  eventually,
  RUNTIME_VERSION,
  settle,
  VALIDATED_CHECKPOINT,
  type BuilderAgentHarness,
} from './harness';

/**
 * Every kind of work a redeploy would cut off records the agent busy first, then waits out an upgrade
 * window claimed for another Worker version before it starts: that upgrade found the runtime idle and is
 * about to redeploy it, so the work starts on the new version instead of being cut off on the old one.
 */
function expectHeldByUpgradeWindow(harness: BuilderAgentHarness) {
  expect(harness.activity()).toEqual([{ agent_name: AGENT_NAME, busy: 1 }]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BuilderAgent runtime activity', () => {
  it('records the agent busy while its state shows work, and idle once it ends', async () => {
    const harness = await builderAgentHarness();
    const { agent } = harness;

    agent.setState({ ...agent.state, activeTurn: { id: 'turn-1', requestId: 'request-1', status: 'accepted' } });
    await eventually(() => harness.activity()[0]?.busy === 1);

    agent.setState({ ...agent.state, activeTurn: null });
    await eventually(() => harness.activity()[0]?.busy === 0);

    agent.setState({ ...agent.state, preview: { ...idleBuilderPreviewState(), status: 'building' } });
    await eventually(() => harness.activity()[0]?.busy === 1);
  });

  it('a window claimed for this same version holds nothing back', async () => {
    const harness = await builderAgentHarness();
    harness.openUpgradeWindow(RUNTIME_VERSION);

    await expect(harness.agent.deployValidatedRevision()).resolves.toMatchObject({ status: 'deploying' });
  });

  it('a production deployment waits out an upgrade window before it starts', async () => {
    const harness = await builderAgentHarness();
    harness.openUpgradeWindow();

    const deployment = harness.agent.deployValidatedRevision();
    await settle();
    expectHeldByUpgradeWindow(harness);
    expect(harness.agent.state.deployment).toBeNull();

    harness.closeUpgradeWindow();
    await expect(deployment).resolves.toMatchObject({ status: 'deploying', ...VALIDATED_CHECKPOINT });
  });

  it('a preview publication waits out an upgrade window before it is queued', async () => {
    const harness = await builderAgentHarness();
    harness.openUpgradeWindow();

    const preview = harness.agent.requestPreview();
    await settle();
    expectHeldByUpgradeWindow(harness);
    expect(harness.agent.state.preview?.status).not.toBe('queued');

    harness.closeUpgradeWindow();
    await expect(preview).resolves.toMatchObject({ status: 'queued', workspaceRevision: 3 });
  });

  it('an approved Cloudflare request waits out an upgrade window before it runs', async () => {
    const harness = await builderAgentHarness({ cloudflareIdentity: true });
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
    // The first thing a turn does after admission is ask the control plane for model access.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return new Response('unavailable', { status: 503 });
    });
    const models = vi.fn(async () => {
      throw new Error('catalog unavailable');
    });
    const harness = await builderAgentHarness({ cloudflareIdentity: true, ai: { models } });
    harness.openUpgradeWindow();

    const turn = harness.agent.onChatMessage(undefined, {
      requestId: 'request-1',
      body: {
        chatInitialId: CHAT_INITIAL_ID,
        subchatIndex: 0,
        transcript: { agentName: AGENT_NAME, generation: 0, subchatIndex: 0 },
        modelId: CLOUDFLARE_WORKERS_AI_MODEL,
      },
    });
    await settle();
    expectHeldByUpgradeWindow(harness);
    expect(harness.agent.state.activeTurn).toMatchObject({ status: 'accepted' });
    expect(asked).toEqual([]);

    harness.closeUpgradeWindow();
    await eventually(() => asked.length > 0);
    expect(asked[0]).toContain('/api/cloudflare/runtime-access');
    await Promise.resolve(turn).catch(() => undefined);
  });
});
