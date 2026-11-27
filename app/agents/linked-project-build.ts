import { z } from 'zod';
import { abortableSleep } from '~/lib/abortable-sleep';
import { replaceToolCallPart, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { toolFailure, toolSuccess, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { ProjectBuildStatus } from '~/lib/.server/cloudflare/linked-project-client';
import { LINKED_BUILD_WATCH_MS, type LinkedPublishData } from '~/lib/common/linked-publish';

/**
 * A publish returns as soon as its commit is in the project's repository; its build and deploy (typically ~2
 * minutes) is watched in the background, and its result replaces the publish tool's output in the transcript once
 * the turn that called it has ended. The model and the person never sit through the build, and the next turn reads
 * the result like any tool output.
 *
 * A result's `summary` is written for the model; the chat shows its `data` (app/lib/common/linked-publish.ts).
 */

/** A build takes minutes, so a status read every 10 s shows the link within seconds of it. */
export const LINKED_BUILD_POLL_MS = 10_000;

/**
 * A build as the watch follows it: still going, built, failed, cancelled (a newer commit superseded it), or none for
 * the commit (yet).
 */
export type LinkedBuildStatus = {
  state: 'pending' | 'success' | 'failure' | 'cancelled' | 'none';
  /** The commit's own address: production's for a live publish, the branch's preview otherwise. */
  previewUrl: string | null;
  /** Why it didn't go live, when the build says. */
  reason: string | null;
};

/** How a commit's build is going (`runtime-projects/status`), as the watch reads it. */
export function linkedBuildStatus(status: ProjectBuildStatus, live: boolean): LinkedBuildStatus {
  const state =
    status.state === 'succeeded'
      ? 'success'
      : status.state === 'failed'
        ? 'failure'
        : status.state === 'cancelled'
          ? 'cancelled'
          : status.state === 'none'
            ? 'none'
            : 'pending';
  const link = live ? (status.url ?? status.previewUrl) : (status.previewUrl ?? status.url);
  return { state, previewUrl: link ?? null, reason: status.reason ?? null };
}

/** Fiber metadata survives a Durable Object restart, so the watch is re-parsed before it resumes. */
export const linkedBuildWatchSchema = z.object({
  toolCallId: z.string().min(1).max(256),
  orgProjectId: z.string().min(1).max(256),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string().min(1).max(256),
  /** Where the commit went, as the summary says it: "on the branch …" or "merged into main". */
  where: z.string().min(1).max(512),
  live: z.boolean(),
  startedAt: z.number().int().positive(),
  defaultBranch: z.string().min(1).max(256),
});
export type LinkedBuildWatch = z.infer<typeof linkedBuildWatchSchema>;

function linkedBuildData(
  watch: LinkedBuildWatch,
  build: LinkedPublishData['build'],
  status?: LinkedBuildStatus,
): LinkedPublishData {
  const data: LinkedPublishData = {
    branch: watch.branch,
    commit: watch.sha,
    live: watch.live,
    build,
    previewUrl: status?.previewUrl ?? null,
    // Kept for outputs saved when a build had a page of its own in Cloudflare's dashboard.
    detailsUrl: null,
    startedAt: watch.startedAt,
    defaultBranch: watch.defaultBranch,
  };
  return data;
}

/** The publish tool's output the moment its commit is in the repository. */
export function linkedBuildStartedResult(watch: LinkedBuildWatch): CloudChefToolResult<LinkedPublishData> {
  const outcome = watch.live ? 'live' : 'previewable';
  return toolSuccess(
    `Committed ${watch.where}. It is being built now (usually about two minutes); it ` +
      `will be ${outcome} once that finishes, and the result${watch.live ? '' : ' and its preview link'} will ` +
      "appear in the chat by itself. Don't wait or poll for it: tell the user it's building, and carry on with " +
      'anything else they asked for.',
    linkedBuildData(watch, 'pending'),
  );
}

/** The publish tool's output once the build has ended, or the watch ran out of time. */
export function linkedBuildSettledResult(
  watch: LinkedBuildWatch,
  build: LinkedBuildStatus,
): CloudChefToolResult<LinkedPublishData> {
  if (build.state === 'success') {
    const preview = build.previewUrl ? ` Preview: ${build.previewUrl}` : '';
    return toolSuccess(
      `Committed ${watch.where}; it was built${watch.live ? ' and it is live' : ''}.${preview}`,
      linkedBuildData(watch, 'success', build),
    );
  }
  if (build.state === 'failure') {
    return toolFailure(
      `Committed ${watch.where}, but publishing it did not succeed` +
        `${watch.live ? ', so the change is not live' : ''}${build.reason ? `: ${build.reason}` : '.'}`,
      linkedBuildData(watch, 'failure', build),
    );
  }
  if (build.state === 'cancelled') {
    return toolSuccess(
      `Committed ${watch.where}, but a newer version of ` +
        `${watch.live ? 'main was pushed before this one went live, and that one, which includes this change, is published instead' : 'the branch was pushed before this one was built, and that one is built instead'}.`,
      linkedBuildData(watch, 'cancelled', build),
    );
  }
  if (build.state === 'pending') {
    return toolSuccess(
      `Committed ${watch.where}; it was still being built after ${LINKED_BUILD_WATCH_MS / 60_000} minutes. How it went shows on the project's card on the projects page.`,
      linkedBuildData(watch, 'timed_out', build),
    );
  }
  return toolSuccess(
    `Committed ${watch.where}. Nothing was built for it${build.reason ? `: ${build.reason}` : '.'}`,
    linkedBuildData(watch, 'none', build),
  );
}

/** The publish tool's output when CloudChef could not follow the build at all. */
export function linkedBuildUnfollowedResult(watch: LinkedBuildWatch): CloudChefToolResult<LinkedPublishData> {
  return toolSuccess(
    `Committed ${watch.where}. CloudChef could not follow its build; how it went shows on the project's card on the projects page.`,
    linkedBuildData(watch, 'unfollowed'),
  );
}

/**
 * Reads the build's status until it has ended, the deadline passes, or the watch is stopped. Null when no read
 * succeeded: CloudChef could not follow the build, which is not the same as nothing being built.
 */
export async function watchLinkedBuild(args: {
  poll: () => Promise<LinkedBuildStatus>;
  deadline: number;
  signal?: AbortSignal;
}): Promise<LinkedBuildStatus | null> {
  let status: LinkedBuildStatus | null = null;
  let polled = false;
  while (Date.now() < args.deadline && !args.signal?.aborted) {
    await abortableSleep(LINKED_BUILD_POLL_MS, args.signal);
    // One unreadable status says nothing about the build: the last one known stands until the next read.
    status = await args.poll().catch(() => status);
    polled = true;
    if (status?.state === 'success' || status?.state === 'failure' || status?.state === 'cancelled') {
      return status;
    }
  }
  // A watch recovered after its deadline (the agent was down meanwhile) still reports what the build says.
  if (!polled && !args.signal?.aborted) {
    status = await args.poll().catch(() => status);
  }
  return status;
}

const pendingOutputSchema = z.looseObject({ data: z.looseObject({ build: z.literal('pending') }) });
const execReportSchema = z.looseObject({ push: z.unknown() });

/**
 * The transcript with what the watched command pushed replaced by `output`, or null when there is nothing to
 * replace: the call isn't in the transcript, or a settled result already landed. The command keeps its own
 * output; only what it pushed takes the build's result.
 */
export function withLinkedBuildResult(
  messages: readonly CloudChefMessage[],
  toolCallId: string,
  output: CloudChefToolResult,
): CloudChefMessage[] | null {
  return replaceToolCallPart(messages, toolCallId, (part, invocation) => {
    const report = invocation.toolName === 'exec' ? execReportSchema.safeParse(part.output).data : undefined;
    if (invocation.state !== 'output-available' || !report || !pendingOutputSchema.safeParse(report.push).success) {
      return null;
    }
    return { ...part, output: { ...report, push: output } };
  });
}
