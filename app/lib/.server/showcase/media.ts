import {
  forgetMediaDeletions,
  mediaForReview,
  mediaToServe,
  pendingMediaDeletions,
} from '~/lib/cloudflare/data/posts.server';

/**
 * Showcase media in CloudChef's own R2 (`SHOWCASE_MEDIA`): screenshots and short videos of public projects' live
 * sites, the account boundary's one exception (ARCHITECTURE.md). Each object is `posts/<post id>/<media id>.<ext>`,
 * served at `/media/<media id>.<ext>` only while its post is shown, and deleted once its row is gone.
 */

/** What a file is, from its first bytes, never from what the browser said it is. */
export function sniffContentType(
  bytes: Uint8Array,
): 'image/webp' | 'image/png' | 'image/jpeg' | 'video/webm' | 'video/mp4' | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebM is Matroska: its EBML header, then a DocType of "webm" within the first bytes.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return ascii(0, Math.min(bytes.length, 64)).includes('webm') ? 'video/webm' : null;
  }
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') {
    return 'video/mp4';
  }
  return null;
}

/** The R2 key of a post's media item. */
export function mediaKey(postId: string, mediaId: string, contentType: string): string {
  const extension = contentType.split('/')[1] ?? 'bin';
  return `posts/${postId}/${mediaId}.${extension}`;
}

/** The media id in a `/media/<id>.<ext>` path, or null when it isn't one. */
function mediaIdOf(pathname: string): string | null {
  const match = /^\/media\/([0-9a-f-]{36})\.(?:webp|png|jpeg|webm|mp4)$/.exec(pathname);
  return match?.[1] ?? null;
}

/** Serves a media item from R2, with ranges for video. */
async function serveObject(
  env: Env,
  request: Request,
  media: { r2Key: string; contentType: string },
  cacheControl: string,
): Promise<Response> {
  const range = request.headers.get('Range');
  const object = await env.SHOWCASE_MEDIA.get(media.r2Key, range ? { range: request.headers } : undefined);
  if (!object) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers({
    'Content-Type': media.contentType,
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: object.httpEtag,
  });
  if (range && object.range && 'offset' in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

/**
 * `GET /media/<id>.<ext>`: a picture or video of a post anyone may see. Addresses are by media id, so a replaced
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
  return serveObject(env, request, media, 'public, max-age=3600');
}

/** A media item for an operator reviewing reports, whatever its post's status. */
export async function serveMediaForReview(env: Env, request: Request, mediaId: string): Promise<Response> {
  const media = await mediaForReview(env.DB, mediaId);
  return media
    ? serveObject(env, request, media, 'private, no-store')
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
