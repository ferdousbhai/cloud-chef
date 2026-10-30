import {
  forgetMediaDeletions,
  mediaForReview,
  mediaToServe,
  pendingMediaDeletions,
} from '~/lib/cloudflare/data/posts.server';

/**
 * Showcase media in CloudChef's own R2 (`SHOWCASE_MEDIA`): screenshots of public projects' live sites,
 * the account boundary's one exception (ARCHITECTURE.md). Each object is `posts/<post id>/<media id>.<ext>`,
 * served at `/media/<media id>.<ext>` only while its post is shown, and deleted once its row is gone.
 */

/** The R2 key of a post's media item. */
export function mediaKey(postId: string, mediaId: string, contentType: string): string {
  const extension = contentType.split('/')[1] ?? 'bin';
  return `posts/${postId}/${mediaId}.${extension}`;
}

/** The media id in a `/media/<id>.<ext>` path, or null when it isn't one. */
function mediaIdOf(pathname: string): string | null {
  const match = /^\/media\/([0-9a-f-]{36})\.(?:webp|png|jpeg)$/.exec(pathname);
  return match?.[1] ?? null;
}

/** Serves a media item from R2. */
async function serveObject(
  env: Env,
  media: { r2Key: string; contentType: string },
  cacheControl: string,
): Promise<Response> {
  const object = await env.SHOWCASE_MEDIA.get(media.r2Key);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': media.contentType,
      'Content-Length': String(object.size),
      'Cache-Control': cacheControl,
      'Cross-Origin-Resource-Policy': 'same-origin',
      ETag: object.httpEtag,
    },
  });
}

/**
 * `GET /media/<id>.<ext>`: a picture of a post anyone may see. Addresses are by media id, so a replaced
 * screenshot is a new address; an hour's caching keeps a taken-down item from lingering long in browsers.
 */
export async function serveMediaAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const mediaId = mediaIdOf(new URL(request.url).pathname);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const media = mediaId ? await mediaToServe(env.DB, mediaId) : null;
  if (!media) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return serveObject(env, media, 'public, max-age=3600');
}

/** A media item for an operator reviewing reports, whatever its post's status. */
export async function serveMediaForReview(env: Env, mediaId: string): Promise<Response> {
  const media = await mediaForReview(env.DB, mediaId);
  return media
    ? serveObject(env, media, 'private, no-store')
    : new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Deletes the R2 objects of media rows that are gone, however they went (a post deleted, its project deleted or made
 * private, an account erased): `post_media_deletions` holds their keys. Runs with the scheduled maintenance, and
 * after a deletion so its objects go at once.
 */
async function deleteGoneMedia(env: Env): Promise<number> {
  const keys = await pendingMediaDeletions(env.DB);
  if (keys.length === 0) {
    return 0;
  }
  await env.SHOWCASE_MEDIA.delete(keys);
  await forgetMediaDeletions(env.DB, keys);
  return keys.length;
}

export async function deleteGoneMediaBestEffort(env: Env): Promise<void> {
  await deleteGoneMedia(env).catch((error) => {
    console.error('[Showcase] Unable to delete gone media', error instanceof Error ? error.message : 'not an Error');
  });
}
