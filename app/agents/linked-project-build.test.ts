import { describe, expect, it } from 'vitest';
import type { CloudChefMessage } from 'cloudchef-agent/ai-compat';
import type { CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { LinkedBuildStatus } from '~/lib/.server/cloudflare/linked-project-client';
import {
  LINKED_BUILD_POLL_MS,
  linkedBuildSettledResult,
  linkedBuildStartedResult,
  linkedBuildUnfollowedResult,
  linkedBuildWatchSchema,
  linkedHeldBackNote,
  watchLinkedBuild,
  withLinkedBuildResult,
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
  conclusion: null,
  workersBuilds: true,
};
const built: LinkedBuildStatus = {
  state: 'success',
  previewUrl: 'https://abc-site.ada.workers.dev',
  detailsUrl: 'https://dash.cloudflare.com/builds/1',
  conclusion: null,
  workersBuilds: true,
};

/** A clock that moves only when the watch sleeps, recording each sleep. */
function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
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

describe("a GitHub project's publish", () => {
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
      conclusion: null,
      workersBuilds: true,
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
        conclusion: null,
        workersBuilds: true,
      }).summary,
    ).toContain('reported no pipeline');
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
        conclusion: null,
        workersBuilds: true,
      }),
      linkedBuildSettledResult(withSecrets, pending),
      linkedBuildSettledResult(withSecrets, {
        state: 'none',
        previewUrl: null,
        detailsUrl: null,
        conclusion: null,
        workersBuilds: true,
      }),
      linkedBuildUnfollowedResult(withSecrets),
    ]) {
      expect(result.summary).toContain(
        'Not sent, as local secrets CloudChef never publishes: .env, config/.env.production.',
      );
    }
    expect(linkedBuildStartedResult(watch).summary).not.toContain('Not sent');
    expect(linkedHeldBackNote(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toContain(': a, b, c, d, e and 2 more.');
  });

  it('reads the status until the build finishes, riding out an unreadable read', async () => {
    const time = clock();
    const answers: (LinkedBuildStatus | Error)[] = [pending, new Error('GitHub is down'), pending, built, pending];
    let polls = 0;
    const status = await watchLinkedBuild({
      poll: async () => {
        const answer = answers[polls++] ?? pending;
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      },
      sleep: time.sleep,
      now: time.now,
      deadline: 60 * 60_000,
      workersBuildsGraceUntil: 0,
    });
    expect(status).toEqual(built);
    expect(polls).toBe(4);
    expect(time.sleeps).toEqual([
      LINKED_BUILD_POLL_MS,
      LINKED_BUILD_POLL_MS,
      LINKED_BUILD_POLL_MS,
      LINKED_BUILD_POLL_MS,
    ]);
  });

  it('stops at the first failed build too', async () => {
    const time = clock();
    const failure: LinkedBuildStatus = {
      state: 'failure',
      previewUrl: null,
      detailsUrl: 'https://d/1',
      conclusion: null,
      workersBuilds: true,
    };
    let polls = 0;
    const status = await watchLinkedBuild({
      poll: async () => {
        polls += 1;
        return polls === 1 ? failure : built;
      },
      sleep: time.sleep,
      now: time.now,
      deadline: 60 * 60_000,
      workersBuildsGraceUntil: 0,
    });
    expect(status).toEqual(failure);
    expect(polls).toBe(1);
  });

  it('stops at its deadline with the last status, and at once when it is stopped', async () => {
    const time = clock();
    let polls = 0;
    const late = await watchLinkedBuild({
      poll: async () => {
        polls += 1;
        return pending;
      },
      sleep: time.sleep,
      now: time.now,
      deadline: 3 * LINKED_BUILD_POLL_MS,
      workersBuildsGraceUntil: 0,
    });
    expect(late).toEqual(pending);
    expect(polls).toBe(3);

    // Recovered after its deadline had passed, it still reads the build once, without waiting.
    const recovered = clock();
    let recoveredPolls = 0;
    const afterRestart = await watchLinkedBuild({
      poll: async () => {
        recoveredPolls += 1;
        return built;
      },
      sleep: recovered.sleep,
      now: () => 10 * 60 * 60_000,
      deadline: 60_000,
      workersBuildsGraceUntil: 0,
    });
    expect(afterRestart).toEqual(built);
    expect(recoveredPolls).toBe(1);
    expect(recovered.sleeps).toEqual([]);

    const stopped = new AbortController();
    stopped.abort();
    let stoppedPolls = 0;
    const result = await watchLinkedBuild({
      poll: async () => {
        stoppedPolls += 1;
        return built;
      },
      sleep: time.sleep,
      now: time.now,
      deadline: Number.MAX_SAFE_INTEGER,
      workersBuildsGraceUntil: 0,
      signal: stopped.signal,
    });
    expect(result).toBeNull();
    expect(stoppedPolls).toBe(0);
  });

  it('has no status when not one read succeeded, rather than a pipeline that reported none', async () => {
    const time = clock();
    const status = await watchLinkedBuild({
      poll: async () => {
        throw new Error('GitHub is down');
      },
      sleep: time.sleep,
      now: time.now,
      deadline: 3 * LINKED_BUILD_POLL_MS,
      workersBuildsGraceUntil: 0,
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
      conclusion: 'cancelled',
      workersBuilds: true,
    });
    expect(cancelled).toMatchObject({ ok: false, data: { build: 'failure', conclusion: 'cancelled' } });
    expect(cancelled.summary).toContain('did not succeed (cancelled), so the change is not live');
    expect(linkedBuildUnfollowedResult(watch)).toMatchObject({ ok: true, data: { build: 'unfollowed' } });
  });

  it("waits for Workers Builds' own check before taking other checks finishing as the build", async () => {
    const time = clock();
    const ciPassed: LinkedBuildStatus = { ...built, previewUrl: null, workersBuilds: false };
    const answers: LinkedBuildStatus[] = [ciPassed, ciPassed, { ...built, workersBuilds: true }];
    let polls = 0;
    const status = await watchLinkedBuild({
      poll: async () => answers[polls++] ?? pending,
      sleep: time.sleep,
      now: time.now,
      deadline: 60 * 60_000,
      workersBuildsGraceUntil: 5 * LINKED_BUILD_POLL_MS,
    });
    expect(status).toEqual({ ...built, workersBuilds: true });
    expect(polls).toBe(3);

    // A repository without Workers Builds is judged by its own checks once the grace has passed.
    const other = clock();
    let otherPolls = 0;
    const settled = await watchLinkedBuild({
      poll: async () => {
        otherPolls += 1;
        return ciPassed;
      },
      sleep: other.sleep,
      now: other.now,
      deadline: 60 * 60_000,
      workersBuildsGraceUntil: 2 * LINKED_BUILD_POLL_MS,
    });
    expect(settled).toEqual(ciPassed);
    expect(otherPolls).toBe(2);
  });
});
