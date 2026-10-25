import { describe, expect, it } from 'vitest';
import type { CloudChefMessage, CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { toolFailure, toolSuccess } from 'cloudchef-agent/tool-result';
import { LINKED_BUILD_FOLLOW_MS, latestLinkedPublishView, linkedPublishView } from './linked-publish';

const NOW = 10_000_000;

function publish(output: CloudChefToolInvocation['output'], toolName = 'publish_preview'): CloudChefToolInvocation {
  return { type: 'dynamic-tool', state: 'output-available', toolCallId: 'call-1', toolName, input: {}, output };
}

function data(overrides: Record<string, string | number | boolean | null>) {
  return {
    branch: 'cloudchef/sara',
    commit: 'c'.repeat(40),
    live: false,
    build: 'pending',
    previewUrl: null,
    detailsUrl: null,
    startedAt: NOW - 1_000,
    defaultBranch: 'main',
    ...overrides,
  };
}

describe('linkedPublishView', () => {
  it('names a failed build by what already landed in the repository, not as an unsent publish', () => {
    const live = linkedPublishView(
      publish(toolFailure('model text', data({ live: true, build: 'failure' })), 'publish'),
      NOW,
    );
    expect(live).toMatchObject({ kind: 'failed', title: 'Publishing failed', building: false });
    expect(live?.detail).toContain("The build didn't finish, so your change isn't live");
    expect(linkedPublishView(publish(toolFailure('x', data({ build: 'failure' }))), NOW)?.title).toBe('Preview failed');
  });

  it('builds only while the pipeline is still followed, then says where an admin can see the result', () => {
    const building = linkedPublishView(publish(toolSuccess("Don't wait or poll", data({}))), NOW);
    expect(building).toMatchObject({
      kind: 'building',
      building: true,
      followDeadline: NOW - 1_000 + LINKED_BUILD_FOLLOW_MS,
    });
    expect(building?.detail).not.toContain('poll');
    const stale = linkedPublishView(publish(toolSuccess('x', data({}))), NOW + LINKED_BUILD_FOLLOW_MS);
    expect(stale).toMatchObject({ kind: 'unknown', building: false, followDeadline: null });
  });

  it('does not follow a pending build saved before outputs carried when it started', () => {
    const { startedAt: _startedAt, ...saved } = data({});
    expect(linkedPublishView(publish(toolSuccess('x', saved)), NOW)).toMatchObject({
      kind: 'unknown',
      building: false,
      followDeadline: null,
      detail:
        "Your change is saved. CloudChef stopped checking on the build, so it can't say whether it worked. " +
        "The result is in the Cloudflare dashboard of the project's account.",
    });
  });

  it('tells a merge conflict and a call that never reached the repository apart', () => {
    expect(
      linkedPublishView(
        publish(toolFailure('x', { branch: 'cloudchef/sara', commit: 'c'.repeat(40), conflict: true }), 'publish'),
        NOW,
      ),
    ).toMatchObject({ kind: 'conflict', title: 'Not published' });
    expect(linkedPublishView(publish(toolFailure('Nothing has changed.'), 'publish'), NOW)).toMatchObject({
      kind: 'not_sent',
      title: 'Not published',
      detail: 'Nothing has changed.',
    });
  });

  it('offers only web links', () => {
    const view = linkedPublishView(
      publish(
        toolSuccess('x', data({ build: 'success', previewUrl: 'https://a.workers.dev', detailsUrl: 'javascript:x' })),
      ),
      NOW,
    );
    expect(view).toMatchObject({ kind: 'built', previewUrl: 'https://a.workers.dev', detailsUrl: null });
  });
});

describe('latestLinkedPublishView', () => {
  it('is the newest publish that reached the repository', () => {
    const messages: CloudChefMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { ...publish(toolSuccess('x', data({ build: 'success' }))), toolCallId: 'first' },
          { ...publish(toolFailure('Nothing has changed.')), toolCallId: 'second' },
        ],
      },
    ];
    expect(latestLinkedPublishView(messages, NOW)?.title).toBe('Preview ready');
    expect(latestLinkedPublishView([], NOW)).toBeNull();
  });
});
