import { useEffect, useState } from 'react';
import { z } from 'zod';
import { getJson, postJson } from '~/lib/json-request';
import type { NotificationView, PostComment, PostView, ReportReason, ShowcaseCursor } from '~/lib/showcase';

/** The browser's side of the showcase routes (app/server-handlers/showcase.ts). */

/**
 * A record from CloudChef's own showcase routes, told apart by its `key` field. The routes make these records
 * themselves (app/lib/cloudflare/data/posts.server.ts), so their other fields are taken as they come.
 */
function recordWith(key: string) {
  return z.looseObject({ [key]: z.string() });
}

const refusalSchema = z.object({ error: z.string() });

const viewerSchema = z.union([
  z.object({ signedIn: z.literal(false) }),
  z.object({
    signedIn: z.literal(true),
    me: z.object({
      username: z.string().nullable(),
      name: z.string(),
      image: z.string().nullable(),
      hasSpace: z.boolean(),
    }),
    liked: z.array(z.string()),
    managed: z.array(z.string()),
    following: z.boolean().nullable(),
    unread: z.number(),
  }),
]);

export type Viewer = z.infer<typeof viewerSchema>;

/**
 * What the person looking sees differently on a public page: null while it loads (the page shows as a visitor sees
 * it meanwhile), then whether they're signed in, which posts they liked and manage, and whether they follow the
 * page's person. `refresh` reads it again, after signing in elsewhere or a change.
 */
export function useViewer(postIds: readonly string[], person?: string) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${postIds.join(',')}|${person ?? ''}`;
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ posts: key.split('|')[0]! });
    if (person) {
      query.set('person', person);
    }
    getJson(`/api/showcase/viewer?${query}`, viewerSchema, undefined, controller.signal)
      .then(setViewer)
      .catch(() => {
        if (!controller.signal.aborted) {
          setViewer({ signedIn: false });
        }
      });
    return () => controller.abort();
  }, [key, person, attempt]);
  return { viewer, refresh: () => setAttempt((count) => count + 1) };
}

const postsPageSchema = z.object({
  posts: z.array(z.custom<PostView>((value) => recordWith('id').safeParse(value).success)),
  next: z.object({ shownAt: z.number(), id: z.string() }).nullable(),
});

function cursorQuery(cursor: ShowcaseCursor | null): string {
  return cursor ? `before=${cursor.shownAt}&beforeId=${encodeURIComponent(cursor.id)}` : '';
}

export function loadFeedPage(cursor: ShowcaseCursor | null, signal?: AbortSignal) {
  return getJson(`/api/showcase/feed?${cursorQuery(cursor)}`, postsPageSchema, undefined, signal);
}

export function loadExplorePage(cursor: ShowcaseCursor | null) {
  return getJson(`/api/showcase/explore?${cursorQuery(cursor)}`, postsPageSchema);
}

export function loadPersonPage(username: string, cursor: ShowcaseCursor | null) {
  return getJson(
    `/api/showcase/person?username=${encodeURIComponent(username)}&${cursorQuery(cursor)}`,
    postsPageSchema,
  );
}

export async function setFollowing(username: string, follow: boolean) {
  return postJson(
    '/api/showcase/follow',
    { username, follow },
    z.object({ following: z.boolean(), followers: z.number() }),
  );
}

export async function setLiked(postId: string, like: boolean) {
  return postJson('/api/showcase/like', { postId, like }, z.object({ liked: z.boolean(), likeCount: z.number() }));
}

const commentSchema = z.custom<PostComment>((value) => recordWith('id').safeParse(value).success);

export function loadComments(postId: string, after = 0, signal?: AbortSignal) {
  return getJson(
    `/api/showcase/comments?postId=${encodeURIComponent(postId)}&after=${after}`,
    z.object({ comments: z.array(commentSchema), more: z.boolean() }),
    undefined,
    signal,
  );
}

export async function addComment(postId: string, body: string): Promise<PostComment> {
  return (await postJson('/api/showcase/comments/add', { postId, body }, z.object({ comment: commentSchema }))).comment;
}

export async function deleteComment(commentId: string): Promise<void> {
  await postJson('/api/showcase/comments/delete', { commentId }, z.unknown());
}

export async function reportPost(args: {
  postId: string;
  commentId: string | null;
  reason: ReportReason;
  note: string;
}): Promise<void> {
  await postJson('/api/showcase/report', args, z.unknown(), 'The report could not be sent. Try again.');
}

export async function setCaption(postId: string, caption: string): Promise<string | null> {
  return (
    await postJson('/api/showcase/posts/caption', { postId, caption }, z.object({ caption: z.string().nullable() }))
  ).caption;
}

export async function setPostShown(postId: string, shown: boolean): Promise<void> {
  await postJson('/api/showcase/posts/shown', { postId, shown }, z.unknown());
}

export async function deletePost(postId: string): Promise<void> {
  await postJson('/api/showcase/posts/delete', { postId }, z.unknown());
}

export async function removeVideo(postId: string): Promise<void> {
  await postJson('/api/showcase/posts/video/remove', { postId }, z.unknown());
}

/** Uploads a post's video and its poster frame, reporting progress from 0 to 1. */
export function uploadVideo(
  args: { postId: string; video: Blob; poster: Blob | null; durationMs: number; width: number; height: number },
  onProgress: (fraction: number) => void,
): Promise<void> {
  const form = new FormData();
  form.set('postId', args.postId);
  form.set('durationMs', String(Math.round(args.durationMs)));
  form.set('width', String(args.width));
  form.set('height', String(args.height));
  form.set('video', args.video, args.video.type === 'video/mp4' ? 'video.mp4' : 'video.webm');
  if (args.poster) {
    form.set('poster', args.poster, 'poster.webp');
  }
  // XMLHttpRequest, for upload progress, which fetch doesn't report.
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/showcase/posts/video');
    request.withCredentials = true;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
        return;
      }
      let message = 'The video could not be uploaded. Try again.';
      try {
        message = refusalSchema.safeParse(JSON.parse(request.responseText)).data?.error ?? message;
      } catch {
        // Not CloudChef's answer (a proxy's error page): the generic words stand.
      }
      reject(new Error(message));
    };
    request.onerror = () => reject(new Error('The video could not be uploaded. Check your connection and try again.'));
    request.send(form);
  });
}

export async function setBio(bio: string): Promise<string | null> {
  return (await postJson('/api/showcase/profile', { bio }, z.object({ bio: z.string().nullable() }))).bio;
}

const notificationSchema = z.custom<NotificationView>((value) => recordWith('kind').safeParse(value).success);

export async function loadNotifications(signal?: AbortSignal): Promise<NotificationView[]> {
  return (
    await getJson(
      '/api/showcase/notifications',
      z.object({ notifications: z.array(notificationSchema) }),
      undefined,
      signal,
    )
  ).notifications;
}

export async function markNotificationsRead(): Promise<void> {
  await postJson('/api/showcase/notifications/read', {}, z.unknown());
}

/** The unread count for the avatar's dot, read when the header mounts. */
export function useUnreadNotifications(signedIn: boolean): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    const controller = new AbortController();
    getJson('/api/showcase/viewer?posts=', viewerSchema, undefined, controller.signal)
      .then((viewer) => setUnread(viewer.signedIn ? viewer.unread : 0))
      .catch(() => undefined);
    return () => controller.abort();
  }, [signedIn]);
  return unread;
}

const managedPostSchema = z.custom<PostView & { status: string; hiddenReason: string | null; projectPublic: boolean }>(
  (value) => recordWith('status').safeParse(value).success,
);

export async function loadHiddenPosts(signal?: AbortSignal) {
  return (
    await getJson('/api/showcase/posts/hidden', z.object({ posts: z.array(managedPostSchema) }), undefined, signal)
  ).posts;
}

export async function waitForCopy(projectId: string, name: string): Promise<void> {
  await postJson('/api/showcase/copies/wait', { projectId, name }, z.unknown());
}

export async function loadWaitingCopies(signal?: AbortSignal) {
  return (
    await getJson(
      '/api/showcase/copies',
      z.object({ copies: z.array(z.object({ projectId: z.string(), name: z.string(), sourceName: z.string() })) }),
      undefined,
      signal,
    )
  ).copies;
}

export async function makeWaitingCopy(projectId: string) {
  return postJson('/api/showcase/copies/make', { projectId }, z.object({ initialId: z.string() }));
}

export async function forgetWaitingCopy(projectId: string): Promise<void> {
  await postJson('/api/showcase/copies/forget', { projectId }, z.unknown());
}
