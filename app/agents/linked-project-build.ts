import { z } from 'zod';
import { getToolInvocation, type CloudChefMessage } from 'cloudchef-agent/ai-compat';
import { toolFailure, toolSuccess, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { LinkedBuildStatus } from '~/lib/.server/cloudflare/linked-project-client';

/**
 * A GitHub project's publish returns as soon as its commit is on GitHub; the repository's pipeline
 * (Workers Builds, typically ~2 minutes) is watched in the background, and its result replaces the
 * publish tool's output in the transcript once the turn that called it has ended. The model and the
 * person never sit through the build, and the next turn reads the result like any tool output.
 */

/** How long a pipeline gets to report a finished build before the watch gives up. */
export const LINKED_BUILD_WATCH_MS = 15 * 60_000;
/** Workers Builds reports in minutes, so a status read every 10 s shows the link within seconds of it. */
export const LINKED_BUILD_POLL_MS = 10_000;

/** Fiber metadata survives a Durable Object restart, so the watch is re-parsed before it resumes. */
export const linkedBuildWatchSchema = z.object({
  toolCallId: z.string().min(1).max(256),
  orgProjectId: z.string().uuid(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  branch: z.string().min(1).max(256),
  /** Where the commit went, as the summary says it: "on the branch …" or "merged into main". */
  where: z.string().min(1).max(512),
  live: z.boolean(),
  startedAt: z.number().int().positive(),
});
export type LinkedBuildWatch = z.infer<typeof linkedBuildWatchSchema>;

/** What a publish carries in its output; `build` stays `pending` until the watch settles it. */
type LinkedBuildData = {
  branch: string;
  commit: string;
  live: boolean;
  build: LinkedBuildStatus['state'] | 'timed_out';
  previewUrl: string | null;
  detailsUrl: string | null;
};

/** The publish tool's output the moment its commit is on GitHub. */
export function linkedBuildStartedResult(watch: LinkedBuildWatch): CloudChefToolResult<LinkedBuildData> {
  const outcome = watch.live ? 'live' : 'previewable';
  return toolSuccess(
    `Committed ${watch.where}. The repository's pipeline is building it now (usually about two minutes); it ` +
      `will be ${outcome} once that finishes, and the result${watch.live ? '' : ' and its preview link'} will ` +
      "appear on this tool's card in the chat by itself. Don't wait or poll for it: tell the user it's building, " +
      'and carry on with anything else they asked for.',
    { branch: watch.branch, commit: watch.sha, live: watch.live, build: 'pending', previewUrl: null, detailsUrl: null },
  );
}

/** The publish tool's output once the pipeline has reported, or the watch ran out of time. */
export function linkedBuildSettledResult(
  watch: LinkedBuildWatch,
  build: LinkedBuildStatus,
): CloudChefToolResult<LinkedBuildData> {
  const settled = build.state === 'success' || build.state === 'failure';
  const data: LinkedBuildData = {
    branch: watch.branch,
    commit: watch.sha,
    live: watch.live,
    build: settled ? build.state : 'timed_out',
    previewUrl: build.previewUrl,
    detailsUrl: build.detailsUrl,
  };
  if (build.state === 'success') {
    const preview = build.previewUrl ? ` Preview: ${build.previewUrl}` : '';
    return toolSuccess(
      `Committed ${watch.where}; the pipeline built it${watch.live ? ' and it is live' : ''}.${preview}`,
      data,
    );
  }
  if (build.state === 'failure') {
    return toolFailure(
      `Committed ${watch.where}, but the pipeline's build failed. Details: ${build.detailsUrl ?? 'see the repository on GitHub'}.`,
      data,
    );
  }
  return toolSuccess(
    build.state === 'pending'
      ? `Committed ${watch.where}; the pipeline was still building it after ${LINKED_BUILD_WATCH_MS / 60_000} minutes. Its result is on GitHub.`
      : `Committed ${watch.where}. The repository reported no pipeline for it.`,
    data,
  );
}

/** Reads the pipeline's status until it reports a finished build, the deadline passes, or the watch is stopped. */
export async function watchLinkedBuild(args: {
  poll: () => Promise<LinkedBuildStatus>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  signal?: AbortSignal;
}): Promise<LinkedBuildStatus> {
  let status: LinkedBuildStatus = { state: 'none', previewUrl: null, detailsUrl: null };
  let polled = false;
  while (args.now() < args.deadline && !args.signal?.aborted) {
    await args.sleep(LINKED_BUILD_POLL_MS);
    // One unreadable status says nothing about the build: the last one known stands until the next read.
    status = await args.poll().catch(() => status);
    polled = true;
    if (status.state === 'success' || status.state === 'failure') {
      return status;
    }
  }
  // A watch recovered after its deadline (the agent was down meanwhile) still reports what GitHub says.
  if (!polled && !args.signal?.aborted) {
    status = await args.poll().catch(() => status);
  }
  return status;
}

const pendingOutputSchema = z.looseObject({ data: z.looseObject({ build: z.literal('pending') }) });

/**
 * The transcript with the watched publish's output replaced by its settled result, or null when there is
 * nothing to replace: the call isn't in the transcript, or its result already landed.
 */
export function withLinkedBuildResult(
  messages: readonly CloudChefMessage[],
  toolCallId: string,
  output: CloudChefToolResult,
): CloudChefMessage[] | null {
  let replaced = false;
  const next = messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      const invocation = getToolInvocation(part);
      if (
        (invocation?.toolName !== 'publish_preview' && invocation?.toolName !== 'publish') ||
        invocation.toolCallId !== toolCallId ||
        invocation.state !== 'output-available' ||
        !pendingOutputSchema.safeParse(part.output).success
      ) {
        return part;
      }
      replaced = true;
      return { ...part, output };
    }),
  }));
  return replaced ? next : null;
}
