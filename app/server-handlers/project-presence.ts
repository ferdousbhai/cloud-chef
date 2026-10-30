import { z } from 'zod';
import { readJsonRequest } from '~/lib/.server/request-guards';
import { findAccessibleProject } from '~/lib/cloudflare/data/org-projects.server';
import { changesSince, leaveProject, listVisitors, recordVisit } from '~/lib/cloudflare/data/project-presence.server';
import { projectIdOfPath } from './projects';
import { signedIn } from './signed-in';

/** The route a browser with a project open reports to. */
export const PROJECT_PRESENCE_ROUTE = '/api/projects/:projectId/presence';

const presenceSchema = z.strictObject({
  /** Whether this person's agent is running a turn, as their browser sees it. */
  working: z.boolean(),
  /** The project is being closed: they're no longer here. */
  leaving: z.literal(true).optional(),
});

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * `POST /api/projects/<id>/presence`: the person has the project open (every 30 seconds while they do), or is closing
 * it (`leaving`). Answers who else has it open now, and, on the first report of a visit, what others changed in it
 * since this person was last here (`changedSince`, null when nothing). Only someone who may view the project reports
 * or sees anyone; anyone else is told there is no such project.
 */
export function projectPresenceAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return signedIn(request, env, async ({ session }) => {
    const projectId = projectIdOfPath(new URL(request.url).pathname) ?? '';
    const parsed = await readJsonRequest(request, presenceSchema, 'Invalid presence report.');
    if ('response' in parsed) {
      return parsed.response;
    }
    const project = await findAccessibleProject(env.DB, projectId, session.user.id);
    if (!project) {
      return Response.json({ error: 'Not found.' }, { status: 404, headers: NO_STORE });
    }
    const userId = session.user.id;
    if (parsed.data.leaving) {
      await leaveProject(env.DB, { projectId: project.id, userId });
      return Response.json({ here: [], changedSince: null }, { headers: NO_STORE });
    }
    const now = Date.now();
    const { previousVisitAt } = await recordVisit(env.DB, {
      projectId: project.id,
      userId,
      working: parsed.data.working,
      now,
    });
    const [visitors, changed] = await Promise.all([
      listVisitors(env.DB, project.id, now),
      previousVisitAt === null ? null : changesSince(env.DB, { projectId: project.id, userId, since: previousVisitAt }),
    ]);
    return Response.json(
      { here: visitors.filter((visitor) => visitor.id !== userId), changedSince: changed },
      { headers: NO_STORE },
    );
  });
}
