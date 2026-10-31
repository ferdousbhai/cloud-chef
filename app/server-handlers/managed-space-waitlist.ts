import { z } from 'zod';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { signedIn } from './signed-in';

/**
 * The waitlist for a space CloudChef runs (`docs/proposals/managed-spaces.md`): anyone signed in may join or leave
 * it, whether or not they have somewhere to build. Kept as one timestamp on their account.
 */
export function managedSpaceWaitlistAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => waitlistResponse(await readJoinedAt(env.DB, session.user.id)));
}

const updateSchema = z.strictObject({ joined: z.boolean() });

/** `POST /api/managed-spaces/waitlist/update`: joins the waitlist (keeping the first time they joined) or leaves it. */
export function updateManagedSpaceWaitlistAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const body = await readJsonRequest(request, updateSchema, 'Choose whether to join the waitlist.');
    if ('response' in body) {
      return body.response;
    }
    const update = body.data.joined
      ? env.DB.prepare(
          'UPDATE "user" SET managed_space_waitlist_at = COALESCE(managed_space_waitlist_at, ?) WHERE id = ?',
        ).bind(Date.now(), session.user.id)
      : env.DB.prepare('UPDATE "user" SET managed_space_waitlist_at = NULL WHERE id = ?').bind(session.user.id);
    await update.run();
    return waitlistResponse(await readJoinedAt(env.DB, session.user.id));
  });
}

async function readJoinedAt(db: D1Database, userId: string): Promise<number | null> {
  const row = await db
    .prepare('SELECT managed_space_waitlist_at AS joined_at FROM "user" WHERE id = ?')
    .bind(userId)
    .first<{ joined_at: number | null }>();
  return row?.joined_at ?? null;
}

function waitlistResponse(joinedAt: number | null): Response {
  return Response.json(
    { joined: joinedAt !== null, joinedAt: joinedAt === null ? null : new Date(joinedAt).toISOString() },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
