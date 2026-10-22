import { z } from 'zod';
import { replaceToolCallPart, type CloudChefMessage, type CloudChefPart } from 'cloudchef-agent/ai-compat';
import { toolFailure, toolSuccess, type CloudChefToolResult } from 'cloudchef-agent/tool-result';
import type { LinkedBuildStatus } from '~/lib/.server/cloudflare/linked-project-client';
import { LINKED_BUILD_WATCH_MS, type LinkedPublishData } from '~/lib/common/linked-publish';

/**
 * A GitHub project's publish returns as soon as its commit is on GitHub; the repository's pipeline
 * (Workers Builds, typically ~2 minutes) is watched in the background, and its result replaces the
 * publish tool's output in the transcript once the turn that called it has ended. The model and the
 * person never sit through the build, and the next turn reads the result like any tool output.
 *
 * A result's `summary` is written for the model; the chat shows its `data` (app/lib/common/linked-publish.ts).
 */

/** Workers Builds reports in minutes, so a status read every 10 s shows the link within seconds of it. */
export const LINKED_BUILD_POLL_MS = 10_000;
/**
 * How long other checks finishing (a CI workflow, a linter app) don't count as the build while Workers
 * Builds hasn't posted its own check yet: it starts its check a little after the push.
 */
export const WORKERS_BUILDS_APPEAR_MS = 3 * 60_000;

/** How many held-back paths a watch keeps; the summary names fewer. */
export const LINKED_HELD_BACK_LIMIT = 20;

/**
 * What a publish's summary adds when it left out local secrets the workspace changed, so the model can
 * tell the person: they stay as GitHub has them.
 */
export function linkedHeldBackNote(heldBack: readonly string[] | undefined): string {
  if (!heldBack?.length) {
    return '';
  }
  const named = heldBack.slice(0, 5).join(', ');
  const more = heldBack.length > 5 ? ` and ${heldBack.length - 5} more` : '';
  return (
    ` Not sent, as local secrets CloudChef never publishes: ${named}${more}. GitHub keeps its own version` +
    ' of any it has; tell the user if they meant to change them.'
  );
}

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
    data.conclusion = status?.conclusion ?? 'failure';
  }
  return data;
}

/** The publish tool's output the moment its commit is on GitHub. */
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
    const conclusion = build.conclusion && build.conclusion !== 'failure' ? ` (${build.conclusion})` : '';
    return toolFailure(
      `Committed ${watch.where}, but the pipeline's build did not succeed${conclusion}` +
        `${watch.live ? ', so the change is not live' : ''}. Details: ${build.detailsUrl ?? 'see the repository on GitHub'}.` +
        linkedHeldBackNote(watch.heldBack),
      linkedBuildData(watch, 'failure', build),
    );
  }
  if (build.state === 'pending') {
    return toolSuccess(
      `Committed ${watch.where}; the pipeline was still building it after ${LINKED_BUILD_WATCH_MS / 60_000} minutes. Its result is on GitHub.` +
        linkedHeldBackNote(watch.heldBack),
      linkedBuildData(watch, 'timed_out', build),
    );
  }
  return toolSuccess(
    `Committed ${watch.where}. The repository reported no pipeline for it.` + linkedHeldBackNote(watch.heldBack),
    linkedBuildData(watch, 'none', build),
  );
}

/** The publish tool's output when CloudChef could not follow the pipeline at all. */
export function linkedBuildUnfollowedResult(watch: LinkedBuildWatch): CloudChefToolResult<LinkedPublishData> {
  return toolSuccess(
    `Committed ${watch.where}. CloudChef could not follow the repository's pipeline for it; its build result is on GitHub.` +
      linkedHeldBackNote(watch.heldBack),
    linkedBuildData(watch, 'unfollowed'),
  );
}

/**
 * Reads the pipeline's status until it reports a finished build, the deadline passes, or the watch is stopped.
 * Before `workersBuildsGraceUntil`, a finished status that isn't Workers Builds' own is not yet the build.
 * Null when no read succeeded: CloudChef could not follow the pipeline, which is not the pipeline reporting none.
 */
export async function watchLinkedBuild(args: {
  poll: () => Promise<LinkedBuildStatus>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  workersBuildsGraceUntil: number;
  signal?: AbortSignal;
}): Promise<LinkedBuildStatus | null> {
  let status: LinkedBuildStatus | null = null;
  let polled = false;
  while (args.now() < args.deadline && !args.signal?.aborted) {
    await args.sleep(LINKED_BUILD_POLL_MS);
    // One unreadable status says nothing about the build: the last one known stands until the next read.
    status = await args.poll().catch(() => status);
    polled = true;
    const finished = status?.state === 'success' || status?.state === 'failure';
    if (finished && (status?.workersBuilds || args.now() >= args.workersBuildsGraceUntil)) {
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
 * The transcript with the watched publish's output replaced by `output`, or null when there is nothing to
 * replace: the call isn't in the transcript, or a settled result already landed. A call whose turn was
 * stopped or cut off after its commit was made shows as failed; it takes the real result too, since the
 * commit is on GitHub whatever happened to the turn. `onlyFailed` replaces only such a call.
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
