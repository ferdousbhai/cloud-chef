import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import {
  LINKED_BUILD_POLL_MS,
  linkedBuildSettledResult,
  linkedBuildStatus,
  linkedBuildStartedResult,
  linkedBuildUnfollowedResult,
  linkedBuildWatchSchema,
  linkedHeldBackNote,
  watchLinkedBuild,
  withLinkedBuildResult,
  type LinkedBuildStatus,
  type LinkedBuildWatch,
} from './linked-project-build';

const watch: LinkedBuildWatch = {
  toolCallId: 'call-1',
  orgProjectId: '11111111-1111-4111-8111-111111111111',
  sha: 'c'.repeat(40),
  branch: 'cloudchef/sara-abc123',
  where: 'on the branch cloudchef/sara-abc123',
  live: false,
  startedAt: 1_000,
  defaultBranch: 'main',
};

const pending: LinkedBuildStatus = {
  state: 'pending',
  previewUrl: null,
  detailsUrl: null,
};
const built: LinkedBuildStatus = {
  state: 'success',
  previewUrl: 'https://abc-site.ada.workers.dev',
  detailsUrl: 'https://dash.cloudflare.com/builds/1',
};

/** Runs a watch to its end on the fake clock. */
async function watched(args: Parameters<typeof watchLinkedBuild>[0]) {
  const status = watchLinkedBuild(args);
  await vi.runAllTimersAsync();
  return status;
}

function transcript(
  output: CloudChefToolResult,
  toolName = 'publish_preview',
  toolCallId = 'call-1',
): CloudChefMessage[] {
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Change the hero' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Publishing.' },
        { type: 'dynamic-tool', toolName, toolCallId, state: 'output-available', input: { message: 'x' }, output },
      ],
    },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a team project's publish", () => {
  it('returns as soon as the commit is in, saying the pipeline is building and not to wait', () => {
    const result = linkedBuildStartedResult(watch);
    expect(result).toMatchObject({
      ok: true,
      data: { build: 'pending', commit: watch.sha, branch: watch.branch, previewUrl: null, live: false },
    });
    expect(result.summary).toContain('Committed on the branch cloudchef/sara-abc123');
    expect(result.summary).toContain('preview link');
    expect(result.summary).toContain("Don't wait or poll");
    // Going live has no preview link to promise.
    expect(linkedBuildStartedResult({ ...watch, live: true }).summary).not.toContain('preview link');
    // The watch's own record survives a restart only if it parses back.
    expect(linkedBuildWatchSchema.parse(watch)).toEqual(watch);
  });

  it("settles to the pipeline's result: the preview link, the failure's details, or that it ran out of time", () => {
    expect(linkedBuildSettledResult(watch, built)).toMatchObject({
      ok: true,
      summary:
        'Committed on the branch cloudchef/sara-abc123; the pipeline built it. Preview: https://abc-site.ada.workers.dev',
      data: { build: 'success', previewUrl: built.previewUrl, detailsUrl: built.detailsUrl },
    });
    expect(linkedBuildSettledResult({ ...watch, live: true, where: 'merged into main' }, built).summary).toContain(
      'built it and it is live',
    );
    const failed = linkedBuildSettledResult(watch, {
      state: 'failure',
      previewUrl: null,
      detailsUrl: 'https://d/1',
    });
    expect(failed).toMatchObject({ ok: false, data: { build: 'failure' } });
    expect(failed.summary).toContain('Details: https://d/1');
    expect(linkedBuildSettledResult(watch, pending)).toMatchObject({ ok: true, data: { build: 'timed_out' } });
    expect(linkedBuildSettledResult(watch, pending).summary).toContain('still building it after 15 minutes');
    expect(
      linkedBuildSettledResult(watch, {
        state: 'none',
        previewUrl: null,
        detailsUrl: null,
      }).summary,
    ).toContain('reported no build');
  });

  it('names the local secrets it left out in every result, so the model can tell the person', () => {
    const heldBack = ['.env', 'config/.env.production'];
    const withSecrets: LinkedBuildWatch = { ...watch, heldBack };
    expect(linkedBuildWatchSchema.parse(withSecrets)).toEqual(withSecrets);
    for (const result of [
      linkedBuildStartedResult(withSecrets),
      linkedBuildSettledResult(withSecrets, built),
      linkedBuildSettledResult(withSecrets, {
        state: 'failure',
        previewUrl: null,
        detailsUrl: null,
      }),
      linkedBuildSettledResult(withSecrets, pending),
      linkedBuildSettledResult(withSecrets, {
        state: 'none',
        previewUrl: null,
        detailsUrl: null,
      }),
      linkedBuildUnfollowedResult(withSecrets),
    ]) {
      expect(result.summary).toContain('Secret settings files are never sent: .env, config/.env.production.');
    }
    expect(linkedBuildStartedResult(watch).summary).not.toContain('never sent');
    expect(linkedHeldBackNote(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toContain(': a, b, c, d, e and 2 more.');
  });

  it('reads the status until the build finishes, riding out an unreadable read', async () => {
    const answers: (LinkedBuildStatus | Error)[] = [
      pending,
      new Error('The control plane is down'),
      pending,
      built,
      pending,
    ];
    let polls = 0;
    const status = await watched({
      poll: async () => {
        const answer = answers[polls++] ?? pending;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
      deadline: 60 * 60_000,
    });
    expect(status).toEqual(built);
    expect(polls).toBe(4);
    // A poll's wait before each read.
    expect(Date.now()).toBe(4 * LINKED_BUILD_POLL_MS);
  });

  it('stops at the first failed build too', async () => {
    const failure: LinkedBuildStatus = {
      state: 'failure',
      previewUrl: null,
      detailsUrl: 'https://d/1',
    };
    let polls = 0;
    const status = await watched({
      poll: async () => {
        polls += 1;
        return polls === 1 ? failure : built;
      },
      deadline: 60 * 60_000,
    });
    expect(status).toEqual(failure);
    expect(polls).toBe(1);
  });

  it('stops at its deadline with the last status, and at once when it is stopped', async () => {
    let polls = 0;
    const late = await watched({
      poll: async () => {
        polls += 1;
        return pending;
      },
      deadline: 3 * LINKED_BUILD_POLL_MS,
    });
    expect(late).toEqual(pending);
    expect(polls).toBe(3);

    // Recovered after its deadline had passed, it still reads the build once, without waiting.
    vi.setSystemTime(10 * 60 * 60_000);
    let recoveredPolls = 0;
    const afterRestart = await watched({
      poll: async () => {
        recoveredPolls += 1;
        return built;
      },
      deadline: 60_000,
    });
    expect(afterRestart).toEqual(built);
    expect(recoveredPolls).toBe(1);
    expect(Date.now()).toBe(10 * 60 * 60_000);

    const stopped = new AbortController();
    stopped.abort();
    let stoppedPolls = 0;
    const result = await watched({
      poll: async () => {
        stoppedPolls += 1;
        return built;
      },
      deadline: Number.MAX_SAFE_INTEGER,
      signal: stopped.signal,
    });
    expect(result).toBeNull();
    expect(stoppedPolls).toBe(0);
  });

  it('has no status when not one read succeeded, rather than a pipeline that reported none', async () => {
    const status = await watched({
      poll: async () => {
        throw new Error('The control plane is down');
      },
      deadline: 3 * LINKED_BUILD_POLL_MS,
    });
    expect(status).toBeNull();
  });

  it("puts the result in place of that one call's waiting output, once", () => {
    const started = linkedBuildStartedResult(watch);
    const settled = linkedBuildSettledResult(watch, built);
    const before = transcript(started);
    const after = withLinkedBuildResult(before, 'call-1', settled);
    expect(after?.[1]?.parts[1]?.output).toEqual(settled);
    // Everything else is as it was, and the input transcript is untouched.
    expect(after?.[0]).toEqual(before[0]);
    expect(after?.[1]?.parts[0]).toEqual(before[1]?.parts[0]);
    expect(before[1]?.parts[1]?.output).toEqual(started);

    // Already settled (a recovered watch landing twice), another call, another tool, or no call at all.
    expect(withLinkedBuildResult(after ?? [], 'call-1', settled)).toBeNull();
    expect(withLinkedBuildResult(before, 'call-2', settled)).toBeNull();
    expect(withLinkedBuildResult(transcript(started, 'exec'), 'call-1', settled)).toBeNull();
    expect(withLinkedBuildResult(transcript(started, 'publish', 'call-1'), 'call-1', settled)).not.toBeNull();
    expect(withLinkedBuildResult([], 'call-1', settled)).toBeNull();
    const errored: CloudChefMessage[] = [
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'dynamic-tool', toolName: 'publish_preview', toolCallId: 'call-1', state: 'output-error' }],
      },
    ];
    // A call stopped after its commit shows as failed; the real result replaces its error.
    const landed = withLinkedBuildResult(errored, 'call-1', settled);
    expect(landed?.[0]?.parts[0]).toEqual({
      type: 'dynamic-tool',
      toolName: 'publish_preview',
      toolCallId: 'call-1',
      state: 'output-available',
      output: settled,
    });
    // `onlyFailed` lands the started result on a stopped call only, never over a waiting or settled output.
    expect(withLinkedBuildResult(errored, 'call-1', started, { onlyFailed: true })).not.toBeNull();
    expect(withLinkedBuildResult(before, 'call-1', started, { onlyFailed: true })).toBeNull();
  });

  it('says what landed, for the chat to show: when, the default branch, and why a build failed', () => {
    const live = { ...watch, live: true, where: 'merged into main', defaultBranch: 'main' };
    expect(linkedBuildStartedResult(live).data).toEqual({
      branch: watch.branch,
      commit: watch.sha,
      live: true,
      build: 'pending',
      previewUrl: null,
      detailsUrl: null,
      startedAt: watch.startedAt,
      defaultBranch: 'main',
    });
    const cancelled = linkedBuildSettledResult(live, {
      state: 'failure',
      previewUrl: null,
      detailsUrl: 'https://d/2',
    });
    expect(cancelled).toMatchObject({ ok: false, data: { build: 'failure' } });
    expect(cancelled.summary).toContain('did not succeed, so the change is not live');
    expect(linkedBuildUnfollowedResult(watch)).toMatchObject({ ok: true, data: { build: 'unfollowed' } });
  });

  it("reads Workers Builds' states, linking production for a live publish and the preview otherwise", () => {
    const status = {
      state: 'succeeded' as const,
      url: 'https://site.example.com',
      previewUrl: 'https://abc-site.ada.workers.dev',
      logUrl: 'https://dash.cloudflare.com/builds/1',
    };
    expect(linkedBuildStatus(status, true)).toEqual({
      state: 'success',
      previewUrl: 'https://site.example.com',
      detailsUrl: 'https://dash.cloudflare.com/builds/1',
    });
    expect(linkedBuildStatus(status, false).previewUrl).toBe('https://abc-site.ada.workers.dev');
    expect(linkedBuildStatus({ state: 'queued' }, false)).toEqual({
      state: 'pending',
      previewUrl: null,
      detailsUrl: null,
    });
    expect(linkedBuildStatus({ state: 'building' }, false).state).toBe('pending');
    expect(linkedBuildStatus({ state: 'failed' }, false).state).toBe('failure');
    expect(linkedBuildStatus({ state: 'none' }, false).state).toBe('none');
  });
});
