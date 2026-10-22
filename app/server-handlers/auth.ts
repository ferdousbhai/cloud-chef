import { clearAuthSessionCookie, deleteAuthSession, getAuthSession } from '~/lib/.server/auth';
import { hasSameOrigin } from '~/lib/.server/request-guards';

export async function authSessionAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const session = await getAuthSession(env, request);
  return Response.json(session, { headers: { 'Cache-Control': 'no-store' } });
}

export async function signOutAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  await deleteAuthSession(env, request);
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': clearAuthSessionCookie(request), 'Cache-Control': 'no-store' },
  });
}
