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
  it('names a failed build by what already landed on GitHub, not as an unsent publish', () => {
    const live = linkedPublishView(
      publish(toolFailure('model text', data({ live: true, build: 'failure', conclusion: 'cancelled' })), 'publish'),
      NOW,
    );
    expect(live).toMatchObject({ kind: 'failed', title: 'Merged into main; deploy failed', building: false });
    expect(live?.detail).toContain('was cancelled');
    expect(linkedPublishView(publish(toolFailure('x', data({ build: 'failure' }))), NOW)?.title).toBe(
      'Committed to cloudchef/sara; build failed',
    );
  });

  it('builds only while the pipeline is still followed, then says the result is on GitHub', () => {
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

  it('tells a merge conflict and a call that never reached GitHub apart', () => {
    expect(
      linkedPublishView(
        publish(toolFailure('x', { branch: 'cloudchef/sara', commit: 'c'.repeat(40), conflict: true }), 'publish'),
        NOW,
      ),
    ).toMatchObject({ kind: 'conflict', title: 'Saved on cloudchef/sara, not merged' });
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
  it('is the newest publish that reached GitHub', () => {
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
    expect(latestLinkedPublishView(messages, NOW)?.title).toBe('Preview ready on cloudchef/sara');
    expect(latestLinkedPublishView([], NOW)).toBeNull();
  });
});
