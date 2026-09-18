import { z } from 'zod';
import { clearAuthSessionCookie } from '~/lib/.server/auth';
import { requireRecentlyAuthenticatedSession } from '~/lib/.server/account-reauthentication';
import { eraseControlPlaneAccount } from '~/lib/.server/cloudflare/account-deletion';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';

const MAX_ACCOUNT_DELETION_BYTES = 1024;
const accountDeletionSchema = z
  .object({
    confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION),
    acknowledgeCloudflareResourcesRetained: z.literal(true),
  })
  .strict();

export async function deleteAccountAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const session = await requireRecentlyAuthenticatedSession(
    env,
    request,
    'Reconnect Cloudflare to confirm it is you, then delete your CloudChef account data.',
  );
  if (session instanceof Response) {
    return session;
  }
  const confirmation = accountDeletionSchema.safeParse(
    await readJsonBodyWithLimit(request, MAX_ACCOUNT_DELETION_BYTES, 'Account deletion request').catch(() => null),
  );
  if (!confirmation.success) {
    return Response.json(
      { error: 'Confirm the exact phrase and the retained-resources acknowledgement.' },
      { status: 400 },
    );
  }

  const erasure = await eraseControlPlaneAccount({ env, userId: session.user.id });
  console.info({
    event: 'control_plane_account_erased',
    erasedAt: new Date().toISOString(),
    cloudflareAuthorizationRevoked: erasure.cloudflareAuthorizationRevoked,
  });
  return Response.json(
    { status: 'deleted', cloudflareAuthorizationRevoked: erasure.cloudflareAuthorizationRevoked },
    { headers: { 'Set-Cookie': clearAuthSessionCookie(request), 'Cache-Control': 'no-store' } },
  );
}
