import { clearAuthSessionCookie, deleteAuthSession, getAuthSession } from '~/lib/.server/auth';

export async function authSessionAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const session = await getAuthSession(env, request);
  return Response.json(session, { headers: { 'Cache-Control': 'no-store' } });
}

export async function signOutAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  await deleteAuthSession(env, request);
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': clearAuthSessionCookie(request), 'Cache-Control': 'no-store' },
  });
}
