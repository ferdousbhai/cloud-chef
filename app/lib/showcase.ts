import type { PostReel } from './reel';

/**
 * Showcase pages and the feed, as the browser and the server both see them: a person's public page, their posts,
 * comments and notifications. Everything here may be shown to anyone who can see the post, signed in or not.
 */

/** A person as their public page shows them. Follower lists are theirs alone; only the counts are public. */
export type PublicPerson = {
  username: string;
  name: string;
  image: string | null;
  bio: string | null;
  followers: number;
  following: number;
  posts: number;
};

/** Who made a post, a comment, or something a notification is about. */
type ShowcaseAuthor = { username: string | null; name: string; image: string | null };

/** A post as anyone sees it: one public project, its live site, and a screenshot of it. */
export type PostView = {
  id: string;
  projectId: string;
  /** The project's name. */
  title: string;
  /** Its page, `/<owner>/<slug>`: the project's own address on CloudChef. */
  path: string;
  caption: string | null;
  siteUrl: string;
  author: { username: string; name: string; image: string | null };
  /** The live site as it looked at its last publish; null until the first screenshot is taken. */
  screenshot: { url: string; width: number; height: number } | null;
  /** A short clip of the app being used, which its author approved in the chat (app/lib/reel.ts); null for none. */
  reel: PostReel | null;
  /** Published again since it was first posted. */
  updated: boolean;
  shownAt: number;
  likeCount: number;
  commentCount: number;
  copyCount: number;
};

/** Where the next page of posts starts. */
export type ShowcaseCursor = { shownAt: number; id: string };

export type PostComment = {
  id: string;
  body: string;
  createdAt: number;
  author: ShowcaseAuthor;
};

export type NotificationView = {
  id: string;
  kind: 'new_follower' | 'project_copied' | 'post_liked' | 'post_commented' | 'post_removed' | 'comment_removed';
  actor: ShowcaseAuthor | null;
  /** For grouped likes: how many others liked it that day. */
  others: number;
  projectName: string | null;
  postPath: string | null;
  /** A comment's first words, or the reason something was taken down. */
  detail: string | null;
  createdAt: number;
  unread: boolean;
};

export const REPORT_REASONS = [
  'scam_or_phishing',
  'sexual',
  'violent_or_hateful',
  'copied_without_permission',
  'spam',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** How each reason reads in the report dialog. */
export const REPORT_REASON_LABELS = {
  scam_or_phishing: 'It’s a scam or asks for passwords or money',
  sexual: 'Sexual content',
  violent_or_hateful: 'Violent or hateful',
  copied_without_permission: 'It copies someone’s work without permission',
  spam: 'Spam',
  other: 'Something else',
} satisfies Record<ReportReason, string>;

export const CAPTION_MAX = 2000;
export const BIO_MAX = 300;
export const COMMENT_MAX = 1000;

/** "3 likes", "1 like". */
export function countLabel(count: number, one: string, many = `${one}s`): string {
  return `${new Intl.NumberFormat('en').format(count)} ${count === 1 ? one : many}`;
}

/** "just now", "5m", "3h", "2d", or a date: how long ago, as a feed says it. */
export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  return new Date(at).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
