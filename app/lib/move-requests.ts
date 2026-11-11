import { z } from 'zod';

/**
 * A request to have a site moved into the person's own Cloudflare account (`/move`): what the form sends, what
 * `/api/move-requests` answers, and the limits both sides keep.
 */
export const MOVE_PLATFORMS = ['shopify', 'wordpress', 'other'] as const;
export type MovePlatform = (typeof MOVE_PLATFORMS)[number];

export const MOVE_SITE_URL_MAX_LENGTH = 300;
export const MOVE_NOTE_MAX_LENGTH = 1000;
/** How many sites one person may have a request open for. */
export const MOVE_REQUEST_LIMIT = 10;

export const moveRequestsSchema = z.object({
  requests: z.array(
    z.object({
      siteUrl: z.string(),
      platform: z.enum(MOVE_PLATFORMS),
      note: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
export type MoveRequest = z.infer<typeof moveRequestsSchema>['requests'][number];

/**
 * The address of a site as it is kept, or null when it isn't one: an http or https address of a named host, without
 * a sign-in in it. An address typed without `https://`, as people type them, is read as https; the part after `#` is
 * dropped, so the same page asked for twice is one request.
 */
export function normalizeMoveSiteUrl(input: string): string | null {
  const typed = input.trim();
  if (!typed || typed.length > MOVE_SITE_URL_MAX_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) {
    return null;
  }
  url.hash = '';
  return url.href.length > MOVE_SITE_URL_MAX_LENGTH ? null : url.href;
}
