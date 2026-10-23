import { z } from 'zod';
import { abortableSleep } from '~/lib/abortable-sleep';
import { replaceToolCallPart, type CloudChefMessage, type CloudChefPart } from 'cloudchef-agent/ai-compat';
import { toolFailure, toolSuccess, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { ProjectBuildStatus } from '~/lib/.server/cloudflare/linked-project-client';
import { LINKED_BUILD_WATCH_MS, type LinkedPublishData } from '~/lib/common/linked-publish';

/**
 * A team project's publish returns as soon as its commit is in the project's repository; Workers Builds
 * (typically ~2 minutes) is watched in the background, and its result replaces the publish tool's output in
 * the transcript once the turn that called it has ended. The model and the person never sit through the
 * build, and the next turn reads the result like any tool output.
 *
 * A result's `summary` is written for the model; the chat shows its `data` (app/lib/common/linked-publish.ts).
 */

/** Workers Builds reports in minutes, so a status read every 10 s shows the link within seconds of it. */
export const LINKED_BUILD_POLL_MS = 10_000;

/** A build as the watch follows it: still going, built, failed, or none for the commit (yet). */
export type LinkedBuildStatus = {
  state: 'pending' | 'success' | 'failure' | 'none';
  /** The commit's own address: production's for a live publish, the branch's preview otherwise. */
  previewUrl: string | null;
  /** The build's log in the Cloudflare dashboard. */
  detailsUrl: string | null;
};

/** What Workers Builds reports for a commit (`runtime-projects/status`), as the watch reads it. */
export function linkedBuildStatus(status: ProjectBuildStatus, live: boolean): LinkedBuildStatus {
  const state =
    status.state === 'succeeded'
      ? 'success'
      : status.state === 'failed'
        ? 'failure'
        : status.state === 'none'
          ? 'none'
          : 'pending';
  const link = live ? (status.url ?? status.previewUrl) : (status.previewUrl ?? status.url);
  return { state, previewUrl: link ?? null, detailsUrl: status.logUrl ?? null };
}

/** How many held-back paths a watch keeps; the summary names fewer. */
export const LINKED_HELD_BACK_LIMIT = 20;

/**
 * What a publish's summary adds when it left out local secrets the workspace changed, so the model can
 * tell the person: they stay as the repository has them.
 */
export function linkedHeldBackNote(heldBack: readonly string[] | undefined): string {
  if (!heldBack?.length) {
    return '';
  }
  const named = heldBack.slice(0, 5).join(', ');
  const more = heldBack.length > 5 ? ` and ${heldBack.length - 5} more` : '';
  return (
    ` Not sent, as local secrets CloudChef never publishes: ${named}${more}. The repository keeps its own version` +
    ' of any it has; tell the user if they meant to change them.'
  );
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
  /** Local secrets the workspace changed that the commit left out (`linkedWorkspaceChanges`). */
  heldBack: z.array(z.string().min(1).max(4096)).max(LINKED_HELD_BACK_LIMIT).optional(),
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
    detailsUrl: status?.detailsUrl ?? null,
    startedAt: watch.startedAt,
    defaultBranch: watch.defaultBranch,
  };
  if (build === 'failure') {
    data.conclusion = 'failure';
  }
  return data;
}

/** The publish tool's output the moment its commit is in the repository. */
export function linkedBuildStartedResult(watch: LinkedBuildWatch): CloudChefToolResult<LinkedPublishData> {
  const outcome = watch.live ? 'live' : 'previewable';
  return toolSuccess(
    `Committed ${watch.where}. The repository's pipeline is building it now (usually about two minutes); it ` +
      `will be ${outcome} once that finishes, and the result${watch.live ? '' : ' and its preview link'} will ` +
      "appear in the chat by itself. Don't wait or poll for it: tell the user it's building, and carry on with " +
      'anything else they asked for.' +
      linkedHeldBackNote(watch.heldBack),
    linkedBuildData(watch, 'pending'),
  );
}

/** The publish tool's output once the pipeline has reported, or the watch ran out of time. */
export function linkedBuildSettledResult(
  watch: LinkedBuildWatch,
  build: LinkedBuildStatus,
): CloudChefToolResult<LinkedPublishData> {
  if (build.state === 'success') {
    const preview = build.previewUrl ? ` Preview: ${build.previewUrl}` : '';
    return toolSuccess(
      `Committed ${watch.where}; the pipeline built it${watch.live ? ' and it is live' : ''}.${preview}` +
        linkedHeldBackNote(watch.heldBack),
      linkedBuildData(watch, 'success', build),
    );
  }
  if (build.state === 'failure') {
    return toolFailure(
      `Committed ${watch.where}, but the pipeline's build did not succeed` +
        `${watch.live ? ', so the change is not live' : ''}. Details: ${build.detailsUrl ?? "see the project's builds in the Cloudflare dashboard"}.` +
        linkedHeldBackNote(watch.heldBack),
      linkedBuildData(watch, 'failure', build),
    );
  }
  if (build.state === 'pending') {
    return toolSuccess(
      `Committed ${watch.where}; the pipeline was still building it after ${LINKED_BUILD_WATCH_MS / 60_000} minutes. Its result is in Workers Builds.` +
        linkedHeldBackNote(watch.heldBack),
      linkedBuildData(watch, 'timed_out', build),
    );
  }
  return toolSuccess(
    `Committed ${watch.where}. Workers Builds reported no build for it: the repository may not be connected to Workers Builds yet.` +
      linkedHeldBackNote(watch.heldBack),
    linkedBuildData(watch, 'none', build),
  );
}

/** The publish tool's output when CloudChef could not follow the pipeline at all. */
export function linkedBuildUnfollowedResult(watch: LinkedBuildWatch): CloudChefToolResult<LinkedPublishData> {
  return toolSuccess(
    `Committed ${watch.where}. CloudChef could not follow the repository's pipeline for it; its build result is in Workers Builds.` +
      linkedHeldBackNote(watch.heldBack),
    linkedBuildData(watch, 'unfollowed'),
  );
}

/**
 * Reads the pipeline's status until it reports a finished build, the deadline passes, or the watch is stopped.
 * Null when no read succeeded: CloudChef could not follow the pipeline, which is not the pipeline reporting none.
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
    if (status?.state === 'success' || status?.state === 'failure') {
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

/**
 * The transcript with the watched publish's output replaced by `output`, or null when there is nothing to
 * replace: the call isn't in the transcript, or a settled result already landed. A call whose turn was
 * stopped or cut off after its commit was made shows as failed; it takes the real result too, since the
 * commit is in the repository whatever happened to the turn. `onlyFailed` replaces only such a call.
 */
export function withLinkedBuildResult(
  messages: readonly CloudChefMessage[],
  toolCallId: string,
  output: CloudChefToolResult,
  options: { onlyFailed?: boolean } = {},
): CloudChefMessage[] | null {
  return replaceToolCallPart(messages, toolCallId, (part, invocation) => {
    if (invocation.toolName !== 'publish_preview' && invocation.toolName !== 'publish') {
      return null;
    }
    const failed = invocation.state === 'output-error';
    const pending = invocation.state === 'output-available' && pendingOutputSchema.safeParse(part.output).success;
    if (!(failed || (pending && !options.onlyFailed))) {
      return null;
    }
    const landed: CloudChefPart = { ...part, state: 'output-available', output };
    delete landed.errorText;
    return landed;
  });
}
