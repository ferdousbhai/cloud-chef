import { z } from 'zod';
import { projectSite, ProjectAccessError } from '~/lib/.server/cloudflare/linked-project-client';
import { runtimeConnectionIdentity } from '~/lib/.server/cloudflare/cloudflare-api-runtime-identity';
import { takeScreenshot } from '~/lib/.server/showcase/screenshot';

/** A site's first screen is well under this at the screenshot's quality; D1 holds at most 2 MB in a row. */
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** How long after a change its publish is given to go live before a picture of the site can show it. */
const PUBLISH_SETTLE_MS = 3 * 60_000;
const RETRY_AFTER_MS = 5 * 60_000;

const querySchema = z.object({
  project: z.string().uuid(),
  changedAt: z.coerce.number().int().nonnegative().optional(),
});

/** Whether a picture may no longer show the site: it's old, or from before the project's last change had gone live. */
export function thumbnailIsStale(takenAt: number | null, changedAt: number | undefined, now: number): boolean {
  if (takenAt === null) {
    return true;
  }
  return takenAt < Math.max(now - MAX_AGE_MS, changedAt === undefined ? 0 : changedAt + PUBLISH_SETTLE_MS);
}

/**
 * Takes a new picture of the project's live site. CloudChef says where that is and whether this person may see the
 * project, so the browser can't send this account's Browser Rendering anywhere else, and someone who lost the project
 * loses its picture. One that can't be taken leaves the last in place, to be tried again later.
 */
async function refreshThumbnail(env: Env, projectId: string): Promise<void> {
  const identity = runtimeConnectionIdentity(env);
  if (!identity) {
    return;
  }
  try {
    const site = await projectSite(env, identity, projectId);
    const shot = site.live ? await takeScreenshot(env, site.live) : null;
    if (shot && shot.bytes.byteLength <= MAX_IMAGE_BYTES) {
      await env.DB.prepare('UPDATE project_thumbnails SET image = ?, taken_at = ? WHERE project_id = ?')
        .bind(shot.bytes, Date.now(), projectId)
        .run();
    }
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      await forgetProjectThumbnail(env.DB, projectId);
      return;
    }
    console.warn({
      event: 'project_thumbnail_failed',
      message: error instanceof Error ? error.message : 'not an Error',
    });
  }
}

/** Removes a project's picture, when the project goes from this account. */
export async function forgetProjectThumbnail(db: D1Database, projectId: string): Promise<void> {
  await db.prepare('DELETE FROM project_thumbnails WHERE project_id = ?').bind(projectId).run();
}

/**
 * `GET /v1/projects/thumbnail?project=<id>&changedAt=<ms>`: the picture this runtime has of a project's live site, or
 * 404 until it has one. Answers at once with what it has, and takes a new one afterwards when that's missing or stale.
 */
export async function userRuntimeProjectThumbnailAction(args: {
  url: URL;
  env: Env;
  waitUntil: (work: Promise<unknown>) => void;
}): Promise<Response> {
  const query = querySchema.safeParse(Object.fromEntries(args.url.searchParams));
  if (!query.success) {
    return Response.json({ error: 'Name the project.' }, { status: 400 });
  }
  const { project, changedAt } = query.data;
  const db = args.env.DB;
  const row = await db
    .prepare('SELECT image, taken_at FROM project_thumbnails WHERE project_id = ?')
    .bind(project)
    .first<{ image: ArrayBuffer | number[] | null; taken_at: number | null }>();
  const now = Date.now();
  if (thumbnailIsStale(row?.taken_at ?? null, changedAt, now)) {
    // Only whoever claims the row takes the picture, however many views ask at once.
    const claimed = await db
      .prepare(
        `INSERT INTO project_thumbnails (project_id, requested_at) VALUES (?1, ?2)
         ON CONFLICT (project_id) DO UPDATE SET requested_at = ?2 WHERE requested_at <= ?3
         RETURNING project_id`,
      )
      .bind(project, now, now - RETRY_AFTER_MS)
      .first();
    if (claimed) {
      args.waitUntil(refreshThumbnail(args.env, project));
    }
  }
  if (!row?.image) {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  return new Response(new Uint8Array(row.image), {
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
