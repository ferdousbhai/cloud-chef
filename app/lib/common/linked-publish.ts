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

/** Where a build's result can still be found when CloudChef can't say it: the account's Cloudflare dashboard. */
/** Said for a team's project and a person's own alike: whoever runs the Cloudflare account can look. */
const ADMIN_CAN_SEE = "The result is in the Cloudflare dashboard of the project's account.";

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
    return notSent(live, invocation.errorText ?? 'It stopped before anything was sent.');
  }
  if (invocation.state !== 'output-available' || !isCloudChefToolResult(invocation.output)) {
    return null;
  }
  const output = invocation.output;
  const conflict = linkedPublishConflictDataSchema.safeParse(output.data).data;
  if (conflict) {
    return {
      kind: 'conflict',
      title: 'Not published',
      detail:
        'Someone else changed the same part of the live project after you started, so your change was not put ' +
        "live. The live site keeps their change. Yours is saved, but CloudChef can't combine the two yet, so " +
        "publishing again, from this chat or a new one, won't work.",
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
          title: live ? 'Published' : 'Preview requested',
          detail: output.summary,
          building: false,
          followDeadline: null,
          previewUrl: null,
          detailsUrl: null,
        }
      : notSent(live, output.summary);
  }
  const committed = data.live ? 'Sent to go live' : 'Sent for a preview';
  const links = { previewUrl: webUrl(data.previewUrl), detailsUrl: webUrl(data.detailsUrl) };
  // An output saved before `startedAt` existed can't say whether its build is still followed, so it isn't.
  const followDeadline = data.startedAt === undefined ? null : data.startedAt + LINKED_BUILD_FOLLOW_MS;
  switch (data.build) {
    case 'pending':
      if (followDeadline !== null && now < followDeadline) {
        return {
          kind: 'building',
          title: data.live ? 'Publishing…' : 'Making a preview…',
          detail: data.live
            ? 'Cloudflare is building the site with your change and will put it live, usually in about two minutes.'
            : 'Cloudflare is building a copy of the site with your change, usually in about two minutes. Its link will show here.',
          building: true,
          followDeadline,
          ...links,
        };
      }
      return unknown(
        committed,
        `Your change is saved. CloudChef stopped checking on the build, so it can't say whether it worked. ${ADMIN_CAN_SEE}`,
        links,
      );
    case 'success':
      return {
        kind: 'built',
        title: data.live ? 'Published' : 'Preview ready',
        detail: data.live
          ? 'Your change is live.'
          : links.previewUrl
            ? "Open the preview to check the change. The live site hasn't changed."
            : "The preview was built, but Cloudflare didn't give a link for it. It's in the Cloudflare dashboard of " +
              "the project's account. The live site hasn't changed.",
        building: false,
        followDeadline: null,
        ...links,
      };
    case 'failure':
      return {
        kind: 'failed',
        title: data.live ? 'Publishing failed' : 'Preview failed',
        detail: data.live
          ? "The build stopped with an error, so your change isn't live. It's saved, and the site still shows the last version."
          : "The preview's build stopped with an error. Your change is saved, and the live site hasn't changed.",
        building: false,
        followDeadline: null,
        ...links,
      };
    case 'none':
      return unknown(
        committed,
        'Your change is saved, but Cloudflare reported no build for it. Workers Builds, the Cloudflare service that ' +
          'builds and publishes this project, may have skipped it, or may not be set up for this project yet. ' +
          "Whoever runs the project's Cloudflare account can check in its dashboard.",
        links,
      );
    case 'timed_out':
      return unknown(
        committed,
        `Your change is saved. The build was still running after 15 minutes, so CloudChef stopped checking. ${ADMIN_CAN_SEE}`,
        links,
      );
    case 'unfollowed':
    default:
      return unknown(
        committed,
        `Your change is saved, but CloudChef couldn't check on the build. ${ADMIN_CAN_SEE}`,
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
    title: live ? 'Not published' : 'Preview not made',
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
