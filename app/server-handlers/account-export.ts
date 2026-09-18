import { requireRecentlyAuthenticatedSession } from '~/lib/.server/account-reauthentication';
import { exportControlPlaneAccount } from '~/lib/.server/cloudflare/account-export';

export async function exportAccountAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const session = await requireRecentlyAuthenticatedSession(
    env,
    request,
    'Reconnect Cloudflare to confirm it is you, then download your CloudChef account data.',
  );
  if (session instanceof Response) {
    return session;
  }

  const account = await exportControlPlaneAccount({ env, userId: session.user.id });
  console.info({
    event: 'control_plane_account_exported',
    exportedAt: account.exportedAt,
    status: account.status,
    unavailableSections: account.unavailableSections,
  });
  // An export that could not read part of itself is still the user's data and is
  // still returned, but it says so in the document rather than looking whole.
  return Response.json(account, { headers: { 'Cache-Control': 'no-store' } });
}
