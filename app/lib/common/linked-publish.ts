import { z } from 'zod';
import { getToolInvocation, type CloudChefMessage, type CloudChefToolInvocation } from 'cloudchef-agent/ai-compat';
import { isCloudChefToolResult } from 'cloudchef-agent/tool-result';

/**
 * What a team project's `publish_preview` / `publish` tool output carries, and how the chat shows it.
 * The output's `summary` is written for the model; everything a person reads comes from `data` here.
 */

/** How long a pipeline gets to report a finished build before the watch gives up. */
export const LINKED_BUILD_WATCH_MS = 15 * 60_000;
/**
 * A publish still `pending` this long after its commit is no longer being followed: the watch gives up
 * after LINKED_BUILD_WATCH_MS and then waits at most a turn's wall clock (4 h) for its turn to end.
 */
export const LINKED_BUILD_FOLLOW_MS = LINKED_BUILD_WATCH_MS + 4 * 60 * 60_000 + 60_000;

const linkedBuildStateSchema = z.enum([
  'pending',
  'success',
  'failure',
  'none',
  'timed_out',
  /** CloudChef could not follow the pipeline (its watch could not start or read the build's status). */
  'unfollowed',
]);

/** A publish whose commit is in the project's repository. Fields after `detailsUrl` are absent from outputs saved before them. */
export const linkedPublishDataSchema = z.looseObject({
  branch: z.string(),
  commit: z.string(),
  live: z.boolean(),
  build: linkedBuildStateSchema,
  previewUrl: z.string().nullable(),
  detailsUrl: z.string().nullable(),
  /** When the commit landed (epoch ms): a `pending` build without it, or older than LINKED_BUILD_FOLLOW_MS, isn't followed. */
  startedAt: z.number().optional(),
  defaultBranch: z.string().optional(),
  /** The pipeline's conclusion when it failed (`failure`, `cancelled`, `timed_out`, …). */
  conclusion: z.string().nullable().optional(),
});
export type LinkedPublishData = z.infer<typeof linkedPublishDataSchema>;

/** A live publish whose merge overlapped newer work: the commit is on the conversation's branch, nothing went live. */
const linkedPublishConflictDataSchema = z.looseObject({
  branch: z.string(),
  commit: z.string(),
  conflict: z.literal(true),
  defaultBranch: z.string().optional(),
});

export type LinkedPublishView = {
  /** `not_sent`: nothing reached the repository. Every other kind has a commit there. */
  kind: 'not_sent' | 'building' | 'built' | 'failed' | 'conflict' | 'unknown';
  title: string;
  /** A sentence for the person, never the model's instructions. */
  detail: string;
  /** The spinner shows only while the pipeline is building and still followed. */
  building: boolean;
  /** When a building view stops being followed (epoch ms), so it can be shown again then; null otherwise. */
  followDeadline: number | null;
  previewUrl: string | null;
  detailsUrl: string | null;
};

const webUrlSchema = z.url({ protocol: /^https?$/ });

function webUrl(value: string | null | undefined): string | null {
  return value && webUrlSchema.safeParse(value).success ? value : null;
}

/**
 * How a publish tool's settled output reads to a person, or null when the call has not returned (or isn't a
 * publish). `now` decides whether a `pending` build is still followed.
 */
export function linkedPublishView(invocation: CloudChefToolInvocation, now: number): LinkedPublishView | null {
  if (invocation.toolName !== 'publish' && invocation.toolName !== 'publish_preview') {
    return null;
  }
  const live = invocation.toolName === 'publish';
  if (invocation.state === 'output-error') {
    return notSent(live, invocation.errorText ?? 'The call stopped before anything reached the repository.');
  }
  if (invocation.state !== 'output-available' || !isCloudChefToolResult(invocation.output)) {
    return null;
  }
  const output = invocation.output;
  const conflict = linkedPublishConflictDataSchema.safeParse(output.data).data;
  if (conflict) {
    const target = conflict.defaultBranch ?? 'the default branch';
    return {
      kind: 'conflict',
      title: `Saved on ${conflict.branch}, not merged`,
      detail:
        `${capitalize(target)} changed since this workspace was opened and overlaps these changes, so nothing ` +
        `went live. The work is saved on the branch ${conflict.branch}; an admin can merge it there.`,
      building: false,
      followDeadline: null,
      previewUrl: null,
      detailsUrl: null,
    };
  }
  const data = linkedPublishDataSchema.safeParse(output.data).data;
  if (!data) {
    return output.ok
      ? {
          kind: 'unknown',
          title: live ? 'Published' : 'Sent a preview',
          detail: output.summary,
          building: false,
          followDeadline: null,
          previewUrl: null,
          detailsUrl: null,
        }
      : notSent(live, output.summary);
  }
  const target = data.defaultBranch ?? 'the default branch';
  const committed = data.live ? `Merged into ${target}` : `Committed to ${data.branch}`;
  const links = { previewUrl: webUrl(data.previewUrl), detailsUrl: webUrl(data.detailsUrl) };
  // An output saved before `startedAt` existed can't say whether its build is still followed, so it isn't.
  const followDeadline = data.startedAt === undefined ? null : data.startedAt + LINKED_BUILD_FOLLOW_MS;
  switch (data.build) {
    case 'pending':
      if (followDeadline !== null && now < followDeadline) {
        return {
          kind: 'building',
          title: data.live ? `Merged into ${target}; deploying` : `Building a preview of ${data.branch}`,
          detail:
            "The repository's pipeline is building it, usually in about two minutes. The result " +
            `${data.live ? '' : 'and its preview link '}will show here.`,
          building: true,
          followDeadline,
          ...links,
        };
      }
      return unknown(
        committed,
        "CloudChef stopped following the repository's pipeline. Its result is in Workers Builds.",
        links,
      );
    case 'success':
      return {
        kind: 'built',
        title: data.live ? `Live: merged into ${target}` : `Preview ready on ${data.branch}`,
        detail: data.live
          ? "The repository's pipeline built and deployed it."
          : `The repository's pipeline built ${data.branch}.`,
        building: false,
        followDeadline: null,
        ...links,
      };
    case 'failure':
      return {
        kind: 'failed',
        title: data.live ? `Merged into ${target}; deploy failed` : `Committed to ${data.branch}; build failed`,
        detail:
          `The commit is in the repository, but the repository's pipeline ${failedVerb(data.conclusion)}` +
          `${data.live ? ', so the change is not live yet' : ''}.`,
        building: false,
        followDeadline: null,
        ...links,
      };
    case 'none':
      return unknown(committed, 'The repository reported no pipeline for this commit.', links);
    case 'timed_out':
      return unknown(
        committed,
        "The repository's pipeline was still building after 15 minutes. Its result is in Workers Builds.",
        links,
      );
    case 'unfollowed':
    default:
      return unknown(
        committed,
        "CloudChef could not follow the repository's pipeline. Its result is in Workers Builds.",
        links,
      );
  }
}

/** The conversation's latest publish that reached the repository, for the composer's dock; null before there is one. */
export function latestLinkedPublishView(messages: readonly CloudChefMessage[], now: number): LinkedPublishView | null {
  for (const message of messages.toReversed()) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const part of message.parts.toReversed()) {
      const invocation = getToolInvocation(part);
      const view = invocation ? linkedPublishView(invocation, now) : null;
      if (view && view.kind !== 'not_sent') {
        return view;
      }
    }
  }
  return null;
}

function notSent(live: boolean, detail: string): LinkedPublishView {
  return {
    kind: 'not_sent',
    title: live ? 'Not published' : 'Preview not sent',
    detail,
    building: false,
    followDeadline: null,
    previewUrl: null,
    detailsUrl: null,
  };
}

function unknown(
  title: string,
  detail: string,
  links: { previewUrl: string | null; detailsUrl: string | null },
): LinkedPublishView {
  return { kind: 'unknown', title, detail, building: false, followDeadline: null, ...links };
}

function failedVerb(conclusion: string | null | undefined): string {
  switch (conclusion) {
    case 'cancelled':
      return 'build was cancelled';
    case 'timed_out':
      return 'build timed out';
    case 'action_required':
      return 'build is waiting for an action';
    case 'startup_failure':
      return 'build could not start';
    default:
      return 'build failed';
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
