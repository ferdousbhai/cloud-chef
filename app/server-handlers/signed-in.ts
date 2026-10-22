import { getAuthSession, type CloudflareAuthSession } from '~/lib/.server/auth';
import { hasSameOrigin } from '~/lib/.server/request-guards';
import { OrganizationError } from '~/lib/cloudflare/data/organizations.server';

type Handler = (args: { request: Request; env: Env; session: CloudflareAuthSession }) => Promise<Response>;

/** Runs `handler` for a signed-in, same-origin request, turning organization errors into responses. */
export async function signedIn(request: Request, env: Env, handler: Handler): Promise<Response> {
  if (request.method !== 'GET' && !hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }
  return answeringOrganizationErrors(() => handler({ request, env, session }));
}

/** Runs `run`, answering an organization error it throws with that error's message, code, and status. */
export async function answeringOrganizationErrors(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OrganizationError) {
      return Response.json(error.code ? { error: error.message, code: error.code } : { error: error.message }, {
        status: error.status,
      });
    }
    throw error;
  }
}
