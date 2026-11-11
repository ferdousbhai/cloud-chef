import { z } from 'zod';
import { readJsonRequest } from '~/lib/.server/request-guards';
import {
  MOVE_NOTE_MAX_LENGTH,
  MOVE_PLATFORMS,
  MOVE_REQUEST_LIMIT,
  MOVE_SITE_URL_MAX_LENGTH,
  normalizeMoveSiteUrl,
  type MovePlatform,
} from '~/lib/move-requests';
import { signedIn } from './signed-in';

/**
 * Requests to have a site moved (`/move`, `docs/proposals/move-in.md`): anyone signed in may ask for a site they run
 * elsewhere to be moved into their own Cloudflare account, see what they asked for, and withdraw it. The move itself
 * is done with them by CloudChef's maintainer, who reads the requests with `pnpm run ops`.
 */
export function moveRequestsAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => requestsResponse(env.DB, session.user.id));
}

const saveSchema = z.strictObject({
  siteUrl: z.string().max(MOVE_SITE_URL_MAX_LENGTH),
  platform: z.enum(MOVE_PLATFORMS),
  note: z.string().max(MOVE_NOTE_MAX_LENGTH).optional(),
});

/**
 * `POST /api/move-requests/save`: asks for a site to be moved. One request per person and address: asking again for
 * the same address changes its platform and note, and keeps when it was first asked for.
 */
export function saveMoveRequestAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, saveSchema, 'Enter your site’s address and choose what it runs on.');
    if ('response' in body) {
      return body.response;
    }
    const siteUrl = normalizeMoveSiteUrl(body.data.siteUrl);
    if (!siteUrl) {
      return Response.json(
        { error: 'Enter your site’s address as it appears in a browser, such as https://example.com.' },
        { status: 400 },
      );
    }
    const others = await env.DB.prepare(
      'SELECT COUNT(*) AS requests FROM move_requests WHERE user_id = ? AND site_url <> ?',
    )
      .bind(session.user.id, siteUrl)
      .first<{ requests: number }>();
    if ((others?.requests ?? 0) >= MOVE_REQUEST_LIMIT) {
      return Response.json(
        { error: `You can ask for up to ${MOVE_REQUEST_LIMIT} sites at a time. Withdraw one first.` },
        { status: 400 },
      );
    }
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO move_requests (user_id, site_url, platform, note, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT (user_id, site_url) DO UPDATE SET
         platform = excluded.platform, note = excluded.note, updated_at = excluded.updated_at`,
    )
      .bind(session.user.id, siteUrl, body.data.platform, body.data.note?.trim() || null, now)
      .run();
    return requestsResponse(env.DB, session.user.id);
  });
}

const withdrawSchema = z.strictObject({ siteUrl: z.string().max(MOVE_SITE_URL_MAX_LENGTH) });

/** `POST /api/move-requests/withdraw`: withdraws the caller's request for one address, deleting it. */
export function withdrawMoveRequestAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, withdrawSchema, 'Choose the request to withdraw.');
    if ('response' in body) {
      return body.response;
    }
    await env.DB.prepare('DELETE FROM move_requests WHERE user_id = ? AND site_url = ?')
      .bind(session.user.id, body.data.siteUrl)
      .run();
    return requestsResponse(env.DB, session.user.id);
  });
}

/** The caller's own requests, newest first, as `moveRequestsSchema` reads them. */
async function requestsResponse(db: D1Database, userId: string): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT site_url, platform, note, created_at, updated_at FROM move_requests
       WHERE user_id = ? ORDER BY created_at DESC, site_url`,
    )
    .bind(userId)
    .all<{ site_url: string; platform: MovePlatform; note: string | null; created_at: number; updated_at: number }>();
  return Response.json(
    {
      requests: results.map((row) => ({
        siteUrl: row.site_url,
        platform: row.platform,
        note: row.note,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
