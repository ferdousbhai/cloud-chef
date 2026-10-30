import { describe, expect, it } from 'vitest';
import type { CloudChefMessage, CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { toolFailure, toolSuccess, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import { LINKED_BUILD_FOLLOW_MS, latestLinkedPublishView, linkedPublishView } from './linked-publish';

const NOW = 10_000_000;

function command(output: CloudChefToolInvocation['output'], toolName = 'exec'): CloudChefToolInvocation {
  return { type: 'dynamic-tool', state: 'output-available', toolCallId: 'call-1', toolName, input: {}, output };
}

/** A command that pushed to the project's repository, with what became of the push. */
function pushed(push: CloudChefToolResult): CloudChefToolInvocation {
  return command({ command: 'git push', exitCode: 0, stdout: '', stderr: '', push });
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
  it('names a failed build by what already landed in the repository', () => {
    const live = linkedPublishView(pushed(toolFailure('model text', data({ live: true, build: 'failure' }))), NOW);
    expect(live).toMatchObject({ kind: 'failed', title: 'Publishing failed', building: false });
    expect(live?.detail).toContain("The build didn't finish, so your change isn't live");
    expect(linkedPublishView(pushed(toolFailure('x', data({ build: 'failure' }))), NOW)?.title).toBe('Preview failed');
  });

  it('builds only while the build is still followed, then says where the result can be found', () => {
    const building = linkedPublishView(pushed(toolSuccess("Don't wait or poll", data({}))), NOW);
    expect(building).toMatchObject({
      kind: 'building',
      building: true,
      followDeadline: NOW - 1_000 + LINKED_BUILD_FOLLOW_MS,
    });
    expect(building?.detail).not.toContain('poll');
    const stale = linkedPublishView(pushed(toolSuccess('x', data({}))), NOW + LINKED_BUILD_FOLLOW_MS);
    expect(stale).toMatchObject({ kind: 'unknown', building: false, followDeadline: null });
  });

  it('does not follow a pending build saved before outputs carried when it started', () => {
    const { startedAt: _startedAt, ...saved } = data({});
    expect(linkedPublishView(pushed(toolSuccess('x', saved)), NOW)).toMatchObject({
      kind: 'unknown',
      building: false,
      followDeadline: null,
      detail:
        "Your change is saved. CloudChef stopped checking on the build, so it can't say whether it worked. " +
        "The result is in the Cloudflare dashboard of the project's account.",
    });
  });

  it('offers only web links', () => {
    const view = linkedPublishView(
      pushed(
        toolSuccess('x', data({ build: 'success', previewUrl: 'https://a.workers.dev', detailsUrl: 'javascript:x' })),
      ),
      NOW,
    );
    expect(view).toMatchObject({ kind: 'built', previewUrl: 'https://a.workers.dev', detailsUrl: null });
  });

  it('reads nothing from a command that pushed nothing, or from a tool no longer offered', () => {
    expect(linkedPublishView(command({ command: 'ls', exitCode: 0, stdout: '', stderr: '' }), NOW)).toBeNull();
    expect(linkedPublishView(command(toolSuccess('x', data({ build: 'success' })), 'publish'), NOW)).toBeNull();
  });
});

describe('latestLinkedPublishView', () => {
  it("is the newest command's push to the project", () => {
    const messages: CloudChefMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { ...pushed(toolSuccess('x', data({ build: 'success' }))), toolCallId: 'first' },
          { ...pushed(toolSuccess('x', data({ live: true }))), toolCallId: 'second' },
          { ...command({ command: 'ls', exitCode: 0, stdout: '', stderr: '' }), toolCallId: 'third' },
        ],
      },
    ];
    expect(latestLinkedPublishView(messages, NOW)?.title).toBe('Publishing…');
    expect(latestLinkedPublishView([], NOW)).toBeNull();
  });
});
