import {
  forgetMediaDeletions,
  mediaForReview,
  mediaToServe,
  pendingMediaDeletions,
} from '~/lib/cloudflare/data/posts.server';

/**
 * Showcase media in CloudChef's own R2 (`SHOWCASE_MEDIA`): screenshots of public projects' live sites, and the clips
 * their authors approved (a timeline, its pictures and spoken lines, app/lib/reel.ts), the account boundary's one
 * exception (ARCHITECTURE.md). Each object is `posts/<post id>/<media id>.<ext>`, served at `/media/<media id>.<ext>`
 * only while its post is shown, and deleted once its row is gone.
 */

/** The R2 key of a post's media item. */
export function mediaKey(postId: string, mediaId: string, contentType: string): string {
  const extension = contentType.split('/')[1] ?? 'bin';
  return `posts/${postId}/${mediaId}.${extension}`;
}

/** The media id in a `/media/<id>.<ext>` path, or null when it isn't one. */
function mediaIdOf(pathname: string): string | null {
  const match = /^\/media\/([0-9a-f-]{36})\.(?:webp|png|jpeg|json|mpeg)$/.exec(pathname);
  return match?.[1] ?? null;
}

/**
 * Serves a media item from R2, as the type its row records and nothing a browser could sniff into another. A byte
 * range is answered as one (Safari asks for a clip's sound that way before it plays it).
 */
async function serveObject(
  env: Env,
  media: { r2Key: string; contentType: string },
  cacheControl: string,
  requestHeaders?: Headers,
): Promise<Response> {
  const ranged = requestHeaders?.has('Range') === true;
  const object = await env.SHOWCASE_MEDIA.get(media.r2Key, ranged ? { range: requestHeaders } : undefined);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers({
    'Content-Type': media.contentType,
    'Cache-Control': cacheControl,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    ETag: object.httpEtag,
  });
  const range = ranged ? byteRange(object) : null;
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

/** The bytes R2 answered a ranged read with, or null when it answered the whole object. */
function byteRange(object: R2ObjectBody): { offset: number; length: number } | null {
  const range = object.range;
  if (!range) {
    return null;
  }
  if ('suffix' in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, object.size);
    return { offset: object.size - length, length };
  }
  const offset = 'offset' in range && range.offset !== undefined ? range.offset : 0;
  const length = 'length' in range && range.length !== undefined ? range.length : object.size - offset;
  return offset === 0 && length === object.size ? null : { offset, length };
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
  return serveObject(env, media, 'public, max-age=3600', request.headers);
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
